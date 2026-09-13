import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeDb, getDb, initDb } from '../server/src/db'
import { createArea, createMilestone, updateArea, updateMilestone } from '../server/src/services/projectService'
import { createTask, createTaskEntry, updateTask } from '../server/src/services/taskService'
import { createNote, linkNoteToTask, linkNoteToTaskEntry } from '../server/src/services/noteService'
import { addProjectReference } from '../server/src/services/projectReferenceService'
import { getProjectActivity } from '../server/src/services/projectActivityService'
import { getWorkStatistics } from '../server/src/services/workStatisticsService'
import type { ProjectActivityQuery } from '../shared/projectActivityTypes'

test.describe.configure({ mode: 'serial' })
let directory: string
let original: Record<string, string | undefined>
const envKeys = ['CHRONICLE_DB_PATH', 'CHRONICLE_CONFIG_DIR', 'CHRONICLE_CONFIG_PATH', 'CHRONICLE_LOG_DIR', 'CHRONICLE_LOG_PATH']
test.beforeEach(() => {
  original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-activity-'))
  process.env.CHRONICLE_DB_PATH = path.join(directory, 'test.db')
  process.env.CHRONICLE_CONFIG_DIR = directory
  process.env.CHRONICLE_CONFIG_PATH = path.join(directory, 'config.json')
  process.env.CHRONICLE_LOG_DIR = directory
  process.env.CHRONICLE_LOG_PATH = path.join(directory, 'test.log')
  initDb()
})
test.afterEach(() => {
  closeDb()
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  fs.rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const area = createArea({ name: 'Engineering' }), otherArea = createArea({ name: 'Growth' })
  const milestone = createMilestone({ areaId: area.id, name: 'Delivery', completionCriteria: 'Accepted outcome' })
  const sibling = createMilestone({ areaId: area.id, name: 'Operations', kind: 'ongoing' })
  const otherMilestone = createMilestone({ areaId: otherArea.id, name: 'Practice', kind: 'ongoing' })
  const task = createTask({ title: 'Investigate and deliver', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
  const query: ProjectActivityQuery = { targetType: 'milestone', targetId: milestone.id, start: 100, end: 1000, asOf: 1000 }
  return { area, otherArea, milestone, sibling, otherMilestone, task, query }
}
function log(taskId: string, at: number, content = '<p>Investigated one finding</p>', type: 'log' | 'pinned' | 'body' = 'log') {
  const entry = createTaskEntry(taskId, content, type)
  getDb().prepare('UPDATE task_entries SET created_at=? WHERE id=?').run(at, entry.id)
  return entry
}
function note(title: string, at: number, contentHtml = '<p>Retained learning</p>') {
  const value = createNote({ title, contentHtml })
  getDb().prepare('UPDATE notes SET created_at=?,updated_at=? WHERE id=?').run(at, at, value.id)
  return value
}
function reference(noteId: string, targetType: 'area' | 'milestone', targetId: string, at: number, role: 'related' | 'outcome' | 'growth' = 'related') {
  addProjectReference('note', noteId, { targetType, targetId, role })
  getDb().prepare(`UPDATE project_references SET created_at=? WHERE note_id=? AND ${targetType === 'area' ? 'area_id' : 'milestone_id'}=?`).run(at, noteId, targetId)
}
function session(taskId: string, id: string, start: number, end: number | null) {
  getDb().prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(id, taskId, start, end)
}

test('activity uses half-open boundaries and the same fixed cutoff as recorded work', () => {
  const { task, query } = setup()
  log(task.id, 99)
  const first = log(task.id, 100), last = log(task.id, 699)
  log(task.id, 700); log(task.id, 1000)
  session(task.id, 'running', 50, null)
  const range = { start: 100, end: 1000, asOf: 700 }
  const activity = getProjectActivity({ ...query, ...range })
  expect(activity.window).toEqual(range)
  expect(activity.items.map(item => item.sourceId)).toEqual([last.id, first.id])
  expect(getWorkStatistics(range).sessions[0]).toMatchObject({ clippedStart: 100, clippedEnd: 700, durationMs: 600 })
  expect(getProjectActivity({ ...query, start: 700, end: 700 })).toMatchObject({ items: [], total: 0, hasMore: false, nextOffset: null })
  expect(getProjectActivity({ ...query, start: 700, asOf: 600 }).items).toEqual([])
})

test('Area activity includes child milestones and references but never attributes reference time', () => {
  const { task, query, area, milestone, sibling, otherMilestone } = setup()
  const siblingTask = createTask({ title: 'Sibling task', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: sibling.id })
  const externalTask = createTask({ title: 'Referenced task', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: otherMilestone.id })
  const areaOnlyTask = createTask({ title: 'Area reference only', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: otherMilestone.id })
  const unrelatedTask = createTask({ title: 'Unrelated task', type: 'TODO', priority: 'MEDIUM' })
  addProjectReference('task', externalTask.id, { targetType: 'milestone', targetId: milestone.id })
  addProjectReference('task', areaOnlyTask.id, { targetType: 'area', targetId: area.id })
  const own = log(task.id, 500), siblingLog = log(siblingTask.id, 510), relatedLog = log(externalTask.id, 520)
  const areaOnlyLog = log(areaOnlyTask.id, 515)
  log(unrelatedTask.id, 530)
  const outcome = note('Shared outcome', 550)
  reference(outcome.id, 'milestone', milestone.id, 500, 'outcome')
  reference(outcome.id, 'area', area.id, 500, 'outcome')
  session(task.id, 'primary-session', 100, 200)
  session(externalTask.id, 'external-session', 200, 600)
  const before = getWorkStatistics(query)
  const areaActivity = getProjectActivity({ ...query, targetType: 'area', targetId: area.id })
  expect(areaActivity.items.map(item => item.sourceId)).toEqual([outcome.id, relatedLog.id, areaOnlyLog.id, siblingLog.id, own.id])
  expect(areaActivity.items.find(item => item.sourceId === outcome.id)).toMatchObject({ kind: 'note', relationship: 'reference', roles: ['outcome'] })
  expect(areaActivity.items.find(item => item.sourceId === relatedLog.id)?.relationship).toBe('reference')
  expect(getProjectActivity(query).items.map(item => item.sourceId)).toEqual([outcome.id, relatedLog.id, own.id])
  expect(getWorkStatistics(query)).toEqual(before)
  expect(before.byArea.find(group => group.id === area.id)?.totalMs).toBe(100)
  expect(before.totalMs).toBe(500)
})

test('identical logs remain distinct facts, duplicate reference paths collapse by source ID, and task bodies are excluded', () => {
  const { task, query, milestone, area } = setup()
  const first = log(task.id, 300, '<p>Same text</p>'), second = log(task.id, 300, '<p>Same text</p>'), pinned = log(task.id, 400, '<p>Pinned finding</p>', 'pinned')
  log(task.id, 450, '<p>Task description</p>', 'body')
  addProjectReference('task', task.id, { targetType: 'area', targetId: area.id })
  addProjectReference('task', task.id, { targetType: 'milestone', targetId: milestone.id })
  const items = getProjectActivity({ ...query, targetType: 'area', targetId: area.id }).items
  expect(items).toHaveLength(3)
  expect(items.map(item => item.sourceId).sort()).toEqual([first.id, second.id, pinned.id].sort())
  expect(items.every(item => item.relationship === 'primary')).toBe(true)
  expect(items.filter(item => item.excerpt === 'Same text')).toHaveLength(2)
})

test('Notes retain typed Task context and distinguish latest update from a new relationship', () => {
  const { task, query, milestone, area } = setup()
  const entry = log(task.id, 110)
  const learned = note('Learned reasoning', 300)
  linkNoteToTask(learned.id, task.id); linkNoteToTaskEntry(learned.id, task.id, entry.id)
  getDb().prepare('UPDATE note_links SET created_at=200 WHERE note_id=?').run(learned.id)
  const linked = note('Older note linked this week', 50)
  reference(linked.id, 'milestone', milestone.id, 500, 'growth')
  const futureText = note('Later edited note', 1000)
  reference(futureText.id, 'milestone', milestone.id, 200)
  const laterLinked = note('Linked after cutoff', 400)
  reference(laterLinked.id, 'milestone', milestone.id, 1000)
  const fakeContext = note('Unrecognized context must not leak', 350)
  getDb().prepare("INSERT INTO note_links(id,note_id,target_type,target_id,target_entry_id,created_at,context) VALUES('fake-link',?,'future_kind',?,NULL,200,'manual')").run(fakeContext.id, task.id)
  const items = getProjectActivity(query).items.filter(item => item.kind === 'note')
  expect(items.map(item => item.sourceId)).toEqual([linked.id, learned.id])
  expect(items[0]).toMatchObject({ timeMeaning: 'note_linked', occurredAt: 500, roles: ['growth'], viaTaskIds: [] })
  expect(items[1]).toMatchObject({ timeMeaning: 'note_updated', occurredAt: 300, relationship: 'task_context', viaTaskIds: [task.id] })
  expect(getProjectActivity({ ...query, targetType: 'area', targetId: area.id }).items.filter(item => item.sourceId === learned.id)).toHaveLength(1)
  // Adding a direct path must not duplicate the Note or its Task context.
  reference(learned.id, 'milestone', milestone.id, 250)
  expect(getProjectActivity(query).items.filter(item => item.sourceId === learned.id)).toEqual([expect.objectContaining({ relationship: 'reference', viaTaskIds: [task.id] })])
})

test('archiving and cancellation preserve readable historical activity without mutations', () => {
  const { task, query, area, milestone } = setup()
  const entry = log(task.id, 400)
  const archivedNote = note('Prior outcome', 500)
  reference(archivedNote.id, 'milestone', milestone.id, 400, 'outcome')
  getDb().prepare('UPDATE notes SET archived=1 WHERE id=?').run(archivedNote.id)
  updateTask(task.id, { status: 'DROPPED' })
  updateMilestone(milestone.id, { expectedRevision: 1, status: 'cancelled', archived: true })
  updateArea(area.id, { expectedRevision: 1, status: 'ended', archived: true })
  const tables = ['tasks', 'task_entries', 'notes', 'note_links', 'work_sessions', 'project_references', 'project_events']
  const snapshot = () => tables.map(table => getDb().prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  const before = snapshot()
  const activity = getProjectActivity(query)
  expect(activity.items.map(item => item.sourceId)).toEqual([archivedNote.id, entry.id])
  expect(activity.items[0].archived).toBe(true)
  expect(snapshot()).toEqual(before)
})

test('pages are deterministic with tied timestamps and bounded empty/out-of-range pages', () => {
  const { task, query } = setup()
  for (let i = 0; i < 7; i++) log(task.id, 300, `<p>Finding ${i}</p>`)
  const all = getProjectActivity(query)
  const first = getProjectActivity({ ...query, limit: 3 }), second = getProjectActivity({ ...query, limit: 3, offset: 3 }), third = getProjectActivity({ ...query, limit: 3, offset: 6 })
  expect(first).toMatchObject({ total: 7, hasMore: true, nextOffset: 3 })
  expect(second).toMatchObject({ hasMore: true, nextOffset: 6 })
  expect(third).toMatchObject({ hasMore: false, nextOffset: null })
  expect([...first.items, ...second.items, ...third.items]).toEqual(all.items)
  expect(new Set(all.items.map(item => item.id)).size).toBe(7)
  expect(getProjectActivity({ ...query, offset: 100 })).toMatchObject({ items: [], total: 7, hasMore: false, nextOffset: null })
})

test('source excerpts retain exact HTML evidence and cap large payloads without storing a derived summary', () => {
  const { task, query } = setup()
  const html = '<p>Finding &amp; evidence</p><script>malicious()</script><img src="x" onerror="malicious()"><p>' + 'Detailed source '.repeat(1500) + '</p>'
  const entry = log(task.id, 200, html)
  const [item] = getProjectActivity(query).items
  expect(item.sourceId).toBe(entry.id)
  expect(item.contentHtml).toBe(html.slice(0, 16000))
  expect(item.contentTruncated).toBe(true)
  expect(item.excerpt).toHaveLength(320)
  expect(item.excerpt).toContain('Finding & evidence')
  expect(item.excerpt).not.toContain('malicious()')
  expect((getDb().prepare('SELECT content FROM task_entries WHERE id=?').get(entry.id) as { content: string }).content).toBe(html)
})

test('large unrelated histories stay excluded while interleaved Note/log pages preserve the complete count and order', () => {
  const { task, query, milestone } = setup()
  const unrelated = createTask({ title: 'Unrelated history', type: 'TODO', priority: 'MEDIUM' })
  const insert = getDb().prepare("INSERT INTO task_entries(id,task_id,content,type,created_at) VALUES(?,?,?,'log',?)")
  getDb().transaction(() => {
    for (let i = 0; i < 1200; i++) insert.run(`unrelated-${String(i).padStart(4, '0')}`, unrelated.id, '<p>Unrelated historical body</p>'.repeat(40), 500)
    for (let i = 0; i < 35; i++) insert.run(`relevant-${String(i).padStart(3, '0')}`, task.id, `<p>Relevant fact ${i}</p>`, 200 + i * 10)
  })()
  for (let i = 0; i < 4; i++) {
    const value = note(`Interleaved learning ${i}`, 215 + i * 100)
    reference(value.id, 'milestone', milestone.id, 100)
  }
  const all = getProjectActivity({ ...query, limit: 100 })
  expect(all.total).toBe(39)
  expect(all.items).toHaveLength(39)
  expect(all.items.some(item => item.taskId === unrelated.id)).toBe(false)
  const pages = [0, 7, 14, 21, 28, 35].map(offset => getProjectActivity({ ...query, limit: 7, offset }))
  expect(pages.every(page => page.total === 39)).toBe(true)
  expect(pages.flatMap(page => page.items)).toEqual(all.items)
  expect(pages[5]).toMatchObject({ hasMore: false, nextOffset: null })
  expect(getProjectActivity({ ...query, limit: 7, offset: 100 })).toMatchObject({ items: [], total: 39, hasMore: false })
})

test('HTTP route returns bounded activity and controlled errors without a socket', async () => {
  const { task, query } = setup()
  const entry = log(task.id, 300)
  // Load after the isolated database and config paths are set.
  const { projectRoutes } = require('../server/src/projectRoutes') as typeof import('../server/src/projectRoutes')
  const url = (changes: Record<string, string> = {}) => `/projects/activity?${new URLSearchParams({ targetType: query.targetType, targetId: query.targetId, start: '100', end: '1000', asOf: '1000', ...changes })}`
  const response = await projectRoutes.request(url())
  expect(response.status).toBe(200)
  expect((await response.json()).items[0].sourceId).toBe(entry.id)
  for (const changes of [{ limit: '0' }, { limit: '101' }, { offset: '-1' }, { offset: '1000001' }, { start: '-1' }, { start: '1001' }, { end: 'invalid' }, { asOf: '' }, { targetType: 'task' }, { targetId: '' }]) {
    const invalid = await projectRoutes.request(url(changes))
    expect(invalid.status, JSON.stringify(changes)).toBe(400)
    expect((await invalid.json()).code).toBe('INVALID_PROJECT_ACTIVITY_QUERY')
  }
  expect((await projectRoutes.request(url({ targetId: 'missing', start: '1000' }))).status).toBe(404)
  const future = getProjectActivity({ ...query, asOf: Date.now() + 60000 })
  expect(future.window.asOf).toBeLessThanOrEqual(Date.now())
})
