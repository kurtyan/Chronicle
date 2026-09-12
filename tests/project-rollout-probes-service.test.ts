import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { closeDb, getDb, initDb } from '../server/src/db'
import { AppService } from '../server/src/services/appService'
import { createTask, deleteTask, getCurrentSession, getTaskById, startWorkSession } from '../server/src/services/taskService'
import { createArea } from '../server/src/services/projectService'
import { getReferences } from '../server/src/services/projectReferenceService'
import { getWorkStatistics } from '../server/src/services/workStatisticsService'
import { createNote, getNoteById, linkNoteToTask } from '../server/src/services/noteService'

/**
 * Fault-isolation acceptance tests. Ordinary Task creation, recorded work and
 * session controls must keep working when optional project storage fails.
 * Explicit project links still validate and fail atomically. Damaged schemas
 * exist only in fresh temporary databases, without listeners or production data.
 */
const requireServer = createRequire(path.resolve('server/package.json'))
const Database = requireServer('better-sqlite3')
test.describe.configure({ mode: 'serial' })
let dir: string
let original: Record<string, string | undefined>
const envKeys = ['CHRONICLE_DB_PATH', 'CHRONICLE_CONFIG_DIR', 'CHRONICLE_CONFIG_PATH', 'CHRONICLE_LOG_DIR', 'CHRONICLE_LOG_PATH']

test.beforeEach(() => {
  original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-rollout-probe-'))
  process.env.CHRONICLE_DB_PATH = path.join(dir, 'probe.db')
  process.env.CHRONICLE_CONFIG_DIR = dir
  process.env.CHRONICLE_CONFIG_PATH = path.join(dir, 'config.json')
  process.env.CHRONICLE_LOG_DIR = dir
  process.env.CHRONICLE_LOG_PATH = path.join(dir, 'probe.log')
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

function breakOnlyProjectStorage() {
  // Keep the milestone table itself: tasks now have an SQLite FK to it,
  // so dropping it would conflate FK preparation with optional project reads.
  getDb().exec('DROP TABLE project_references; ALTER TABLE areas RENAME COLUMN name TO unavailable_name')
}

function expectProjectTaskCascade() {
  expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
  expect(getDb().pragma('foreign_key_list(project_references)')).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: 'tasks', from: 'task_id', to: 'id', on_delete: 'CASCADE' }),
  ]))
}

test('ordinary Task creation with omitted or empty references survives project storage failure', () => {
  const ordinaryTask = { title: 'ordinary before failure', type: 'TODO', priority: 'MEDIUM' }
  expect(createTask({ ...ordinaryTask, references: [] }).id).toBeTruthy()
  breakOnlyProjectStorage()

  const legacy = createTask({ ...ordinaryTask, title: 'legacy omitted references' })
  expect(getTaskById(legacy.id)?.title).toBe('legacy omitted references')
  // This mirrors commitDraft: primaryMilestoneId null plus references [].
  const ordinary = createTask({ ...ordinaryTask, title: 'ordinary UI payload after failure', primaryMilestoneId: null, references: [] })
  expect(getTaskById(ordinary.id)).toMatchObject({ title: 'ordinary UI payload after failure', primaryMilestoneId: null, projectRevision: 1 })
})

test('explicit project references still validate and roll back Task body and search data on failure', () => {
  const area = createArea({ name: 'explicit relationship' })
  const linked = createTask({ title: 'valid explicit link', type: 'TODO', priority: 'MEDIUM', references: [{ targetType: 'area', targetId: area.id }] })
  expect(getReferences('task', linked.id).references).toMatchObject([{ targetType: 'area', targetId: area.id }])

  const snapshot = () => ['tasks', 'task_entries', 'search_documents', 'search_fts', 'task_id_reservations']
    .map(table => ({ table, rows: getDb().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }))
  const before = snapshot()
  expect(() => createTask({ title: 'invalid target', body: '<p>must roll back</p>', type: 'TODO', priority: 'MEDIUM', references: [{ targetType: 'area', targetId: 'missing-area' }] }))
    .toThrow(/Reference target not found/)
  expect(snapshot()).toEqual(before)
  expect(() => createTask({ title: 'invalid reference shape', type: 'TODO', priority: 'MEDIUM', references: {} as never })).toThrow(/References must be an array/)
  expect(snapshot()).toEqual(before)

  breakOnlyProjectStorage()
  expect(() => createTask({ title: 'unavailable explicit link', body: '<p>must also roll back</p>', type: 'TODO', priority: 'MEDIUM', references: [{ targetType: 'area', targetId: area.id }] }))
    .toThrow(/no such table: project_references/)
  expect(snapshot()).toEqual(before)
})

for (const projectFailure of [false, true]) {
  test(`Task deletion retains its complete old cleanup and ${projectFailure ? 'survives unavailable project storage' : 'cascades project references'}`, () => {
    expectProjectTaskCascade()
    const area = createArea({ name: 'delete reference area' })
    const target = createTask({ title: 'delete running task', body: '<p>delete body</p>', type: 'TODO', priority: 'MEDIUM', references: [{ targetType: 'area', targetId: area.id }] })
    const retained = createTask({ title: 'retained task', type: 'TODO', priority: 'MEDIUM', references: [{ targetType: 'area', targetId: area.id }] })
    const note = createNote({ title: 'retained Note', contentHtml: '<p>retained evidence</p>' })
    linkNoteToTask(note.id, target.id)
    startWorkSession(target.id)
    getDb().prepare('INSERT INTO task_extra_info(task_id,key,value) VALUES(?,?,?)').run(target.id, 'probe', 'cleanup')
    getDb().prepare('INSERT INTO work_overview_hidden_signals(id,task_id,source_type,signal_key,hidden_at) VALUES(?,?,?,?,?)').run('delete-signal', target.id, 'log', 'probe', Date.now())
    if (projectFailure) breakOnlyProjectStorage()

    expect(deleteTask(target.id)).toBe(true)
    expect(getTaskById(target.id)).toBeNull()
    expect(getCurrentSession()).toBeNull()
    for (const table of ['task_entries', 'work_sessions', 'task_extra_info', 'work_overview_hidden_signals']) {
      expect(getDb().prepare(`SELECT * FROM ${table} WHERE task_id=?`).all(target.id)).toEqual([])
    }
    expect(getDb().prepare('SELECT * FROM note_links WHERE target_id=?').all(target.id)).toEqual([])
    expect(getDb().prepare('SELECT * FROM search_documents WHERE task_id=?').all(target.id)).toEqual([])
    expect(getTaskById(retained.id)).not.toBeNull()
    expect(getNoteById(note.id)?.contentHtml).toBe('<p>retained evidence</p>')
    if (!projectFailure) {
      expect(getDb().prepare('SELECT * FROM project_references WHERE task_id=?').all(target.id)).toEqual([])
      expect(getReferences('task', retained.id).references).toHaveLength(1)
    }
    expect(deleteTask(target.id)).toBe(false)
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })
}

test('Task deletion remains atomic when a project foreign key rejects deletion instead of cascading', () => {
  const area = createArea({ name: 'restricted reference area' })
  const originalSchema = (getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_references'").get() as { sql: string }).sql
  getDb().exec('DROP TABLE project_references')
  getDb().exec(originalSchema.split('ON DELETE CASCADE').join('ON DELETE RESTRICT'))
  const target = createTask({ title: 'must not partially delete', body: '<p>keep body</p>', type: 'TODO', priority: 'MEDIUM', references: [{ targetType: 'area', targetId: area.id }] })
  startWorkSession(target.id)
  const snapshot = () => ['tasks', 'task_entries', 'work_sessions', 'search_documents', 'search_fts', 'project_references']
    .map(table => ({ table, rows: getDb().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }))
  const before = snapshot()
  expect(() => deleteTask(target.id)).toThrow(/FOREIGN KEY constraint failed/)
  expect(snapshot()).toEqual(before)
  expect(getCurrentSession()?.taskId).toBe(target.id)
})

test('legacy Report Task service and session start switch AFK and resume survive project storage failure', async () => {
  const service = new AppService()
  const first = createTask({ title: 'legacy first', type: 'TODO', priority: 'MEDIUM' })
  const second = createTask({ title: 'legacy second', type: 'TODO', priority: 'MEDIUM' })
  expect((await service.fetchReportTasks(0, Date.now() + 60_000, 'ALL')).items).toHaveLength(2)
  breakOnlyProjectStorage()

  expect((await service.fetchReportTasks(0, Date.now() + 60_000, 'ALL')).items).toHaveLength(2)
  const opened = await service.takeOverTask(first.id)
  expect(getCurrentSession()).toEqual(opened.session)
  expect(getTaskById(first.id)?.status).toBe('DOING')

  const switched = await service.takeOverTask(second.id)
  expect(getCurrentSession()?.taskId).toBe(second.id)
  const oldSession = getDb().prepare('SELECT ended_at FROM work_sessions WHERE id=?').get(opened.session.id) as { ended_at: number }
  expect(oldSession.ended_at).toBe(switched.session.startedAt)
  expect((getDb().prepare('SELECT COUNT(*) AS count FROM work_sessions WHERE ended_at IS NULL').get() as { count: number }).count).toBe(1)

  const afk = await service.doAfk()
  expect(afk.endedSession?.id).toBe(switched.session.id)
  expect(getCurrentSession()).toBeNull()
  const resumed = await service.resumeTaskFromAfk(second.id, afk.endedSession!.endedAt!)
  expect(getCurrentSession()).toEqual(resumed.session)
  const stopped = await service.doAfk()
  expect(stopped.endedSession?.id).toBe(resumed.session.id)
  expect(getCurrentSession()).toBeNull()
})

test('legacy Report retains exact clipped running and overlapping work when project metadata is unavailable', async () => {
  const actualNow = Date.now
  const now = actualNow()
  Date.now = () => now
  try {
    const service = new AppService()
    const closed = createTask({ title: 'closed sessions', body: '<p>legacy report body</p>', type: 'TODO', priority: 'MEDIUM' })
    const running = createTask({ title: 'running session', type: 'TODO', priority: 'MEDIUM' })
    const future = createTask({ title: 'future records', type: 'TODO', priority: 'MEDIUM' })
    const add = getDb().prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)')
    add.run('closed-first', closed.id, now - 2000, now - 1000)
    add.run('closed-second', closed.id, now - 900, now - 100)
    add.run('ends-at-range-start', closed.id, now - 1900, now - 1500)
    add.run('zero-interval', closed.id, now - 800, now - 800)
    add.run('running', running.id, now - 700, null)
    add.run('future-ended', future.id, now + 100, now + 500)
    add.run('future-running', future.id, now + 600, null)
    const beforeSessions = getDb().prepare('SELECT * FROM work_sessions ORDER BY id').all()
    const start = now - 1500, end = now - 500
    const reportBefore = await service.fetchReportTasks(start, end, 'ALL')
    const projected = getWorkStatistics({ start, end, asOf: now })
    expect(projected.totalMs).toBe(1100)
    expect(getWorkStatistics({ asOf: now }).totalMs).toBe(2900)

    breakOnlyProjectStorage()
    const report = await service.fetchReportTasks(start, end, 'ALL')
    expect(report).toEqual(reportBefore)
    expect(report.items.find(task => task.id === closed.id)).toMatchObject({ body: '<p>legacy report body</p>', workMs: 2200, rangeWorkMs: 900 })
    expect(report.items.find(task => task.id === running.id)).toMatchObject({ workMs: 700, rangeWorkMs: 200 })
    expect(report.items.find(task => task.id === future.id)).toMatchObject({ workMs: 0, rangeWorkMs: 0 })
    const futureReport = await service.fetchReportTasks(now + 1, now + 1000, 'ALL')
    expect(futureReport.items.every(task => (task as typeof task & { rangeWorkMs: number }).rangeWorkMs === 0)).toBe(true)
    expect(getDb().prepare('SELECT * FROM work_sessions ORDER BY id').all()).toEqual(beforeSessions)
  } finally { Date.now = actualNow }
})

test('migration probe: legacy Task fields and an open work session survive first upgrade and the generated backup', () => {
  closeDb()
  fs.rmSync(process.env.CHRONICLE_DB_PATH!, { force: true })
  const old = new Database(process.env.CHRONICLE_DB_PATH!)
  old.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,priority TEXT NOT NULL,tags TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER,due_date INTEGER);
    CREATE TABLE work_sessions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,FOREIGN KEY(task_id) REFERENCES tasks(id));
    INSERT INTO tasks VALUES('T0000000001','legacy running task','TODO','HIGH','["legacy"]','DOING',1000,2000,3000,NULL,9000);
    INSERT INTO work_sessions VALUES('legacy-open-session','T0000000001',3000,NULL);`)
  const originalTask = old.prepare('SELECT * FROM tasks').get()
  const originalSession = old.prepare('SELECT * FROM work_sessions').get()
  old.close()

  initDb()
  expectProjectTaskCascade()
  const taskProjection = 'id,title,type,priority,tags,status,created_at,updated_at,started_at,completed_at,due_date'
  expect(getDb().prepare(`SELECT ${taskProjection} FROM tasks`).get()).toEqual(originalTask)
  expect(getDb().prepare('SELECT * FROM work_sessions').get()).toEqual(originalSession)
  expect(getCurrentSession()).toEqual({ id: 'legacy-open-session', taskId: 'T0000000001', startedAt: 3000, endedAt: null })
  expect(getTaskById('T0000000001')).toMatchObject({ primaryMilestoneId: null, projectRevision: 1 })

  const backups = fs.readdirSync(dir).filter(file => file.includes('.before-projects-'))
  expect(backups).toHaveLength(1)
  const backup = new Database(path.join(dir, backups[0]), { readonly: true })
  try {
    expect(backup.prepare(`SELECT ${taskProjection} FROM tasks`).get()).toEqual(originalTask)
    expect(backup.prepare('SELECT * FROM work_sessions').get()).toEqual(originalSession)
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='areas'").get()).toBeUndefined()
  } finally { backup.close() }
  closeDb()
  initDb()
  expect(getDb().prepare(`SELECT ${taskProjection} FROM tasks`).get()).toEqual(originalTask)
  expect(getDb().prepare('SELECT * FROM work_sessions').get()).toEqual(originalSession)
  expect(fs.readdirSync(dir).filter(file => file.includes('.before-projects-'))).toHaveLength(1)
  expect(getDb().pragma('foreign_key_check')).toEqual([])
})
