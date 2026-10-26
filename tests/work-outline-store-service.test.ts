import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { initDb, closeDb, getDb } from '../server/src/db'
import { createTaskInOutline, getWorkOutline, saveWorkOutline, rotateWorkOutlineEpoch } from '../server/src/services/workOutlineService'
import type { OutlineDocument, OutlineLine } from '../shared/workOutlineTypes'
import { translations } from '../web/src/i18n/translations'

const webRequire = createRequire(path.resolve('web/package.json'))
const ts = webRequire('typescript')
const compile = (name: string) => ts.transpileModule(fs.readFileSync(path.resolve(name), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const row = (id: string, text = id): OutlineLine => ({ type: 'outlineLine', attrs: { id, depth: 0 }, content: [{ type: 'text', text }] })
const doc = (...content: OutlineLine[]): OutlineDocument => ({ type: 'doc', schemaVersion: 1, content })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const creation = { title: 'A new linked task', type: 'TODO', priority: 'MEDIUM', tags: [], body: '' }
const calls = { saves: [] as any[][], creates: [] as any[][] }
const transport = async <T>(operation: () => T) => {
  try { return clone(operation()) }
  catch (error: any) { throw Object.assign(new Error(error.message), { response: { status: error.status, data: { error: error.message, code: error.code } } }) }
}
const api = {
  load: () => transport(() => getWorkOutline()),
  save: (id: string, document: OutlineDocument, expectedRevision: number, mutationId: string, expectedEpoch: string) => {
    calls.saves.push(clone([id, document, expectedRevision, mutationId, expectedEpoch]))
    return transport(() => saveWorkOutline(id, { document, expectedRevision, mutationId, expectedEpoch }))
  },
  createTask: (id: string, rowId: string, task: unknown, expectedRevision: number, idempotencyKey: string, expectedEpoch: string) => {
    calls.creates.push(clone([id, rowId, task, expectedRevision, idempotencyKey, expectedEpoch]))
    return transport(() => createTaskInOutline(id, rowId, { task, expectedRevision, idempotencyKey, expectedEpoch }))
  },
}

function harness(overrides: Partial<typeof api> = {}, values = new Map<string, string>()) {
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const environment = {
    console, crypto: { randomUUID },
    queueMicrotask,
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
    setTimeout: (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: (id: number) => timers.delete(id),
  }
  const helpers: Record<string, any> = {}
  vm.runInNewContext(compile('web/src/lib/workOutline.ts'), { ...environment, exports: helpers, require: webRequire })
  const exports: Record<string, any> = {}
  vm.runInNewContext(compile('web/src/stores/workOutlineStore.ts'), {
    ...environment, exports,
    require: (name: string) => name === '@/services/workOutlineApi'
      ? { workOutlineApi: { ...api, ...overrides }, outlineError: (error: any) => error.response?.data?.error || error.message }
      : name === '@/lib/workOutline' ? helpers
      : name === '@/i18n/runtime' ? { translateCurrent: (key: string) => translations[key]?.['zh-CN'] ?? key }
      : webRequire(name),
  }, { filename: 'workOutlineStore.ts' })
  return { store: exports.useWorkOutlineStore, pendingCreation: exports.pendingOutlineCreation, values, timers }
}

let directory: string
test.beforeEach(() => {
  const root = path.resolve('.dev-data'); fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'outline-store-'))
  Object.assign(process.env, { CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'), CHRONICLE_CONFIG_DIR: directory,
    CHRONICLE_CONFIG_PATH: path.join(directory, 'config.json'), CHRONICLE_LOG_DIR: directory, CHRONICLE_LOG_PATH: path.join(directory, 'test.log') })
  initDb()
  saveWorkOutline('default', { document: doc(row('a', 'Initial'), row('b', 'Other')), expectedRevision: getWorkOutline().revision, expectedEpoch: getWorkOutline().epoch, mutationId: randomUUID() })
  calls.saves.length = 0; calls.creates.length = 0
})
test.afterEach(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }) })

test('a lost PUT acknowledgement retries the same mutation before saving later input', async () => {
  let lost = true
  const h = harness({ save: async (...args) => {
    const result = await api.save(...args)
    if (lost) { lost = false; throw new Error('Connection lost after commit') }
    return result
  } })
  await h.store.getState().load()
  h.store.getState().edit(doc(row('a', 'First input'), row('b')))
  expect(await Promise.resolve(h.store.getState().save()).then(() => null, (error: Error) => error.message)).toContain('Connection lost')
  expect(h.store.getState().dirty).toBe(true)
  const first = getWorkOutline()
  h.store.getState().edit(doc(row('a', 'Later input'), row('b')))
  await h.store.getState().save()
  expect(calls.saves).toHaveLength(3)
  expect(calls.saves[1]).toEqual(calls.saves[0])
  expect(calls.saves[2][3]).not.toBe(calls.saves[0][3])
  expect(getWorkOutline().revision).toBe(first.revision + 1)
  expect(getWorkOutline().document).toEqual(doc(row('a', 'Later input'), row('b')))
  expect(h.store.getState()).toMatchObject({ dirty: false, status: 'saved' })
  expect(h.values.has('chronicle:work_outline:default')).toBe(false)
})

test('input made during a save is retained and drained in a second revision', async () => {
  const entered = deferred(), release = deferred()
  let hold = true
  const h = harness({ save: async (...args) => {
    const result = await api.save(...args)
    if (hold) { hold = false; entered.resolve(); await release.promise }
    return result
  } })
  await h.store.getState().load()
  h.store.getState().edit(doc(row('a', 'In flight'), row('b')))
  const flight = h.store.getState().save()
  await entered.promise
  const latest = doc(row('a', 'Keep typing'), row('b'), row('c', 'Added during save'))
  h.store.getState().edit(latest)
  release.resolve()
  await flight
  expect(getWorkOutline().document).toEqual(latest)
  expect(h.store.getState().document).toEqual(latest)
  expect(h.store.getState().dirty).toBe(false)
  expect(calls.saves).toHaveLength(2)
})

test('reloading an offline cached draft restores it and reuses its persisted save receipt', async () => {
  const h = harness({ save: async (...args) => { await api.save(...args); throw new Error('Lost response') } })
  await h.store.getState().load()
  h.store.getState().edit(doc(row('a', 'Persisted before disconnect'), row('b')))
  expect(await Promise.resolve(h.store.getState().save()).then(() => null, (error: Error) => error.message)).toContain('Lost response')
  const revision = getWorkOutline().revision
  const reloaded = harness({}, h.values)
  await reloaded.store.getState().load()
  reloaded.store.getState().edit(doc(row('a', 'Continued after reload'), row('b')))
  await reloaded.store.getState().save()
  expect(getWorkOutline().revision).toBe(revision + 1)
  expect(getWorkOutline().document.content[0].content?.[0]).toEqual({ type: 'text', text: 'Continued after reload' })
  expect(reloaded.store.getState().dirty).toBe(false)
})

test('a conflict retains local content and keep-local explicitly rebases it before saving', async () => {
  const first = harness(), second = harness()
  await Promise.all([first.store.getState().load(), second.store.getState().load()])
  const local = doc(row('a', 'My unresolved edit'), row('b'))
  first.store.getState().edit(local)
  second.store.getState().edit(doc(row('a', 'Other window'), row('b')))
  await second.store.getState().save()
  expect(await Promise.resolve(first.store.getState().save()).then(() => null, (error: Error) => error.message)).toContain('another window')
  expect(first.store.getState()).toMatchObject({ status: 'conflict', dirty: true, document: local })
  await first.store.getState().keepLocal()
  expect(getWorkOutline().document).toEqual(local)
  expect(first.store.getState()).toMatchObject({ status: 'saved', dirty: false, remote: null })
})

for (const action of ['move', 'delete'] as const) test(`a Task creation response follows row identity after a concurrent ${action}`, async () => {
  const entered = deferred(), release = deferred()
  const h = harness({ createTask: async (...args) => {
    const result = await api.createTask(...args)
    entered.resolve(); await release.promise
    return result
  } })
  await h.store.getState().load()
  const flight = h.store.getState().createLinkedTask('a', creation, randomUUID())
  await entered.promise
  h.store.getState().edit(action === 'move' ? doc(row('b'), row('a', 'Moved original')) : doc(row('b', 'Replacement at same index')))
  release.resolve()
  const result = await flight
  await h.store.getState().save()
  expect(result.linked).toBe(action === 'move')
  const stored = getWorkOutline().document
  expect(stored.content.find(line => line.attrs.id === 'b')?.content?.some(n => n.type === 'taskRef')).toBe(false)
  if (action === 'move') expect(stored.content[1].content?.find(n => n.type === 'taskRef')).toMatchObject({ attrs: { taskId: result.task.id } })
  else expect(stored.content).toHaveLength(1)
  expect((getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get() as any).count).toBe(1)
})

test('a delayed remote refresh cannot roll back a newer acknowledged local save', async () => {
  const entered = deferred(), release = deferred()
  let delay = false
  const h = harness({ load: async () => {
    const snapshot = await api.load()
    if (delay) { entered.resolve(); await release.promise }
    return snapshot
  } })
  await h.store.getState().load()
  delay = true
  const refresh = h.store.getState().checkRemote()
  await entered.promise
  const latest = doc(row('a', 'Newer saved edit'), row('b'))
  h.store.getState().edit(latest)
  await h.store.getState().save()
  const revision = getWorkOutline().revision
  release.resolve()
  await refresh
  expect(h.store.getState().document).toEqual(latest)
  expect(h.store.getState().outline.revision).toBe(revision)
})

test('retrying a lost creation acknowledgement uses the same Task after a reload', async () => {
  const idempotencyKey = randomUUID()
  const h = harness({ createTask: async (...args) => { await api.createTask(...args); throw new Error('Lost creation response') } })
  await h.store.getState().load()
  expect(await Promise.resolve(h.store.getState().createLinkedTask('a', creation, idempotencyKey)).then(() => null, (error: Error) => error.message)).toContain('Lost creation response')
  expect(h.pendingCreation()).toMatchObject({ rowId: 'a', idempotencyKey })
  const reloaded = harness({}, h.values)
  await reloaded.store.getState().load()
  const result = await reloaded.store.getState().createLinkedTask('a', creation, idempotencyKey)
  expect(result.task.title).toBe(creation.title)
  expect((getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get() as any).count).toBe(1)
  expect(reloaded.pendingCreation()).toBeNull()
})

test('a different creation request cannot overwrite an uncertain Task receipt', async () => {
  const key = randomUUID()
  const h = harness({ createTask: async (...args) => { await api.createTask(...args); throw new Error('Lost creation response') } })
  await h.store.getState().load()
  expect(await Promise.resolve(h.store.getState().createLinkedTask('a', creation, key)).then(() => null, (error: Error) => error.message)).toContain('Lost creation response')
  expect(await Promise.resolve(h.store.getState().createLinkedTask('b', { ...creation, title: 'Other' }, randomUUID())).then(() => null, (error: Error) => error.message)).toContain('请先恢复')
  expect(h.pendingCreation()).toMatchObject({ rowId: 'a', idempotencyKey: key })
  expect(calls.creates).toHaveLength(1)
})

test('a replaced database with the same revision conflicts even when no import event arrives', async () => {
  const h = harness()
  await h.store.getState().load()
  const initial = getWorkOutline()
  const imported = doc(row('a', 'Imported content'), row('b'))
  getDb().prepare('UPDATE work_outlines SET document_json=? WHERE id=?').run(JSON.stringify(imported), 'default')
  rotateWorkOutlineEpoch()
  expect(getWorkOutline().revision).toBe(initial.revision)
  const local = doc(row('a', 'Old window edited'), row('b'))
  h.store.getState().edit(local)
  expect(await Promise.resolve(h.store.getState().save()).then(() => null, (error: Error) => error.message)).toContain('Database has been replaced')
  expect(getWorkOutline().document).toEqual(imported)
  expect(h.store.getState()).toMatchObject({ status: 'conflict', document: local, dirty: true })
  await h.store.getState().reloadRemote()
  expect(h.store.getState().document).toEqual(imported)
})

test('a replaced database is refreshed at equal revision and never replays old cached receipts', async () => {
  const h = harness({ save: async (...args) => { await api.save(...args); throw new Error('Lost response') } })
  await h.store.getState().load()
  const local = doc(row('a', 'Uncertain old write'), row('b'))
  h.store.getState().edit(local)
  expect(await Promise.resolve(h.store.getState().save()).then(() => null, (error: Error) => error.message)).toContain('Lost response')
  const imported = doc(row('a', 'Imported content'), row('b'))
  getDb().prepare('UPDATE work_outlines SET document_json=? WHERE id=?').run(JSON.stringify(imported), 'default')
  rotateWorkOutlineEpoch()
  const reloaded = harness({}, h.values)
  await reloaded.store.getState().load()
  expect(reloaded.store.getState()).toMatchObject({ status: 'conflict', document: local, dirty: true })
  const callsBefore = calls.saves.length
  expect(await Promise.resolve(reloaded.store.getState().save()).then(() => null, (error: Error) => error.message)).toContain('版本冲突')
  expect(calls.saves).toHaveLength(callsBefore)
  await reloaded.store.getState().reloadRemote()
  const second = doc(row('a', 'Second replacement'), row('b'))
  getDb().prepare('UPDATE work_outlines SET document_json=? WHERE id=?').run(JSON.stringify(second), 'default')
  rotateWorkOutlineEpoch()
  await reloaded.store.getState().checkRemote()
  expect(reloaded.store.getState()).toMatchObject({ status: 'saved', document: second, dirty: false })
})

test('abandoning an unconfirmed creation resumes autosave; a creation the server did complete surfaces from the server', async () => {
  const key = randomUUID()
  const h = harness({ createTask: async (...args) => { await api.createTask(...args); throw new Error('Lost creation response') } })
  await h.store.getState().load()
  await Promise.resolve(h.store.getState().createLinkedTask('a', creation, key)).catch(() => null)
  expect(h.pendingCreation()).toMatchObject({ rowId: 'a', idempotencyKey: key })
  h.store.getState().abandonCreation()
  expect(h.pendingCreation()).toBeNull()
  for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve))
  const state = h.store.getState()
  expect(state.status).toBe('saved')
  expect(state.outline.revision).toBe(getWorkOutline().revision)
  expect(state.document.content[0].content.some((node: any) => node.type === 'taskRef')).toBeTruthy()
})

test('after abandoning a creation the server never saw, edits made meanwhile are saved', async () => {
  const h = harness({ createTask: async () => { throw Object.assign(new Error('Server unavailable'), { response: { status: 503 } }) } })
  await h.store.getState().load()
  await Promise.resolve(h.store.getState().createLinkedTask('a', creation, randomUUID())).catch(() => null)
  expect(h.pendingCreation()).not.toBeNull()
  h.store.getState().edit(doc(row('a', 'Edited while paused'), row('b', 'Other')))
  await h.store.getState().save()
  expect(calls.saves).toHaveLength(0)
  h.store.getState().abandonCreation()
  await h.store.getState().save()
  expect(calls.saves).toHaveLength(1)
  expect(getWorkOutline().document.content[0].content).toEqual([{ type: 'text', text: 'Edited while paused' }])
  expect(h.store.getState().status).toBe('saved')
})
