import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { initDb, closeDb, getDb } from '../server/src/db'
import { createTask, createTaskEntry, deleteTask, getTaskById } from '../server/src/services/taskService'
import { createTaskInOutline, getWorkOutline, saveWorkOutline } from '../server/src/services/workOutlineService'
import type { OutlineDocument, OutlineLine } from '../shared/workOutlineTypes'
import { workOutlineRoutes } from '../server/src/workOutlineRoutes'
import { app } from '../server/src/app'
import { startTaskDailySummaryScheduler, stopTaskDailySummaryScheduler, isTaskDailySummarySchedulerRunning } from '../server/src/services/taskDailySummaryWorker'

const Database = createRequire(path.resolve('server/package.json'))('better-sqlite3')

let directory: string
test.beforeEach(() => {
  const root = path.resolve('.dev-data'); fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'outline-storage-'))
  Object.assign(process.env, { CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'), CHRONICLE_CONFIG_DIR: directory, CHRONICLE_CONFIG_PATH: path.join(directory, 'config.json'), CHRONICLE_LOG_DIR: directory, CHRONICLE_LOG_PATH: path.join(directory, 'test.log'), CHRONICLE_ATTACHMENT_DIR: path.join(directory, 'attachments') })
  initDb()
})
test.afterEach(async () => { await stopTaskDailySummaryScheduler(); closeDb(); fs.rmSync(directory, { recursive: true, force: true }) })
const row = (id: string, depth = 0, taskId?: string): OutlineLine => ({ type: 'outlineLine', attrs: { id, depth }, content: [{ type: 'text', text: id }, ...taskId ? [{ type: 'taskRef' as const, attrs: { taskId, label: 'Task' } }] : []] })
const doc = (...content: OutlineLine[]): OutlineDocument => ({ type: 'doc', schemaVersion: 1, content })
const save = (document: OutlineDocument, expectedRevision = getWorkOutline().revision, mutationId = randomUUID()) => saveWorkOutline('default', { expectedRevision, expectedEpoch: getWorkOutline().epoch, mutationId, document })

test('outline lazily initializes and persists ordered deep hierarchy without a Task', () => {
  const initial = getWorkOutline()
  expect(getWorkOutline()).toEqual(initial)
  const document = doc(...Array.from({ length: 120 }, (_, i) => row(`row-${i}`, i)))
  const result = save(document)
  expect(result.revision).toBe(2)
  closeDb(); initDb()
  expect(getWorkOutline().document).toEqual(document)
})
test('single-use save receipt replays even after a later save; reuse with new content and stale revisions fail', () => {
  const first = { expectedRevision: 1, expectedEpoch: getWorkOutline().epoch, mutationId: 'first', document: doc(row('a')) }
  const result = saveWorkOutline('default', first)
  save(doc(row('b')))
  expect(saveWorkOutline('default', first)).toEqual(result)
  expect(() => saveWorkOutline('default', { ...first, document: doc(row('c')) })).toThrow(/already been used/)
  expect(() => save(doc(row('c')), 1)).toThrow(/another window/)
  expect(getWorkOutline().document.content[0].attrs.id).toBe('b')
})
test('document validation rejects hierarchy jumps, duplicate identity, executable/unsupported nodes and multiple refs', () => {
  const task = createTask({ title: 'valid', type: 'TODO', priority: 'MEDIUM' })
  const many = row('one', 0, task.id); many.content!.push({ type: 'taskRef', attrs: { taskId: task.id, label: 'again' } })
  const invalid: unknown[] = [doc(row('a', 1)), doc(row('a'), row('b', 2)), doc(row('a'), row('a')), doc(many), doc({ ...row('script'), content: [{ type: 'html', text: '<script>' }] as any }), doc({ ...row('break'), content: [{ type: 'text', text: 'line\nline' }] })]
  for (const document of invalid) expect(() => save(document as OutlineDocument)).toThrow()
  expect(getWorkOutline().revision).toBe(1)
})
test('deleting outline placement retains Task, logs, sessions and independently stored daily summaries', () => {
  const task = createTask({ title: 'preserve', type: 'TODO', priority: 'MEDIUM' })
  const entry = createTaskEntry(task.id, 'historical work', 'log')
  getDb().prepare('INSERT INTO work_sessions VALUES(?,?,?,?)').run('session', task.id, 100, 200)
  getDb().prepare(`INSERT INTO task_daily_summaries(id,task_id,work_date,calendar_policy_id,period_start,period_end,summary_text,content_kind,input_fingerprint,evidence_json,prompt_version,generated_at)
    VALUES('summary',?,'2020-01-01','fixture',100,200,'Historical result','llm','fixture','[]','fixture',200)`).run(task.id)
  save(doc(row('linked', 0, task.id)))
  save(doc(row('replacement')))
  expect(getTaskById(task.id)).toBeTruthy()
  expect(getDb().prepare('SELECT id FROM task_entries WHERE id=?').get(entry.id)).toBeTruthy()
  expect(getDb().prepare('SELECT id FROM work_sessions WHERE id=?').get('session')).toBeTruthy()
  expect(getDb().prepare("SELECT summary_text FROM task_daily_summaries WHERE id='summary'").get()).toEqual({ summary_text: 'Historical result' })
})
test('retained dangling refs can be saved while newly forged or copied missing refs cannot', () => {
  const task = createTask({ title: 'delete independently', type: 'TODO', priority: 'MEDIUM' })
  save(doc(row('linked', 0, task.id)))
  deleteTask(task.id)
  expect(() => save(doc(row('linked', 0, task.id), row('new text')))).not.toThrow()
  expect(() => save(doc(row('other-id', 0, task.id)))).toThrow(/does not exist/)
})
test('atomic creation binds stable row, remains pending, creates only once across duplicate requests', () => {
  save(doc(row('root'), row('child', 1)))
  const input = { expectedRevision: 2, expectedEpoch: getWorkOutline().epoch, idempotencyKey: 'create-1', task: { title: 'New task', body: '<p>Description</p>' } }
  const result = createTaskInOutline('default', 'child', input)
  expect(result.task.status).toBe('PENDING')
  expect(result.bindingPatch.rowId).toBe('child')
  expect(createTaskInOutline('default', 'child', input)).toEqual(result)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM work_sessions').get()).toEqual({ n: 0 })
  expect(getWorkOutline().document.content[1].content?.at(-1)).toEqual({ type: 'taskRef', attrs: { taskId: result.task.id, label: result.task.title } })
})
test('missing, linked, stale, invalid and reused-key creation fails before allocating Task', () => {
  save(doc(row('row')))
  const input = { expectedRevision: 2, expectedEpoch: getWorkOutline().epoch, idempotencyKey: 'create', task: { title: 'Valid' } }
  expect(() => createTaskInOutline('default', 'missing', input)).toThrow(/no longer exists/)
  expect(() => createTaskInOutline('default', 'row', { ...input, expectedRevision: 1 })).toThrow(/another window/)
  expect(() => createTaskInOutline('default', 'row', { ...input, task: { title: '' } })).toThrow(/title/)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
  createTaskInOutline('default', 'row', input)
  expect(() => createTaskInOutline('default', 'row', { ...input, task: { title: 'Other' } })).toThrow(/already been used/)
  expect(() => createTaskInOutline('default', 'row', { ...input, expectedRevision: 3, idempotencyKey: 'new' })).toThrow(/already references/)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
})
test('database failure rolls back Task, binding and receipt together', () => {
  save(doc(row('row')))
  getDb().exec("CREATE TRIGGER fail_outline BEFORE UPDATE ON work_outlines BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  expect(() => createTaskInOutline('default', 'row', { expectedRevision: 2, expectedEpoch: getWorkOutline().epoch, idempotencyKey: 'atomic', task: { title: 'rollback' } })).toThrow(/fixture failure/)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
  expect(getWorkOutline().revision).toBe(2)
  expect(getDb().prepare("SELECT * FROM work_outline_requests WHERE request_key='atomic'").get()).toBeUndefined()
})
test('HTTP boundary returns structured errors and idempotent successful responses', async () => {
  const initial = await (await workOutlineRoutes.request('/work-outlines/default')).json()
  const response = await workOutlineRoutes.request('/work-outlines/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: initial.revision, expectedEpoch: initial.epoch, mutationId: 'http', document: doc(row('http')) }) })
  expect(response.status).toBe(200)
  const bad = await workOutlineRoutes.request('/work-outlines/default', { method: 'PUT', body: '{' })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toMatchObject({ code: 'INVALID_REQUEST' })
})

async function databaseSnapshot(document?: OutlineDocument, revision?: number): Promise<Buffer> {
  const snapshotPath = path.join(directory, `snapshot-${randomUUID()}.db`)
  await getDb().backup(snapshotPath)
  if (document) {
    const snapshot = new Database(snapshotPath)
    try { snapshot.prepare('UPDATE work_outlines SET document_json=?,revision=? WHERE id=?').run(JSON.stringify(document), revision, 'default') }
    finally { snapshot.close() }
  }
  return fs.readFileSync(snapshotPath)
}
async function importSnapshot(data: Buffer) {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }), 'snapshot.db')
  return app.request('/api/settings/import', { method: 'POST', body: form })
}
async function staleWrite(method: 'PUT' | 'POST', body: unknown) {
  const endpoint = method === 'PUT' ? '/work-outlines/default' : '/work-outlines/default/rows/row/task'
  const response = await workOutlineRoutes.request(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'OUTLINE_EPOCH_CONFLICT' })
}

for (const revisionKind of ['same', 'lower'] as const) test(`a ${revisionKind}-revision database import rejects old-window saves and creates even without SSE`, async () => {
  save(doc(row('row'), row('old local content')))
  const before = getWorkOutline()
  const importedDocument = doc(row('row'), row('imported authoritative content'))
  const importedRevision = before.revision - (revisionKind === 'lower' ? 1 : 0)
  const snapshot = await databaseSnapshot(importedDocument, importedRevision)
  const imported = await importSnapshot(snapshot)
  expect(imported.status, await imported.text()).toBe(200)
  // No SSE listener and no refreshed GET are needed for server-side protection.
  await staleWrite('PUT', { expectedEpoch: before.epoch, expectedRevision: before.revision, mutationId: 'offline-save', document: doc(row('row'), row('stale overwrite')) })
  await staleWrite('POST', { expectedEpoch: before.epoch, expectedRevision: before.revision, idempotencyKey: 'offline-create', task: { title: 'Must not be created' } })
  const current = getWorkOutline()
  expect(current.epoch).not.toBe(before.epoch)
  expect(current.document).toEqual(importedDocument)
  expect(current.revision).toBe(importedRevision)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
})

test('import rotates a copied epoch on every success, preserves it on restart, and keeps it on failed import', async () => {
  save(doc(row('row')))
  const original = getWorkOutline().epoch
  const snapshot = await databaseSnapshot()
  expect((await importSnapshot(snapshot)).status).toBe(200)
  const first = getWorkOutline().epoch
  expect(first).not.toBe(original)
  closeDb(); initDb()
  expect(getWorkOutline().epoch).toBe(first)
  expect((await importSnapshot(snapshot)).status).toBe(200)
  const second = getWorkOutline().epoch
  expect(second).not.toBe(first)
  expect(second).not.toBe(original)
  expect((await importSnapshot(Buffer.from('not a database'))).status).toBe(400)
  expect(getWorkOutline().epoch).toBe(second)
  const current = getWorkOutline()
  await staleWrite('PUT', { expectedRevision: current.revision, mutationId: 'missing-epoch', document: doc(row('row')) })
  await staleWrite('POST', { expectedRevision: current.revision, idempotencyKey: 'missing-epoch-create', task: { title: 'Missing epoch' } })
})

test('old-epoch save and create receipts copied in a backup cannot acknowledge stale retries after import', async () => {
  const initial = getWorkOutline()
  const saveRequest = { expectedEpoch: initial.epoch, expectedRevision: initial.revision, mutationId: 'lost-save', document: doc(row('row')) }
  saveWorkOutline('default', saveRequest)
  const createRequest = { expectedEpoch: initial.epoch, expectedRevision: getWorkOutline().revision, idempotencyKey: 'lost-create', task: { title: 'Only one committed Task' } }
  const created = createTaskInOutline('default', 'row', createRequest)
  const snapshot = await databaseSnapshot()
  expect((await importSnapshot(snapshot)).status).toBe(200)
  const current = getWorkOutline()
  await staleWrite('PUT', saveRequest)
  await staleWrite('POST', createRequest)
  expect(getWorkOutline()).toEqual(current)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  expect(getTaskById(created.task.id)?.title).toBe('Only one committed Task')
})

test('concurrent parsed imports cannot steal or prematurely release the database maintenance lock', async () => {
  save(doc(row('row')))
  const epochBefore = getWorkOutline().epoch
  const snapshot = await databaseSnapshot()
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
  function pausedUpload() {
    const entered = deferred(), release = deferred()
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(snapshot)]), 'snapshot.db')
    const request = new Request('http://localhost/api/settings/import', { method: 'POST', body: form })
    const parse = request.formData.bind(request)
    // Pause only these fixture uploads after the handler's initial guard.
    request.formData = async () => { entered.resolve(); await release.promise; return parse() }
    return { request, entered, release }
  }
  const first = pausedUpload(), second = pausedUpload()
  const backupEntered = deferred(), releaseBackup = deferred()
  const database = getDb(), originalBackup = database.backup
  let backups = 0
  database.backup = async (...args: Parameters<typeof database.backup>) => {
    backups++; backupEntered.resolve(); await releaseBackup.promise
    return originalBackup.apply(database, args)
  }
  startTaskDailySummaryScheduler()
  let secondResult: Response | undefined
  const firstFlight = Promise.resolve(app.request(first.request))
  const secondFlight = Promise.resolve(app.request(second.request)).then(response => { secondResult = response; return response })
  try {
    await Promise.all([first.entered.promise, second.entered.promise])
    first.release.resolve()
    await backupEntered.promise
    expect(isTaskDailySummarySchedulerRunning()).toBe(false)
    second.release.resolve()
    await expect.poll(() => secondResult?.status).toBe(503)
    expect(backups).toBe(1)
    expect((await app.request('/api/work-outlines/default')).status).toBe(503)
    expect(isTaskDailySummarySchedulerRunning()).toBe(false)
    releaseBackup.resolve()
    expect((await firstFlight).status).toBe(200)
    expect((await app.request('/api/work-outlines/default')).status).toBe(200)
    expect(isTaskDailySummarySchedulerRunning()).toBe(true)
    expect(getWorkOutline().epoch).not.toBe(epochBefore)
  } finally {
    first.release.resolve(); second.release.resolve(); releaseBackup.resolve()
    await Promise.allSettled([firstFlight, secondFlight])
    database.backup = originalBackup
    await stopTaskDailySummaryScheduler()
  }
})
