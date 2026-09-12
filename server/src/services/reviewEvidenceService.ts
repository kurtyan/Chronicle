import { createHash } from 'crypto'
import { getDb } from '../db'
import { htmlToPlainText } from './searchText'
import { getWorkStatistics } from './workStatisticsService'
import type { ReviewEvidence, ReviewEvidenceSource, ReviewScope } from '../../../shared/projectReviewTypes'

export function evidenceFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Rebase content hashes after an explicit attachment-location restore; model output/coverage is not hashed as source evidence. */
export function refreshReviewEvidenceFingerprint(evidence: ReviewEvidence): ReviewEvidence {
  const sources = evidence.sources.map(source => {
    const { fingerprint: _fingerprint, ...content } = source
    return { ...content, fingerprint: evidenceFingerprint(content) }
  })
  return {
    ...evidence, sources,
    fingerprint: evidenceFingerprint({ scope: evidence.scope, start: evidence.window.start, end: evidence.window.end, target: evidence.target, metrics: evidence.metrics, sources }),
  }
}

export function validateReviewScope(input: ReviewScope): ReviewScope {
  if (!input || !['area', 'milestone'].includes(input.targetType) || typeof input.targetId !== 'string' || !input.targetId.trim()) throw new Error('Invalid review target')
  for (const value of [input.periodStart, input.periodEnd]) {
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid review period')
  }
  if (input.periodStart != null && input.periodEnd != null && input.periodStart >= input.periodEnd) throw new Error('Review period start must precede end')
  return { targetType: input.targetType, targetId: input.targetId, periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null }
}

export function getReviewTarget(scope: ReviewScope): Record<string, any> {
  validateReviewScope(scope)
  const row = getDb().prepare(`SELECT * FROM ${scope.targetType === 'area' ? 'areas' : 'milestones'} WHERE id = ?`).get(scope.targetId) as Record<string, any> | undefined
  if (!row) throw new Error(`${scope.targetType === 'area' ? 'Area' : 'Milestone'} not found`)
  return row
}

/** Capture full source contents before any model budget is applied; historical records are never a recent-N cache. */
export function buildReviewEvidence(input: ReviewScope, options: { asOf?: number; excludeNoteIds?: string[] } = {}): ReviewEvidence {
  const scope = validateReviewScope(input)
  const target = getReviewTarget(scope)
  const asOf = options.asOf ?? Date.now()
  if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('Invalid review asOf')
  const start = scope.periodStart ?? 0
  const end = Math.min(scope.periodEnd ?? asOf, asOf)
  if (start >= end) throw new Error('Review period has no elapsed time')
  const db = getDb()
  const milestones = scope.targetType === 'milestone' ? [target] : db.prepare('SELECT * FROM milestones WHERE area_id = ? ORDER BY id').all(scope.targetId) as any[]
  const milestoneIds = new Set(milestones.map(item => item.id))
  const allTasks = db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as any[]
  const primaryTasks = allTasks.filter(task => milestoneIds.has(task.primary_milestone_id))
  const taskIds = new Set(primaryTasks.map(task => task.id))
  const references = db.prepare('SELECT * FROM project_references ORDER BY created_at, id').all() as any[]
  const relevantRefs = references.filter(ref => (scope.targetType === 'area' && ref.area_id === scope.targetId) || milestoneIds.has(ref.milestone_id))
  const referencedTaskIds = new Set(relevantRefs.filter(ref => ref.task_id).map(ref => ref.task_id))
  const notesById = new Map<string, ReviewEvidenceSource['role']>()
  const ranks: Record<string, number> = { reference: 0, growth: 1, outcome: 2, review: 3 }
  for (const ref of relevantRefs) {
    if (!ref.note_id || options.excludeNoteIds?.includes(ref.note_id)) continue
    const role = ref.role === 'related' ? 'reference' : ref.role
    if (!notesById.has(ref.note_id) || ranks[role] > ranks[notesById.get(ref.note_id)!]) notesById.set(ref.note_id, role)
  }
  const sources: ReviewEvidenceSource[] = []
  const add = (source: Omit<ReviewEvidenceSource, 'fingerprint'>) => sources.push({ ...source, fingerprint: evidenceFingerprint(source) })
  add({ id: `${scope.targetType}:${target.id}`, kind: 'target', entityId: target.id, title: target.name, content: JSON.stringify(target), createdAt: target.created_at, updatedAt: target.updated_at, revision: target.revision, role: 'background' })
  if (scope.targetType === 'area') for (const milestone of milestones) {
    add({ id: `milestone:${milestone.id}`, kind: 'target', entityId: milestone.id, title: milestone.name, content: JSON.stringify(milestone), createdAt: milestone.created_at, updatedAt: milestone.updated_at, revision: milestone.revision, role: 'background' })
  }
  for (const task of allTasks) {
    if (!taskIds.has(task.id) && !referencedTaskIds.has(task.id)) continue
    add({ id: `task:${task.id}`, kind: 'task', entityId: task.id, taskId: task.id, title: task.title, content: JSON.stringify({ id: task.id, title: task.title, currentStatus: task.status, primaryMilestoneId: task.primary_milestone_id, createdAt: task.created_at, updatedAt: task.updated_at, completedAt: task.completed_at, stateMeaning: 'Current state at capture, not a historical state transition' }), createdAt: task.created_at, updatedAt: task.updated_at, revision: task.project_revision ?? null, role: taskIds.has(task.id) ? 'primary' : 'reference' })
  }
  const entries = db.prepare('SELECT * FROM task_entries ORDER BY created_at, id').all() as any[]
  for (const entry of entries) {
    if (!taskIds.has(entry.task_id) && !referencedTaskIds.has(entry.task_id)) continue
    if (entry.created_at > asOf || (scope.periodEnd != null && entry.created_at >= scope.periodEnd) || (entry.type === 'log' && entry.created_at < start)) continue
    add({ id: `entry:${entry.id}`, kind: 'task_entry', entityId: entry.id, taskId: entry.task_id, title: `${entry.task_id} · ${entry.type}`, content: htmlToPlainText(entry.content), contentHtml: entry.content, createdAt: entry.created_at, updatedAt: null, revision: null, role: !taskIds.has(entry.task_id) ? 'reference' : entry.created_at < start ? 'background' : 'primary' })
  }
  const missing: string[] = []
  for (const [id, role] of notesById) {
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as any
    if (!note) { missing.push(id); continue }
    add({ id: `note:${note.id}`, kind: 'note', entityId: note.id, title: note.title, content: htmlToPlainText(note.content_html), contentHtml: note.content_html, createdAt: note.created_at, updatedAt: note.updated_at, revision: note.revision, role })
  }
  const events = db.prepare('SELECT * FROM project_events WHERE created_at >= ? AND created_at <= ? AND (? IS NULL OR created_at < ?) ORDER BY created_at, id').all(start, asOf, scope.periodEnd, scope.periodEnd) as any[]
  for (const event of events) {
    if (!((event.target_type === scope.targetType && event.target_id === scope.targetId) || (event.target_type === 'milestone' && milestoneIds.has(event.target_id)))) continue
    // These database fields already contain JSON. Preserve their structure in the
    // evidence text so a factual quote does not require nested escape sequences.
    const snapshot = (value: string | null) => { try { return value === null ? null : JSON.parse(value) } catch { return value } }
    const eventContent = { ...event, before_json: snapshot(event.before_json), after_json: snapshot(event.after_json) }
    add({ id: `event:${event.id}`, kind: 'event', entityId: event.id, title: event.kind, content: JSON.stringify(eventContent), createdAt: event.created_at, updatedAt: event.undone_at ?? null, revision: null, role: 'primary' })
  }
  const allStatistics = getWorkStatistics({ start, end, asOf })
  const sessions = allStatistics.sessions.filter(session => scope.targetType === 'area' ? session.areaId === scope.targetId : session.milestoneId === scope.targetId)
  const totalMs = sessions.reduce((sum, session) => sum + session.durationMs, 0)
  const metrics = {
    recordedMs: totalMs,
    currentTaskCount: primaryTasks.length,
    currentDoneTaskCount: primaryTasks.filter(task => task.status === 'DONE').length,
    currentDroppedTaskCount: primaryTasks.filter(task => task.status === 'DROPPED').length,
    sessionCount: sessions.length,
    sessions,
    anomalies: allStatistics.anomalies.filter(anomaly => sessions.some(session => session.id === anomaly.sessionId)),
    attribution: 'Current primary milestone assignment; related references contribute no additional work time',
    statusMeaning: 'Task counts reflect current state, not completions within the selected period',
  }
  const warnings = ['Task and Note content reflects the version captured at asOf; timestamps alone do not reconstruct historical revisions.', 'Missing or deleted unlinked records cannot be inferred. Personal contributions and feelings require user confirmation.']
  if (missing.length) warnings.push(`Referenced notes missing at capture: ${missing.join(', ')}`)
  const totalCharacters = sources.reduce((sum, source) => sum + source.content.length, 0)
  const pack: ReviewEvidence = {
    version: 1, fingerprint: '', scope, window: { start, end, asOf, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    target: { ...target, ...(scope.targetType === 'milestone' ? { area: db.prepare('SELECT * FROM areas WHERE id = ?').get(target.area_id) ?? null } : {}) },
    metrics, sources,
    coverage: { totalSources: sources.length, totalCharacters, includedSources: sources.length, includedCharacters: totalCharacters, complete: missing.length === 0, warnings },
  }
  pack.fingerprint = evidenceFingerprint({ scope, start, end, target: pack.target, metrics, sources })
  return pack
}

/** An accepted/generated review Note is output, not a new input to its own earlier analysis. */
export function getInsightOutputNoteIds(draftId: string, evidence: ReviewEvidence): string[] {
  const draft = getDb().prepare('SELECT accepted_note_id FROM project_insight_drafts WHERE id = ?').get(draftId) as { accepted_note_id: string | null } | undefined
  const reviews = getDb().prepare('SELECT note_id FROM project_reviews WHERE insight_draft_id = ?').all(draftId) as Array<{ note_id: string }>
  const originalNotes = new Set(evidence.sources.filter(source => source.kind === 'note').map(source => source.entityId))
  return [...new Set([draft?.accepted_note_id, ...reviews.map(review => review.note_id)].filter((id): id is string => Boolean(id) && !originalNotes.has(id!)))]
}

export function isReviewEvidenceStale(evidence: ReviewEvidence, options: { excludeNoteIds?: string[] } = {}): { stale: boolean; reason: string | null } {
  try {
    const current = buildReviewEvidence(evidence.scope, { asOf: evidence.window.asOf, excludeNoteIds: options.excludeNoteIds })
    const stale = current.fingerprint !== evidence.fingerprint
    return { stale, reason: stale ? 'Source content, attribution, target, or recorded time changed after this evidence snapshot' : null }
  } catch {
    return { stale: true, reason: 'The original target or source scope is no longer available' }
  }
}
