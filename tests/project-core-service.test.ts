import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { closeDb, getDb, initDb } from '../server/src/db'
import { createTask, createTaskEntry, deleteTask, getTaskById, updateTask } from '../server/src/services/taskService'
import { archiveNote, createNote, deleteNote, getNoteById, getNotes, linkNoteToTask, linkNoteToTaskEntry, searchNotes } from '../server/src/services/noteService'
import { applyAssignment, createArea, createMilestone, getArea, getAreaDetail, getMilestone, getMilestoneDetail, getProjectEvents, getProjectOverview, listAreas, listMilestones, previewAssignment, undoAssignment, updateArea, updateMilestone } from '../server/src/services/projectService'
import { addProjectReference, getBacklinks, getReferences, setReferences } from '../server/src/services/projectReferenceService'
import { getWorkStatistics } from '../server/src/services/workStatisticsService'
import { confirmProjectReview, createProjectReview } from '../server/src/services/projectReviewService'

const requireServer = createRequire(path.resolve('server/package.json'))
const Database = requireServer('better-sqlite3')
test.describe.configure({ mode: 'serial' })
let dir: string
let original: Record<string, string | undefined>
const envKeys = ['CHRONICLE_DB_PATH', 'CHRONICLE_CONFIG_DIR', 'CHRONICLE_CONFIG_PATH', 'CHRONICLE_LOG_DIR', 'CHRONICLE_LOG_PATH']
test.beforeEach(() => {
  original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-core-'))
  process.env.CHRONICLE_DB_PATH = path.join(dir, 'test.db')
  process.env.CHRONICLE_CONFIG_DIR = dir
  process.env.CHRONICLE_CONFIG_PATH = path.join(dir, 'config.json')
  process.env.CHRONICLE_LOG_DIR = dir
  process.env.CHRONICLE_LOG_PATH = path.join(dir, 'test.log')
  initDb()
})
test.afterEach(() => {
  closeDb()
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})
const newTask = (title: string, primaryMilestoneId?: string | null) => createTask({ title, type: 'TODO', priority: 'MEDIUM', primaryMilestoneId })
function setup() {
  const a = createArea({ name: 'Engineering' }), b = createArea({ name: 'Growth' })
  const m = createMilestone({ areaId: a.id, name: 'Delivery', completionCriteria: 'Outcome accepted' })
  const n = createMilestone({ areaId: b.id, name: 'Practice', kind: 'ongoing' })
  return { a, b, m, n }
}
function session(taskId: string, start: number, end: number | null, id = `S${Math.random()}`) {
  getDb().prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(id, taskId, start, end)
  return id
}

test('upgrade an old database preserves data, makes one backup, and restarts idempotently', () => {
  closeDb(); fs.rmSync(process.env.CHRONICLE_DB_PATH!, { force: true })
  const old = new Database(process.env.CHRONICLE_DB_PATH!)
  old.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,priority TEXT NOT NULL,tags TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER,due_date INTEGER);
    INSERT INTO tasks VALUES('T0000000001','legacy','TODO','MEDIUM','[]','PENDING',1,2,NULL,NULL,NULL);`)
  old.close(); initDb()
  expect(getTaskById('T0000000001')).toMatchObject({ title: 'legacy', primaryMilestoneId: null, projectRevision: 1 })
  expect(fs.readdirSync(dir).filter(file => file.includes('.before-projects-'))).toHaveLength(1)
  const { a, m } = setup(); const t = newTask('assigned', m.id)
  closeDb(); initDb()
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(m.id)
  expect(getArea(a.id)?.name).toBe('Engineering')
  expect(fs.readdirSync(dir).filter(file => file.includes('.before-projects-'))).toHaveLength(1)
  expect(getDb().pragma('foreign_key_check')).toEqual([])
})

test('lifecycle stays manual and ongoing milestones cannot complete', () => {
  const { a, m, n } = setup()
  const t = newTask('work', m.id); updateTask(t.id, { status: 'DONE' })
  expect(getMilestone(m.id)?.status).toBe('planned')
  expect(() => updateMilestone(m.id, { expectedRevision: 1, status: 'completed' })).toThrow(/Confirm/)
  const completed = updateMilestone(m.id, { expectedRevision: 1, status: 'completed', confirmCompletion: true })
  expect(completed.completionEventId).toBeTruthy()
  expect(getMilestoneDetail(m.id).reviewStatus).toBe('pending')
  updateTask(t.id, { status: 'PENDING' })
  expect(getMilestone(m.id)?.status).toBe('completed')
  const reopened = updateMilestone(m.id, { expectedRevision: completed.revision, status: 'active' })
  expect(reopened.completionEventId).toBeNull()
  const again = updateMilestone(m.id, { expectedRevision: reopened.revision, status: 'completed', confirmCompletion: true })
  expect(again.completionEventId).not.toBe(completed.completionEventId)
  expect(() => updateMilestone(n.id, { expectedRevision: 1, status: 'completed', confirmCompletion: true })).toThrow(/incompatible/)
  updateArea(a.id, { expectedRevision: 1, archived: true, status: 'ended' })
  expect(getMilestone(m.id)).toMatchObject({ archived: false, status: 'completed' })
  expect(() => newTask('blocked', m.id)).toThrow(/Restore/)
  expect(listAreas()).toHaveLength(1)
  expect(listAreas({ includeArchived: true })).toHaveLength(2)
})

test('Area summaries preserve provenance during unrelated edits and milestone date ranges never fabricate dates', () => {
  const { a, m, n } = setup()
  expect(a).toMatchObject({ latestProgress: '', nextStep: '', summaryUpdatedAt: null, summarySource: null })
  expect(m).toMatchObject({ startDate: null, targetDate: null })
  const area = updateArea(a.id, { expectedRevision: a.revision, latestProgress: '完成诊断', nextStep: '验证方案' })
  expect(area).toMatchObject({ summarySource: 'manual', summarySourceNoteId: null, summarySourceInsightId: null, summarySourceNoteRevision: null })
  expect(area.summaryUpdatedAt).toBeGreaterThan(0)
  const renamed = updateArea(a.id, { expectedRevision: area.revision, name: 'Area rename', summarySource: 'insight', summaryUpdatedAt: 0 } as any)
  expect(renamed.summaryUpdatedAt).toBe(area.summaryUpdatedAt)
  expect(renamed.summarySource).toBe('manual')
  const scheduled = updateMilestone(m.id, { expectedRevision: m.revision, startDate: 1000, targetDate: 2000 })
  expect(() => updateMilestone(m.id, { expectedRevision: scheduled.revision, startDate: 3000 })).toThrow(/Start date/)
  expect(getMilestone(m.id)).toMatchObject({ startDate: 1000, targetDate: 2000, revision: scheduled.revision })
  expect(() => createMilestone({ areaId: a.id, name: 'Impossible dates', startDate: 10, targetDate: 5 })).toThrow(/Start date/)
  expect(() => updateMilestone(n.id, { expectedRevision: n.revision, startDate: NaN })).toThrow(/Invalid start/)
  updateMilestone(n.id, { expectedRevision: n.revision, startDate: 500, targetDate: null })
  updateMilestone(m.id, { expectedRevision: scheduled.revision, startDate: null })
  closeDb(); initDb()
  expect(getArea(a.id)).toEqual(renamed)
  expect(getMilestone(m.id)).toMatchObject({ startDate: null, targetDate: 2000 })
  expect(getMilestone(n.id)).toMatchObject({ startDate: 500, targetDate: null, status: 'planned' })
  expect(listMilestones({ query: 'Area rename' }).map(item => item.id)).toEqual([m.id])
})

test('timeline and Area summary migration adds empty optional values to existing project data idempotently', () => {
  const { a, m } = setup()
  closeDb()
  const old = new Database(process.env.CHRONICLE_DB_PATH!)
  for (const column of ['latest_progress', 'next_step', 'summary_updated_at', 'summary_source', 'summary_source_note_id', 'summary_source_insight_id', 'summary_source_note_revision']) old.exec(`ALTER TABLE areas DROP COLUMN ${column}`)
  old.exec('ALTER TABLE milestones DROP COLUMN start_date')
  old.close(); initDb()
  expect(getArea(a.id)).toMatchObject({ id: a.id, name: a.name, revision: a.revision, latestProgress: '', nextStep: '', summaryUpdatedAt: null, summarySource: null })
  expect(getMilestone(m.id)).toMatchObject({ id: m.id, startDate: null, targetDate: null, createdAt: m.createdAt })
  closeDb(); initDb()
  expect(getArea(a.id)?.summaryUpdatedAt).toBeNull()
  expect(getDb().pragma('foreign_key_check')).toEqual([])
})

test('Note project tag intersection applies before list and FTS limits with inherited links and archive behavior', async () => {
  const { a, b, m, n } = setup(), task = newTask('Context task', m.id)
  const direct = createNote({ title: 'Needle retained knowledge' }), contextual = createNote({ title: 'Needle contextual knowledge' }), extra = createNote({ title: 'Needle different direction' })
  setReferences('note', direct.id, [{ targetType: 'area', targetId: a.id }, { targetType: 'milestone', targetId: m.id }], 1)
  linkNoteToTask(contextual.id, task.id)
  setReferences('note', extra.id, [{ targetType: 'area', targetId: b.id }], 1)
  getDb().prepare('UPDATE notes SET updated_at=1 WHERE id IN (?,?)').run(direct.id, contextual.id)
  for (let index = 0; index < 410; index++) createNote({ title: 'Needle retained knowledge' })
  const filters = [`area:${a.id}`, `milestone:${m.id}`]
  expect(getNotes({ projectFilters: filters, limit: 300 }).map(note => note.id).sort()).toEqual([direct.id, contextual.id].sort())
  expect(getNotes({ projectFilters: filters, query: 'Needle', limit: 1 })).toHaveLength(1)
  expect(searchNotes('Needle', 50, false, filters).results.map(note => note.noteId).sort()).toEqual([direct.id, contextual.id].sort())
  expect(getNotes({ projectFilters: [`area:${a.id}`, `milestone:${n.id}`] })).toEqual([])
  archiveNote(direct.id, true)
  expect(getNotes({ projectFilters: filters }).map(note => note.id)).toEqual([contextual.id])
  expect(searchNotes('Needle', 50, false, filters).results.map(note => note.noteId)).toEqual([contextual.id])
  expect(getNotes({ projectFilters: filters, includeArchived: true })).toHaveLength(2)
  expect(() => getNotes({ projectFilters: ['task:invalid'] })).toThrow(/Invalid projectFilters/)
  // Load through Playwright's TS require hook after the isolated environment is set.
  const { app } = require('../server/src/app') as typeof import('../server/src/app')
  const query = new URLSearchParams({ projectFilters: JSON.stringify(filters), query: 'Needle', limit: '300' })
  const response = await app.request(`/api/notes?${query}`)
  expect(response.status).toBe(200)
  expect((await response.json()).map((note: { id: string }) => note.id)).toEqual([contextual.id])
  expect((await app.request('/api/notes?projectFilters=not-json')).status).toBe(400)
  expect((await app.request(`/api/notes?${new URLSearchParams({ projectFilters: JSON.stringify(['task:invalid']) })}`)).status).toBe(400)
})

test('recorded time clips consistently and references never double count', () => {
  const { a, b, m, n } = setup()
  const t = newTask('primary', m.id), unassigned = newTask('unassigned'), other = newTask('secondary', n.id)
  session(t.id, 100, 500); session(t.id, 700, null); session(unassigned.id, 400, 600); session(other.id, 900, 1100)
  setReferences('task', t.id, [{ targetType: 'area', targetId: b.id }, { targetType: 'milestone', targetId: n.id }], 1)
  const stats = getWorkStatistics({ start: 200, end: 1000, asOf: 950 })
  expect(stats.totalMs).toBe(800); expect(stats.unassignedMs).toBe(200)
  expect(stats.byArea.find(g => g.id === a.id)?.totalMs).toBe(550)
  expect(stats.byMilestone.find(g => g.id === n.id)?.totalMs).toBe(50)
  expect(stats.byArea.reduce((sum, g) => sum + g.totalMs, 0) + stats.unassignedMs).toBe(stats.totalMs)
  expect(stats.byMilestone.reduce((sum, g) => sum + g.totalMs, 0) + stats.unassignedMs).toBe(stats.totalMs)
  expect(stats.anomalies.length).toBeGreaterThan(0)
  updateMilestone(m.id, { expectedRevision: 1, archived: true })
  expect(getWorkStatistics({ start: 200, end: 1000, asOf: 950 }).totalMs).toBe(800)
  expect(getProjectOverview({ start: 200, end: 1000, asOf: 950 }).statistics.totalMs).toBe(800)
})

test('running time naturally advances without invalidating the assignment preview', () => {
  const { m, n } = setup(), t = newTask('running', m.id), asOf = Date.now() - 1000
  session(t.id, asOf - 500, null)
  const preview = previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: n.id, expectedRevision: 1 }], asOf })
  expect(preview.before.byMilestone[0].id).toBe(m.id)
  expect(preview.after.byMilestone[0].id).toBe(n.id)
  const applied = applyAssignment(preview.token)
  expect(applied.additionalRecordedMs).toBeGreaterThanOrEqual(1000)
  expect(getTaskById(t.id)).toMatchObject({ primaryMilestoneId: n.id, projectRevision: 2 })
  expect(() => applyAssignment(preview.token)).toThrow(/expired|already applied/)
  undoAssignment(applied.eventId)
  expect(getTaskById(t.id)).toMatchObject({ primaryMilestoneId: m.id, projectRevision: 3 })
})

test('closing, adding, or editing a session invalidates a preview without mutating assignment', () => {
  const { m, n } = setup(), t = newTask('running', m.id)
  const id = session(t.id, Date.now() - 500, null)
  const first = previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: n.id, expectedRevision: 1 }] })
  getDb().prepare('UPDATE work_sessions SET ended_at=? WHERE id=?').run(Date.now(), id)
  expect(() => applyAssignment(first.token)).toThrow(/changed/)
  const second = previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: n.id, expectedRevision: 1 }] })
  session(t.id, 100, 200)
  expect(() => applyAssignment(second.token)).toThrow(/changed/)
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(m.id)
})

test('legacy patches preserve undefined and cannot bypass atomic reclassification', () => {
  const { m, n } = setup(), t = newTask('title', m.id)
  updateTask(t.id, { title: 'changed' })
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(m.id)
  expect(() => updateTask(t.id, { title: 'must roll back', primaryMilestoneId: null, expectedProjectRevision: 1 })).toThrow(/preview/i)
  expect(getTaskById(t.id)?.title).toBe('changed')
  const preview = previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: n.id, expectedRevision: 1 }] })
  expect(() => updateTask(t.id, { primaryMilestoneId: null, expectedProjectRevision: 1, assignmentToken: preview.token })).toThrow(/match/)
  updateTask(t.id, { title: 'accepted', primaryMilestoneId: n.id, expectedProjectRevision: 1, assignmentToken: preview.token })
  expect(getTaskById(t.id)).toMatchObject({ title: 'accepted', primaryMilestoneId: n.id, projectRevision: 2 })
})

test('batch assignment is atomic and undo refuses newer relationship changes', () => {
  const { m, n } = setup(), t = newTask('one', m.id), u = newTask('two')
  const preview = previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: n.id, expectedRevision: 1 }, { taskId: u.id, primaryMilestoneId: n.id, expectedRevision: 1 }] })
  const result = applyAssignment(preview.token)
  setReferences('task', u.id, [{ targetType: 'milestone', targetId: m.id }], 2)
  expect(() => undoAssignment(result.eventId)).toThrow(/changed/)
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(n.id)
  expect(getTaskById(u.id)?.primaryMilestoneId).toBe(n.id)
})

test('milestone history preserves task moves after restart and finds removal from the former milestone', () => {
  const { a, m, n } = setup(), t = newTask('move and return', m.id)
  const unrelated = createMilestone({ areaId: a.id, name: m.name })
  const applied = applyAssignment(previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: n.id, expectedRevision: 1 }] }).token)
  closeDb(); initDb()
  expect(getMilestoneDetail(m.id).tasks).toHaveLength(0)
  for (const id of [m.id, n.id]) expect(getMilestoneDetail(id).events.filter(e => e.id === applied.eventId)).toHaveLength(1)
  expect(getMilestoneDetail(unrelated.id).events.some(e => e.id === applied.eventId)).toBe(false)
  expect(getProjectEvents('milestone', m.id.slice(0, -1))).toEqual([])
  const recoverable = getMilestoneDetail(m.id).events.find(e => e.id === applied.eventId)!
  undoAssignment(recoverable.id)
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(m.id)
  for (const id of [m.id, n.id]) {
    const history = getMilestoneDetail(id).events
    expect(history.find(e => e.id === applied.eventId)?.undoneAt).toBeTruthy()
    expect(history.some(e => e.kind === 'assignment_undone')).toBe(true)
  }
  const cleared = applyAssignment(previewAssignment({ changes: [{ taskId: t.id, primaryMilestoneId: null, expectedRevision: 3 }] }).token)
  expect(getMilestoneDetail(m.id).tasks).toHaveLength(0)
  expect(getMilestoneDetail(n.id).events.some(e => e.id === cleared.eventId)).toBe(false)
  undoAssignment(getMilestoneDetail(m.id).events.find(e => e.id === cleared.eventId)!.id)
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(m.id)
})

test('milestone history keeps an entire batch and its undo cannot overwrite later relationships', () => {
  const { a, m, n } = setup(), other = createMilestone({ areaId: a.id, name: 'Other origin' })
  const t = newTask('first', m.id), u = newTask('second', other.id)
  const move = (expectedRevision: number) => applyAssignment(previewAssignment({ changes: [
    { taskId: t.id, primaryMilestoneId: n.id, expectedRevision },
    { taskId: u.id, primaryMilestoneId: null, expectedRevision },
  ] }).token)
  const applied = move(1)
  for (const id of [m.id, n.id, other.id]) {
    const events = getMilestoneDetail(id).events.filter(e => e.id === applied.eventId)
    expect(events).toHaveLength(1)
    expect(events[0].before).toHaveLength(2)
    expect(events[0].after).toHaveLength(2)
  }
  undoAssignment(getMilestoneDetail(m.id).events.find(e => e.id === applied.eventId)!.id)
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(m.id)
  expect(getTaskById(u.id)?.primaryMilestoneId).toBe(other.id)
  const again = move(3)
  setReferences('task', u.id, [{ targetType: 'milestone', targetId: m.id }], 4)
  const historicalEvent = getMilestoneDetail(m.id).events.find(e => e.id === again.eventId)!
  expect(() => undoAssignment(historicalEvent.id)).toThrow(/changed/)
  expect(getTaskById(t.id)?.primaryMilestoneId).toBe(n.id)
  expect(getTaskById(u.id)?.primaryMilestoneId).toBeNull()
  expect(getMilestoneDetail(m.id).events.find(e => e.id === again.eventId)?.undoneAt).toBeNull()
})

test('milestone area reclassification moves only attribution and can be undone', () => {
  const { a, b, m } = setup(), t = newTask('one', m.id)
  const sid = session(t.id, 100, 1100)
  const originalSession = getDb().prepare('SELECT * FROM work_sessions WHERE id=?').get(sid)
  expect(() => updateMilestone(m.id, { expectedRevision: 1, areaId: b.id })).toThrow(/Preview/)
  const preview = previewAssignment({ milestoneId: m.id, areaId: b.id, expectedRevision: 1 })
  const applied = applyAssignment(preview.token)
  expect(getWorkStatistics().byArea[0].id).toBe(b.id)
  expect(getDb().prepare('SELECT * FROM work_sessions WHERE id=?').get(sid)).toEqual(originalSession)
  undoAssignment(applied.eventId)
  expect(getMilestone(m.id)?.areaId).toBe(a.id)
  expect(getWorkStatistics().byArea[0].id).toBe(a.id)
})

test('references have independent revision and reverse aggregation deduplicates notes', () => {
  const { a, m } = setup(), note = createNote({ title: 'Learning', contentHtml: '<p>Original</p>' })
  const related = setReferences('note', note.id, [{ targetType: 'area', targetId: a.id }, { targetType: 'milestone', targetId: m.id, role: 'growth' }], 1)
  expect(related.projectRevision).toBe(2)
  expect(getNoteById(note.id)?.revision).toBe(note.revision)
  expect(() => setReferences('note', note.id, [], 1)).toThrow(/changed/)
  const backlinks = getBacklinks('area', a.id)
  expect(backlinks.notes).toHaveLength(1)
  expect(backlinks.notes[0].via).toHaveLength(2)
  expect(getAreaDetail(a.id).backlinks.notes).toHaveLength(1)
  updateMilestone(m.id, { expectedRevision: 1, name: 'Renamed' })
  expect(getReferences('note', note.id).references.find(r => r.targetType === 'milestone')?.name).toBe('Renamed')
  addProjectReference('note', note.id, { targetType: 'milestone', targetId: m.id, role: 'review' })
  expect(getReferences('note', note.id).references).toHaveLength(2)
  expect(getMilestoneDetail(m.id).reviewStatus).toBe('none')
})

test('manual reference edits preserve independently sourced mentions across restart', () => {
  const { a, m } = setup(), t = newTask('linked')
  getDb().prepare("INSERT INTO project_references(id,task_id,area_id,role,origin,created_at) VALUES('mention',?,?,'related','mention',1)").run(t.id, a.id)
  setReferences('task', t.id, [{ targetType: 'milestone', targetId: m.id }], 1)
  setReferences('task', t.id, [], 2)
  expect(getReferences('task', t.id).references).toHaveLength(1)
  closeDb(); initDb()
  expect(getReferences('task', t.id).references[0].origin).toBe('mention')
})

test('task and note deletion removes live references and keeps milestone audit history', () => {
  const { a, m } = setup(), t = newTask('delete', m.id), note = createNote({ title: 'delete note' })
  session(t.id, 100, 500)
  setReferences('task', t.id, [{ targetType: 'area', targetId: a.id }], 1)
  setReferences('note', note.id, [{ targetType: 'milestone', targetId: m.id }], 1)
  deleteTask(t.id); deleteNote(note.id)
  expect(getDb().prepare('SELECT * FROM project_references').all()).toEqual([])
  expect(getWorkStatistics().totalMs).toBe(0)
  expect(getMilestoneDetail(m.id).events).toHaveLength(1)
  expect(getDb().pragma('foreign_key_check')).toEqual([])
})

test('create references and primary assignment share an atomic creation transaction', () => {
  const { m, n } = setup()
  expect(() => createTask({ title: 'invalid', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: m.id, references: [{ targetType: 'area', targetId: 'missing' }] })).toThrow(/not found/)
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  const task = createTask({ title: 'linked', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: m.id, references: [{ targetType: 'milestone', targetId: n.id }] })
  expect(task.projectRevision).toBe(2)
  expect(getReferences('task', task.id).references[0].targetId).toBe(n.id)
  expect(listMilestones({ query: 'Practice' })).toHaveLength(1)
})

test('moving a milestone through PATCH keeps its assignment undo available', () => {
  const { a, b, m } = setup()
  const preview = previewAssignment({ milestoneId: m.id, areaId: b.id, expectedRevision: 1 })
  const moved = updateMilestone(m.id, { areaId: b.id, expectedRevision: 1, assignmentToken: preview.token, name: 'New name' })
  expect(moved).toMatchObject({ areaId: b.id, name: 'New name' })
  const event = getMilestoneDetail(m.id).events.find(e => e.kind === 'assignment')!
  undoAssignment(event.id)
  expect(getMilestone(m.id)).toMatchObject({ areaId: a.id, name: 'New name' })
})

test('future periods cannot fabricate running work and invalid payloads leave state intact', () => {
  const { m } = setup(), t = newTask('running', m.id), now = Date.now()
  session(t.id, now - 1000, null)
  expect(getWorkStatistics({ start: now - 1000, end: now + 86400000, asOf: now + 86400000 }).totalMs).toBeLessThan(2000)
  expect(() => setReferences('task', t.id, [null as any], 1)).toThrow(/target ID/)
  expect(() => previewAssignment({ changes: [null as any] })).toThrow(/task ID/)
  expect(() => updateMilestone(m.id, { expectedRevision: 1, kind: null as any })).toThrow(/kind/)
  expect(getMilestone(m.id)?.revision).toBe(1)
  expect(getReferences('task', t.id).projectRevision).toBe(1)
})

test('old completion reviews do not confirm a reopened or newly cancelled stage', () => {
  const { m } = setup()
  const done = updateMilestone(m.id, { expectedRevision: 1, status: 'completed', confirmCompletion: true })
  const review = createProjectReview({ targetType: 'milestone', targetId: m.id, kind: 'completion', contentHtml: '<p>Accepted result</p>' })
  confirmProjectReview(review.id, { expectedNoteRevision: 1 })
  expect(getMilestoneDetail(m.id).reviewStatus).toBe('confirmed')
  const reopened = updateMilestone(m.id, { expectedRevision: done.revision, status: 'active' })
  expect(getMilestoneDetail(m.id)).toMatchObject({ reviewStatus: 'none', lastReviewedAt: null })
  const cancelled = updateMilestone(m.id, { expectedRevision: reopened.revision, status: 'cancelled' })
  expect(cancelled.completionEventId).toBeTruthy()
  expect(cancelled.completionEventId).not.toBe(done.completionEventId)
  expect(getMilestoneDetail(m.id).reviewStatus).toBe('pending')
  const termination = createProjectReview({ targetType: 'milestone', targetId: m.id, kind: 'completion', contentHtml: '<p>Stopped with lessons</p>' })
  confirmProjectReview(termination.id, { expectedNoteRevision: 1 })
  expect(getMilestoneDetail(m.id).reviewStatus).toBe('confirmed')
})

test('milestone move undo cannot silently reclassify work that joined afterwards', () => {
  const { b, m } = setup()
  const originalTask = newTask('original', m.id)
  const preview = previewAssignment({ milestoneId: m.id, areaId: b.id, expectedRevision: 1 })
  const applied = applyAssignment(preview.token)
  const joinedTask = newTask('joined later', m.id)
  session(joinedTask.id, 100, 900)
  expect(() => undoAssignment(applied.eventId)).toThrow(/relationships changed/)
  expect(getMilestone(m.id)?.areaId).toBe(b.id)
  expect(getTaskById(originalTask.id)?.primaryMilestoneId).toBe(m.id)
  expect(getWorkStatistics().byArea[0]).toMatchObject({ id: b.id, totalMs: 800 })
})

test('untrusted update fields cannot rewrite identity, revision, or completion evidence', () => {
  const { a, b, m, n } = setup()
  const area = updateArea(a.id, { expectedRevision: 1, id: b.id, revision: 99, createdAt: 0, name: 'Safe update' } as any)
  expect(area).toMatchObject({ id: a.id, revision: 2, name: 'Safe update' })
  expect(getArea(b.id)?.name).toBe('Growth')
  const milestone = updateMilestone(m.id, { expectedRevision: 1, id: n.id, revision: 99, completionEventId: 'forged', completedAt: 7, latestProgress: 'Actual progress' } as any)
  expect(milestone).toMatchObject({ id: m.id, revision: 2, completionEventId: null, completedAt: null, latestProgress: 'Actual progress' })
  expect(getMilestone(n.id)?.revision).toBe(1)
  expect(() => updateMilestone(m.id, { expectedRevision: 2, areaId: b.id, assignmentToken: 'forged' })).toThrow(/expired/)
  expect(getMilestone(m.id)?.areaId).toBe(a.id)
})

test('Notes linked through Tasks are contextual backlinks without creating tags or duplicate effort', () => {
  const { a, b, m, n } = setup(), task = newTask('Evidence Task', m.id)
  const note = createNote({ title: 'Linked knowledge', contentHtml: '<p>Lesson</p>' })
  const entry = createTaskEntry(task.id, '<p>Observed result</p>')
  linkNoteToTask(note.id, task.id); linkNoteToTaskEntry(note.id, task.id, entry.id)
  session(task.id, 100, 900)
  expect(getBacklinks('area', a.id).notes).toHaveLength(1)
  expect(getBacklinks('milestone', m.id).notes[0].via).toEqual(expect.arrayContaining([
    expect.objectContaining({ targetId: m.id, viaTaskId: task.id, viaTaskTitle: 'Evidence Task' }),
    expect.objectContaining({ viaEntryId: entry.id }),
  ]))
  expect(getReferences('note', note.id).references).toEqual([])
  expect(getReferences('note', note.id).projectRevision).toBe(1)
  setReferences('note', note.id, [{ targetType: 'milestone', targetId: m.id, role: 'growth' }], 1)
  expect(getBacklinks('area', a.id).notes).toHaveLength(1)
  const preview = previewAssignment({ changes: [{ taskId: task.id, primaryMilestoneId: n.id, expectedRevision: 1 }] })
  applyAssignment(preview.token)
  expect(getBacklinks('area', a.id).notes[0].via.every(v => !v.viaTaskId)).toBe(true)
  expect(getBacklinks('area', b.id).notes[0].via[0].viaTaskId).toBe(task.id)
  expect(getWorkStatistics().totalMs).toBe(800)
  expect(getWorkStatistics().byArea).toHaveLength(1)
})

test('unknown Note link types and mismatched log links never create project context', () => {
  const { m } = setup(), task = newTask('Work', m.id), note = createNote({ title: 'Should remain unrelated' })
  getDb().prepare(`INSERT INTO note_links(id,note_id,target_type,target_id,target_entry_id,created_at) VALUES('unknown',?,'future_object',?,NULL,1)`).run(note.id, task.id)
  getDb().prepare(`INSERT INTO note_links(id,note_id,target_type,target_id,target_entry_id,created_at) VALUES('broken',?,'task_entry',?,'missing',1)`).run(note.id, task.id)
  expect(getBacklinks('milestone', m.id).notes).toEqual([])
})
