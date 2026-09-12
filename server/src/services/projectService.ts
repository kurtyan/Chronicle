import { createHash, randomUUID } from 'crypto'
import { getDb } from '../db'
import { getBacklinks } from './projectReferenceService'
import { getWorkStatistics } from './workStatisticsService'
import { broadcastEvent } from './eventBus'
import type { Area, AreaDetail, ApplyAreaInsightSummaryInput, AssignmentPreview, AssignmentPreviewInput, AssignmentResult, CreateAreaInput, CreateMilestoneInput, Milestone, MilestoneDetail, MilestoneOverview, ProjectEvent, ProjectListOptions, ProjectOverview, UpdateAreaInput, UpdateMilestoneInput, WorkStatisticsRange } from '../../../shared/projectTypes'

export class ProjectError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_PROJECT_INPUT') { super(message) }
}
function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new ProjectError(`${field} must contain 1–500 characters`)
  return value.trim()
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 100000) throw new ProjectError(`${field} must be text of at most 100000 characters`)
  return value
}
function checkRevision(current: number, expected: number): void {
  if (!Number.isInteger(expected) || expected !== current) throw new ProjectError('Object changed; reload before saving', 409, 'PROJECT_REVISION_CONFLICT')
}
function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}
function requireArea(id: string): Area {
  const area = getArea(id)
  if (!area) throw new ProjectError('Area not found', 404, 'AREA_NOT_FOUND')
  return area
}
function requireMilestone(id: string): Milestone {
  const milestone = getMilestone(id)
  if (!milestone) throw new ProjectError('Milestone not found', 404, 'MILESTONE_NOT_FOUND')
  return milestone
}
function rowToArea(row: any): Area {
  return { id: row.id, name: row.name, description: row.description, focus: row.focus, status: row.status,
    latestProgress: row.latest_progress, nextStep: row.next_step, summaryUpdatedAt: row.summary_updated_at,
    summarySource: row.summary_source, summarySourceNoteId: row.summary_source_note_id,
    summarySourceInsightId: row.summary_source_insight_id, summarySourceNoteRevision: row.summary_source_note_revision,
    archived: Boolean(row.archived), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
}
function rowToMilestone(row: any): Milestone {
  return { id: row.id, areaId: row.area_id, name: row.name, kind: row.kind, goal: row.goal, completionCriteria: row.completion_criteria,
    status: row.status, priority: row.priority, startDate: row.start_date, targetDate: row.target_date, archived: Boolean(row.archived), revision: row.revision,
    latestProgress: row.latest_progress, nextStep: row.next_step, blockers: row.blockers, completedAt: row.completed_at,
    completionEventId: row.completion_event_id, createdAt: row.created_at, updatedAt: row.updated_at }
}
function recordEvent(targetType: string, targetId: string, kind: string, before: unknown, after: unknown, id = randomUUID()): string {
  getDb().prepare('INSERT INTO project_events(id,target_type,target_id,kind,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, targetType, targetId, kind, JSON.stringify(before ?? null), JSON.stringify(after ?? null), Date.now())
  queueMicrotask(() => {
    try {
      if (getDb().prepare('SELECT id FROM project_events WHERE id=?').get(id)) broadcastEvent('projects_changed', { targetType, targetId, eventId: id })
    } catch { /* Suppress invalidation if the containing transaction rolled back or DB closed. */ }
  })
  return id
}
export function getProjectEvents(targetType: string, targetId: string): ProjectEvent[] {
  // A task move belongs to both its former and new milestone's history. Match
  // the persisted states, not current membership or the batch's comma-joined ID.
  // Keep the original event so undo still checks and restores the whole batch.
  const rows = targetType === 'milestone'
    ? getDb().prepare(`SELECT * FROM project_events AS event
        WHERE (target_type='milestone' AND target_id=?)
          OR (target_type='task_assignment' AND kind IN ('assignment','assignment_undone') AND (
            EXISTS (SELECT 1 FROM json_each(event.before_json) AS state WHERE json_extract(state.value,'$.primary_milestone_id')=?)
            OR EXISTS (SELECT 1 FROM json_each(event.after_json) AS state WHERE json_extract(state.value,'$.primary_milestone_id')=?)
          )) ORDER BY created_at DESC,rowid DESC`).all(targetId, targetId, targetId)
    : getDb().prepare('SELECT * FROM project_events WHERE target_type=? AND target_id=? ORDER BY created_at DESC,rowid DESC').all(targetType, targetId)
  return (rows as any[])
    .map(e => ({ id: e.id, targetType: e.target_type, targetId: e.target_id, kind: e.kind, before: JSON.parse(e.before_json ?? 'null'), after: JSON.parse(e.after_json ?? 'null'), createdAt: e.created_at, undoneAt: e.undone_at }))
}
function list(table: 'areas' | 'milestones', options: ProjectListOptions): any[] {
  const conditions: string[] = [], params: any[] = []
  if (!options.includeArchived) conditions.push('archived=0')
  if (options.query) {
    conditions.push(table === 'milestones' ? '(instr(lower(name),lower(?))>0 OR area_id IN (SELECT id FROM areas WHERE instr(lower(name),lower(?))>0))' : 'instr(lower(name),lower(?))>0')
    params.push(options.query)
    if (table === 'milestones') params.push(options.query)
  }
  if (options.status) { conditions.push('status=?'); params.push(options.status) }
  if (table === 'milestones' && options.areaId) { conditions.push('area_id=?'); params.push(options.areaId) }
  const limit = options.limit === undefined ? 10000 : Math.min(Math.max(Math.floor(options.limit), 1), 10000)
  const offset = Math.max(Math.floor(options.offset ?? 0), 0)
  if (![limit, offset].every(Number.isFinite)) throw new ProjectError('Invalid pagination')
  return getDb().prepare(`SELECT * FROM ${table} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset)
}
export function listAreas(options: ProjectListOptions = {}): Area[] { return list('areas', options).map(rowToArea) }
export function listMilestones(options: ProjectListOptions = {}): Milestone[] { return list('milestones', options).map(rowToMilestone) }
export function getArea(id: string): Area | null { const row = getDb().prepare('SELECT * FROM areas WHERE id=?').get(id); return row ? rowToArea(row) : null }
export function getMilestone(id: string): Milestone | null { const row = getDb().prepare('SELECT * FROM milestones WHERE id=?').get(id); return row ? rowToMilestone(row) : null }
export function createArea(input: CreateAreaInput): Area {
  const name = nonempty(input.name, 'Name'), description = text(input.description ?? '', 'Description'), focus = text(input.focus ?? '', 'Focus')
  const latestProgress = text(input.latestProgress ?? '', 'Latest progress'), nextStep = text(input.nextStep ?? '', 'Next step')
  const status = input.status ?? 'active'
  if (!['active', 'paused', 'ended'].includes(status)) throw new ProjectError('Invalid area status')
  return getDb().transaction(() => {
    const id = `A${randomUUID()}`, now = Date.now()
    const hasSummary = Boolean(latestProgress || nextStep)
    getDb().prepare('INSERT INTO areas(id,name,description,focus,status,latest_progress,next_step,summary_updated_at,summary_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, description, focus, status, latestProgress, nextStep, hasSummary ? now : null, hasSummary ? 'manual' : null, now, now)
    const area = requireArea(id); recordEvent('area', id, 'created', null, area); return area
  })()
}
export function updateArea(id: string, input: UpdateAreaInput): Area {
  return getDb().transaction(() => {
    const before = requireArea(id); checkRevision(before.revision, input.expectedRevision)
    const next = { ...before, ...defined(input), name: input.name === undefined ? before.name : nonempty(input.name, 'Name'), revision: before.revision + 1, updatedAt: Date.now() }
    text(next.description, 'Description'); text(next.focus, 'Focus')
    text(next.latestProgress, 'Latest progress'); text(next.nextStep, 'Next step')
    const summaryChanged = next.latestProgress !== before.latestProgress || next.nextStep !== before.nextStep
    if (!['active', 'paused', 'ended'].includes(next.status) || typeof next.archived !== 'boolean') throw new ProjectError('Invalid area state')
    getDb().prepare('UPDATE areas SET name=?,description=?,focus=?,status=?,archived=?,revision=?,latest_progress=?,next_step=?,summary_updated_at=?,summary_source=?,summary_source_note_id=?,summary_source_insight_id=?,summary_source_note_revision=?,updated_at=? WHERE id=?')
      .run(next.name, next.description, next.focus, next.status, Number(next.archived), next.revision, next.latestProgress, next.nextStep,
        summaryChanged ? next.updatedAt : before.summaryUpdatedAt, summaryChanged ? 'manual' : before.summarySource,
        summaryChanged ? null : before.summarySourceNoteId, summaryChanged ? null : before.summarySourceInsightId,
        summaryChanged ? null : before.summarySourceNoteRevision, next.updatedAt, id)
    const after = requireArea(id); recordEvent('area', id, 'updated', before, after); return after
  })()
}
export function applyAreaInsightSummary(id: string, input: ApplyAreaInsightSummaryInput): Area {
  return getDb().transaction(() => {
    const before = requireArea(id); checkRevision(before.revision, input.expectedRevision)
    const latestProgress = text(input.latestProgress, 'Latest progress'), nextStep = text(input.nextStep, 'Next step')
    if (typeof input.insightDraftId !== 'string' || !input.insightDraftId.trim()) throw new ProjectError('insightDraftId is required')
    const draft = getDb().prepare('SELECT target_type,target_id,status,accepted_note_id FROM project_insight_drafts WHERE id=?').get(input.insightDraftId) as any
    if (!draft || draft.target_type !== 'area' || draft.target_id !== id) throw new ProjectError('Insight does not match this Area')
    if (draft.status !== 'success' || !draft.accepted_note_id) throw new ProjectError('Accept the successful insight as a Note before applying its summary', 409, 'INSIGHT_NOT_ACCEPTED')
    const note = getDb().prepare('SELECT revision FROM notes WHERE id=?').get(draft.accepted_note_id) as { revision: number } | undefined
    if (!note) throw new ProjectError('Accepted Note was deleted', 409, 'INSIGHT_ACCEPTED_NOTE_DELETED')
    if (!Number.isInteger(input.expectedNoteRevision) || input.expectedNoteRevision !== note.revision) throw new ProjectError('Note changed; review it before applying the summary', 409, 'NOTE_REVISION_CONFLICT')
    const now = Date.now()
    getDb().prepare("UPDATE areas SET latest_progress=?,next_step=?,summary_updated_at=?,summary_source='insight',summary_source_note_id=?,summary_source_insight_id=?,summary_source_note_revision=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(latestProgress, nextStep, now, draft.accepted_note_id, input.insightDraftId, note.revision, now, id)
    const after = requireArea(id); recordEvent('area', id, 'summary_applied', before, after); return after
  })()
}
function validateMilestone(input: CreateMilestoneInput): void {
  nonempty(input.name, 'Name'); text(input.goal ?? '', 'Goal'); text(input.completionCriteria ?? '', 'Completion criteria')
  for (const field of ['latestProgress', 'nextStep', 'blockers'] as const) text(input[field] ?? '', field)
  const kind = input.kind === undefined ? 'stage' : input.kind, status = input.status === undefined ? 'planned' : input.status
  if (!['stage', 'ongoing'].includes(kind)) throw new ProjectError('Invalid milestone kind')
  if (!(kind === 'stage' ? ['planned', 'active', 'paused', 'completed', 'cancelled'] : ['planned', 'active', 'paused', 'ended']).includes(status)) throw new ProjectError('Status is incompatible with milestone kind')
  if (input.targetDate != null && (!Number.isFinite(input.targetDate) || input.targetDate < 0)) throw new ProjectError('Invalid target date')
  if (input.startDate != null && (!Number.isFinite(input.startDate) || input.startDate < 0)) throw new ProjectError('Invalid start date')
  if (input.startDate != null && input.targetDate != null && input.startDate > input.targetDate) throw new ProjectError('Start date must not be after target date')
  if (input.priority != null && (typeof input.priority !== 'string' || input.priority.length > 100)) throw new ProjectError('Invalid priority')
}
export function validatePrimaryMilestone(id: string | null | undefined): void {
  if (id == null) return
  if (typeof id !== 'string') throw new ProjectError('Invalid primary milestone')
  const milestone = requireMilestone(id), area = requireArea(milestone.areaId)
  if (milestone.archived || area.archived) throw new ProjectError('Restore the archived milestone or area before assigning work')
}
export function createMilestone(input: CreateMilestoneInput): Milestone {
  validateMilestone(input)
  if (input.status === 'completed') throw new ProjectError('Create the milestone before confirming completion')
  return getDb().transaction(() => {
    if (requireArea(input.areaId).archived) throw new ProjectError('Restore the area before creating milestones')
    const id = `M${randomUUID()}`, now = Date.now()
    getDb().prepare(`INSERT INTO milestones(id,area_id,name,kind,goal,completion_criteria,status,priority,start_date,target_date,latest_progress,next_step,blockers,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.areaId, input.name.trim(), input.kind ?? 'stage', input.goal ?? '', input.completionCriteria ?? '', input.status ?? 'planned', input.priority ?? null, input.startDate ?? null, input.targetDate ?? null, input.latestProgress ?? '', input.nextStep ?? '', input.blockers ?? '', now, now)
    const eventId = randomUUID()
    if (input.status === 'cancelled') getDb().prepare('UPDATE milestones SET completion_event_id=? WHERE id=?').run(eventId, id)
    const milestone = requireMilestone(id); recordEvent('milestone', id, 'created', null, milestone, eventId); return milestone
  })()
}
export function updateMilestone(id: string, input: UpdateMilestoneInput): Milestone {
  return getDb().transaction(() => {
    let before = requireMilestone(id); checkRevision(before.revision, input.expectedRevision)
    let assignmentEventId: string | null = null
    if (input.areaId !== undefined && input.areaId !== before.areaId) {
      if (!input.assignmentToken) throw new ProjectError('Preview the historical impact before moving a milestone', 409, 'ASSIGNMENT_PREVIEW_REQUIRED')
      const preview = loadPreview(input.assignmentToken)
      if (preview.input.milestoneId !== id || preview.input.areaId !== input.areaId) throw new ProjectError('Preview does not match this change', 409, 'ASSIGNMENT_PREVIEW_MISMATCH')
      assignmentEventId = applyAssignment(input.assignmentToken).eventId; before = requireMilestone(id)
      if (Object.keys(defined(input)).every(key => ['areaId', 'expectedRevision', 'assignmentToken'].includes(key))) return before
    }
    const next = { ...before, ...defined(input), revision: before.revision + 1, updatedAt: Date.now() }
    validateMilestone(next)
    if (typeof next.archived !== 'boolean') throw new ProjectError('Invalid archive state')
    if (next.kind !== before.kind && input.confirmKindChange !== true) throw new ProjectError('Confirm the milestone kind change', 409, 'MILESTONE_KIND_CONFIRMATION_REQUIRED')
    const completing = next.status === 'completed' && before.status !== 'completed'
    const cancelling = next.status === 'cancelled' && before.status !== 'cancelled'
    if (completing && input.confirmCompletion !== true) throw new ProjectError('Confirm the milestone outcome to complete it', 409, 'MILESTONE_COMPLETION_CONFIRMATION_REQUIRED')
    const eventId = randomUUID()
    next.completedAt = completing ? Date.now() : next.status === 'completed' ? before.completedAt : null
    next.completionEventId = completing || cancelling ? eventId : ['completed', 'cancelled'].includes(next.status) ? before.completionEventId : null
    getDb().prepare(`UPDATE milestones SET name=?,kind=?,goal=?,completion_criteria=?,status=?,priority=?,start_date=?,target_date=?,archived=?,revision=?,latest_progress=?,next_step=?,blockers=?,completed_at=?,completion_event_id=?,updated_at=? WHERE id=?`)
      .run(next.name.trim(), next.kind, next.goal, next.completionCriteria, next.status, next.priority, next.startDate, next.targetDate, Number(next.archived), next.revision, next.latestProgress, next.nextStep, next.blockers, next.completedAt, next.completionEventId, next.updatedAt, id)
    const after = requireMilestone(id)
    if (assignmentEventId) {
      const saved = JSON.parse((getDb().prepare('SELECT after_json FROM project_events WHERE id=?').get(assignmentEventId) as any).after_json)
      getDb().prepare('UPDATE project_events SET after_json=? WHERE id=?').run(JSON.stringify({ ...after, assignmentTasks: saved.assignmentTasks }), assignmentEventId)
    }
    recordEvent('milestone', id, completing ? 'completed' : cancelling ? 'cancelled' : ['completed', 'cancelled'].includes(before.status) && !['completed', 'cancelled'].includes(next.status) ? 'reopened' : 'updated', before, after, eventId); return after
  })()
}

type TaskAssignmentState = { id: string; primary_milestone_id: string | null; project_revision: number }
function taskState(id: string): TaskAssignmentState {
  const row = getDb().prepare('SELECT id,primary_milestone_id,project_revision FROM tasks WHERE id=?').get(id) as TaskAssignmentState | undefined
  if (!row) throw new ProjectError('Task not found', 404, 'TASK_NOT_FOUND')
  return row
}
function assignmentContext(input: AssignmentPreviewInput): { signature: string; taskIds: string[]; beforeState: unknown } {
  const milestoneIds = new Set<string>(), areaIds = new Set<string>()
  let taskIds: string[], beforeState: unknown
  if (input.changes !== undefined) {
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 500 || input.milestoneId !== undefined) throw new ProjectError('Provide 1–500 task assignment changes')
    if (input.changes.some(change => !change || typeof change !== 'object' || typeof change.taskId !== 'string')) throw new ProjectError('Each assignment requires a task ID')
    taskIds = input.changes.map(c => c.taskId)
    if (new Set(taskIds).size !== taskIds.length) throw new ProjectError('Duplicate task assignment')
    beforeState = input.changes.map(change => {
      if (change.primaryMilestoneId !== null && typeof change.primaryMilestoneId !== 'string') throw new ProjectError('Assignment target must be a milestone ID or null')
      const task = taskState(change.taskId); checkRevision(task.project_revision, change.expectedRevision)
      if (change.primaryMilestoneId !== task.primary_milestone_id) validatePrimaryMilestone(change.primaryMilestoneId)
      if (change.primaryMilestoneId) milestoneIds.add(change.primaryMilestoneId)
      if (task.primary_milestone_id) milestoneIds.add(task.primary_milestone_id)
      return task
    })
  } else {
    if (!input.milestoneId || !input.areaId) throw new ProjectError('Provide a milestone and its new area')
    const milestone = requireMilestone(input.milestoneId); checkRevision(milestone.revision, input.expectedRevision!)
    const area = requireArea(input.areaId)
    if (area.archived && area.id !== milestone.areaId) throw new ProjectError('Restore the destination area first')
    milestoneIds.add(milestone.id); areaIds.add(area.id); beforeState = milestone
    taskIds = (getDb().prepare('SELECT id FROM tasks WHERE primary_milestone_id=? ORDER BY id').all(milestone.id) as any[]).map(t => t.id)
  }
  const milestones = [...milestoneIds].sort().map(id => { const m = requireMilestone(id); areaIds.add(m.areaId); return m })
  const areas = [...areaIds].sort().map(requireArea)
  const tasks = [...taskIds].sort().map(taskState)
  const sessions = taskIds.length ? getDb().prepare(`SELECT id,task_id,started_at,ended_at FROM work_sessions WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id`).all(...taskIds) : []
  return { signature: createHash('sha256').update(JSON.stringify({ input, tasks, milestones, areas, sessions })).digest('hex'), taskIds, beforeState }
}
function assignmentOverrides(input: AssignmentPreviewInput) {
  return input.changes ? { tasks: new Map(input.changes.map(c => [c.taskId, c.primaryMilestoneId])) } : { milestones: new Map([[input.milestoneId!, input.areaId!]]) }
}
export function previewAssignment(input: AssignmentPreviewInput): AssignmentPreview {
  return getDb().transaction(() => {
    const asOf = input.asOf ?? Date.now()
    if (!Number.isFinite(asOf) || asOf < 0 || asOf > Date.now() + 1000) throw new ProjectError('Invalid preview cutoff')
    const normalized = { ...input, asOf }, context = assignmentContext(normalized)
    const before = getWorkStatistics({ asOf }), after = getWorkStatistics({ asOf }, assignmentOverrides(input))
    const sessions = before.sessions.filter(s => context.taskIds.includes(s.taskId))
    const preview: AssignmentPreview = { token: randomUUID(), kind: input.changes ? 'tasks' : 'milestone', asOf,
      affectedTaskIds: context.taskIds, before, after,
      historicalStart: sessions.length ? Math.min(...sessions.map(s => s.startedAt)) : null,
      historicalEnd: sessions.length ? Math.max(...sessions.map(s => s.clippedEnd)) : null }
    getDb().prepare('INSERT INTO project_assignment_previews(token,input_json,signature,preview_json,created_at) VALUES(?,?,?,?,?)')
      .run(preview.token, JSON.stringify(normalized), context.signature, JSON.stringify(preview), Date.now())
    // Preview tokens are transient UI state, not audit records.
    getDb().prepare('DELETE FROM project_assignment_previews WHERE created_at<?').run(Date.now() - 7 * 86400000)
    return preview
  })()
}
function loadPreview(token: string): { input: AssignmentPreviewInput; signature: string; preview: AssignmentPreview } {
  if (typeof token !== 'string') throw new ProjectError('Assignment preview is required', 409, 'ASSIGNMENT_PREVIEW_REQUIRED')
  const row = getDb().prepare('SELECT * FROM project_assignment_previews WHERE token=?').get(token) as any
  if (!row || row.applied_at) throw new ProjectError('Preview expired or already applied; preview again', 409, 'ASSIGNMENT_PREVIEW_STALE')
  return { input: JSON.parse(row.input_json), signature: row.signature, preview: JSON.parse(row.preview_json) }
}
export function applyAssignment(token: string): AssignmentResult {
  return getDb().transaction(() => {
    const stored = loadPreview(token), context = assignmentContext(stored.input)
    if (context.signature !== stored.signature) throw new ProjectError('Assignment or recorded sessions changed; preview again', 409, 'ASSIGNMENT_PREVIEW_STALE')
    let afterState: unknown, targetType: string, targetId: string
    if (stored.input.changes) {
      for (const change of stored.input.changes) getDb().prepare('UPDATE tasks SET primary_milestone_id=?,project_revision=project_revision+1,updated_at=? WHERE id=?').run(change.primaryMilestoneId, Date.now(), change.taskId)
      afterState = stored.input.changes.map(c => taskState(c.taskId)); targetType = 'task_assignment'; targetId = context.taskIds.join(',')
    } else {
      targetType = 'milestone'; targetId = stored.input.milestoneId!
      getDb().prepare('UPDATE milestones SET area_id=?,revision=revision+1,updated_at=? WHERE id=?').run(stored.input.areaId, Date.now(), targetId)
      afterState = { ...requireMilestone(targetId), assignmentTasks: context.taskIds.map(taskState).sort((a, b) => a.id.localeCompare(b.id)) }
    }
    const eventId = recordEvent(targetType, targetId, 'assignment', context.beforeState, afterState)
    getDb().prepare('UPDATE project_assignment_previews SET applied_at=? WHERE token=?').run(Date.now(), token)
    const statistics = getWorkStatistics()
    const total = (stats: typeof statistics) => stats.sessions.filter(s => context.taskIds.includes(s.taskId)).reduce((sum, s) => sum + s.durationMs, 0)
    return { eventId, affectedTaskIds: context.taskIds, additionalRecordedMs: Math.max(0, total(statistics) - total(stored.preview.before)), statistics }
  })()
}
/** Used by the legacy Task PATCH path so it cannot bypass the same preview transaction. */
export function applyTaskAssignment(taskId: string, primaryMilestoneId: string | null, expectedRevision: number | undefined, token: string | undefined): void {
  checkRevision(taskState(taskId).project_revision, expectedRevision!)
  if (taskState(taskId).primary_milestone_id === primaryMilestoneId) return
  const stored = loadPreview(token!)
  if (stored.input.changes?.length !== 1 || stored.input.changes[0].taskId !== taskId || stored.input.changes[0].primaryMilestoneId !== primaryMilestoneId) throw new ProjectError('Preview does not match this task change', 409, 'ASSIGNMENT_PREVIEW_MISMATCH')
  applyAssignment(token!)
}
export function undoAssignment(eventId: string): AssignmentResult {
  return getDb().transaction(() => {
    const event = getDb().prepare("SELECT * FROM project_events WHERE id=? AND kind='assignment'").get(eventId) as any
    if (!event || event.undone_at) throw new ProjectError('Assignment cannot be undone', 409, 'ASSIGNMENT_UNDO_CONFLICT')
    const before = JSON.parse(event.before_json), after = JSON.parse(event.after_json)
    let taskIds: string[]
    if (event.target_type === 'task_assignment') {
      for (const expected of after as TaskAssignmentState[]) {
        const current = taskState(expected.id)
        if (current.primary_milestone_id !== expected.primary_milestone_id || current.project_revision !== expected.project_revision) throw new ProjectError('Task relationships changed after this assignment', 409, 'ASSIGNMENT_UNDO_CONFLICT')
      }
      for (const old of before as TaskAssignmentState[]) getDb().prepare('UPDATE tasks SET primary_milestone_id=?,project_revision=project_revision+1,updated_at=? WHERE id=?').run(old.primary_milestone_id, Date.now(), old.id)
      taskIds = before.map((t: TaskAssignmentState) => t.id)
    } else {
      const current = requireMilestone(event.target_id)
      if (current.revision !== after.revision || current.areaId !== after.areaId) throw new ProjectError('Milestone changed after this assignment', 409, 'ASSIGNMENT_UNDO_CONFLICT')
      const currentTasks = (getDb().prepare('SELECT id,primary_milestone_id,project_revision FROM tasks WHERE primary_milestone_id=? ORDER BY id').all(current.id) as TaskAssignmentState[])
      if (!Array.isArray(after.assignmentTasks) || JSON.stringify(currentTasks) !== JSON.stringify(after.assignmentTasks)) throw new ProjectError('Milestone task relationships changed after this assignment', 409, 'ASSIGNMENT_UNDO_CONFLICT')
      getDb().prepare('UPDATE milestones SET area_id=?,revision=revision+1,updated_at=? WHERE id=?').run(before.areaId, Date.now(), current.id)
      taskIds = currentTasks.map(t => t.id)
    }
    getDb().prepare('UPDATE project_events SET undone_at=? WHERE id=?').run(Date.now(), eventId)
    const undoId = recordEvent(event.target_type, event.target_id, 'assignment_undone', after, before)
    return { eventId: undoId, affectedTaskIds: taskIds, additionalRecordedMs: 0, statistics: getWorkStatistics() }
  })()
}

function overviewMilestones(milestones: Milestone[], range: WorkStatisticsRange): MilestoneOverview[] {
  const statistics = getWorkStatistics(range), lifetime = getWorkStatistics({ asOf: statistics.asOf })
  const areaNames = new Map(listAreas({ includeArchived: true }).map(a => [a.id, a.name]))
  const counts = new Map((getDb().prepare(`SELECT primary_milestone_id AS id,COUNT(*) AS total,SUM(status='DONE') AS done,SUM(status NOT IN ('DONE','DROPPED')) AS open FROM tasks WHERE primary_milestone_id IS NOT NULL GROUP BY primary_milestone_id`).all() as any[]).map(t => [t.id, t]))
  return milestones.map(m => {
    const count = counts.get(m.id)
    // Reviews own the confirmation lifecycle; the role on a Note is deliberately not consulted.
    const hasReviewTable = getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_reviews'").get()
    const stageTerminal = m.kind === 'stage' && ['completed', 'cancelled'].includes(m.status)
    let lastReviewedAt: number | null = null, reviewStatus: MilestoneOverview['reviewStatus'] = stageTerminal ? 'pending' : 'none'
    if (hasReviewTable) {
      const columns = (getDb().prepare('PRAGMA table_info(project_reviews)').all() as any[]).map(c => c.name)
      if (['target_type', 'target_id', 'confirmed_at', 'completion_event_id'].every(c => columns.includes(c))) {
        const scope = stageTerminal ? 'AND completion_event_id=?' : "AND kind='periodic'"
        const row = getDb().prepare(`SELECT MAX(confirmed_at) AS latest FROM project_reviews WHERE target_type='milestone' AND target_id=? AND status='confirmed' ${scope}`).get(...(stageTerminal ? [m.id, m.completionEventId] : [m.id])) as any
        lastReviewedAt = row?.latest ?? null
        if (lastReviewedAt && (stageTerminal || m.kind === 'ongoing')) reviewStatus = 'confirmed'
      }
    }
    return { ...m, areaName: areaNames.get(m.areaId) ?? '', periodMs: statistics.byMilestone.find(g => g.id === m.id)?.totalMs ?? 0,
      totalMs: lifetime.byMilestone.find(g => g.id === m.id)?.totalMs ?? 0,
      taskCount: count?.total ?? 0, doneTaskCount: count?.done ?? 0, openTaskCount: count?.open ?? 0, reviewStatus, lastReviewedAt }
  })
}
export function getProjectOverview(range: WorkStatisticsRange = {}, filters: ProjectListOptions = {}): ProjectOverview {
  const statistics = getWorkStatistics(range)
  return { areas: listAreas({ includeArchived: filters.includeArchived }), milestones: overviewMilestones(listMilestones(filters), { ...range, asOf: statistics.asOf }), statistics,
    totalMilestoneCount: (getDb().prepare('SELECT COUNT(*) AS count FROM milestones').get() as any).count }
}
export function getMilestoneDetail(id: string, range: WorkStatisticsRange = {}): MilestoneDetail {
  const milestone = requireMilestone(id), statistics = getWorkStatistics(range)
  const tasks = (getDb().prepare('SELECT id,title,status,primary_milestone_id,project_revision FROM tasks WHERE primary_milestone_id=? ORDER BY updated_at DESC,id').all(id) as any[])
    .map(t => ({ id: t.id, title: t.title, status: t.status, primaryMilestoneId: t.primary_milestone_id, projectRevision: t.project_revision }))
  return { ...overviewMilestones([milestone], { ...range, asOf: statistics.asOf })[0], tasks, backlinks: getBacklinks('milestone', id), statistics, events: getProjectEvents('milestone', id) }
}
export function getAreaDetail(id: string, range: WorkStatisticsRange = {}): AreaDetail {
  const area = requireArea(id), statistics = getWorkStatistics(range)
  return { ...area, milestones: overviewMilestones(listMilestones({ areaId: id, includeArchived: true }), { ...range, asOf: statistics.asOf }), backlinks: getBacklinks('area', id), statistics, events: getProjectEvents('area', id) }
}
