import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const webRequire = createRequire(path.resolve('web/package.json'))
const ts = webRequire('typescript')
const source = fs.readFileSync(path.resolve('web/src/stores/taskStore.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const draftKey = 'chronicle:task_draft'
const idKey = 'chronicle:task_draft_id'
const draft = { title: 'A normal task', body: '<p>Keep this draft</p>', type: 'TODO', priority: 'MEDIUM', tags: [], dueDate: null }
const task = { id: 'T0000000001', ...draft, status: 'PENDING', createdAt: 1, updatedAt: 1, startedAt: null, completedAt: null, primaryMilestoneId: null, projectRevision: 1 }

function harness(options: { values?: Record<string, string>; fail?: (operation: string, key: string) => boolean; api?: Record<string, unknown> } = {}) {
  const values = new Map(Object.entries(options.values || {}))
  const accesses: Array<{ operation: string; key: string }> = []
  const access = (operation: string, key: string) => {
    accesses.push({ operation, key })
    if (options.fail?.(operation, key)) throw new Error(`Draft cache ${operation} unavailable`)
  }
  const localStorage = {
    getItem(key: string) { access('get', key); return values.get(key) ?? null },
    setItem(key: string, value: string) { access('set', key); values.set(key, value) },
    removeItem(key: string) { access('remove', key); values.delete(key) },
  }
  const exported: Record<string, any> = {}
  // Exercise the actual store in an isolated realm with its real Zustand
  // subscription implementation; only the HTTP boundary and cache are fakes.
  vm.runInNewContext(compiled, {
    exports: exported,
    require: (name: string) => name === '@/services/api' ? options.api || {} : webRequire(name),
    localStorage, console,
  }, { filename: 'taskStore.ts' })
  return { store: exported.useTaskStore, values, accesses }
}

test('blocked draft-cache reads preserve ordinary store startup and tolerate a missing reservation', () => {
  const unavailable = harness({ fail: () => true })
  expect(unavailable.store.getState().draftTask).toBeNull()
  expect(unavailable.store.getState().activeTaskId).toBeNull()

  const partial = harness({ values: { [draftKey]: JSON.stringify(draft) }, fail: (operation, key) => operation === 'get' && key === idKey })
  expect(partial.store.getState().draftTask.title).toBe(draft.title)
  expect(partial.store.getState().draftTaskId).toBeNull()
})

test('draft write failures do not interrupt store listeners or cause unrelated session updates to access the cache', () => {
  const { store, accesses } = harness({ fail: operation => operation === 'set' })
  const observed: string[] = []
  store.subscribe((state: any) => observed.push(state.draftTask?.title ?? 'none'))
  expect(() => store.getState().startDraft(draft)).not.toThrow()
  expect(() => store.setState({ draftTaskId: task.id })).not.toThrow()
  expect(store.getState().draftTask.title).toBe(draft.title)
  expect(observed).toEqual([draft.title, draft.title])
  accesses.length = 0
  store.setState({ currentSession: { id: 'session', taskId: task.id, startedAt: 1, endedAt: null } })
  store.setState({ currentSession: null })
  expect(accesses).toEqual([])
  expect(observed).toHaveLength(4)
})

test('failed draft-cache deletion cannot interrupt successful ordinary creation or cancellation', async () => {
  const sent: any[] = []
  const { store } = harness({
    fail: operation => operation === 'remove',
    api: { createTask: async (request: any) => { sent.push(request); return task }, fetchTaskEntries: async () => [{ id: 'body', taskId: task.id, content: draft.body }] },
  })
  store.getState().startDraft({ ...draft, primaryMilestoneId: null, projectReferences: [] })
  store.setState({ draftTaskId: task.id })
  await store.getState().commitDraft()
  expect(sent).toHaveLength(1)
  expect(sent[0]).not.toHaveProperty('primaryMilestoneId')
  expect(sent[0]).not.toHaveProperty('references')
  expect(store.getState().draftTask).toBeNull()
  expect(store.getState().draftTaskId).toBeNull()
  expect(store.getState().activeTaskId).toBe(task.id)
  expect(store.getState().entries).toHaveLength(1)
  store.getState().startDraft(draft)
  expect(() => store.getState().cancelDraft()).not.toThrow()
  expect(store.getState().draftTask).toBeNull()
})

test('nonempty project assignments remain in the atomic task request and a failed request preserves the draft', async () => {
  const references = [{ targetType: 'area', targetId: 'A-growth', role: 'growth' }]
  const sent: any[] = []
  let reject = true
  const { store } = harness({ api: {
    createTask: async (request: any) => { sent.push(request); if (reject) throw new Error('Request failed'); return task },
    fetchTaskEntries: async () => [],
  } })
  store.getState().startDraft({ ...draft, primaryMilestoneId: 'M-stage', projectReferences: references })
  const failure = await store.getState().commitDraft().then(() => null, (error: Error) => error.message)
  expect(failure).toBe('Request failed')
  expect(store.getState().draftTask.primaryMilestoneId).toBe('M-stage')
  expect(store.getState().draftTask.projectReferences).toEqual(references)
  reject = false
  await store.getState().commitDraft()
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({ primaryMilestoneId: 'M-stage', references })
  expect(store.getState().draftTask).toBeNull()
})

test('draft-cache errors cannot split takeover, automatic task switching, or stopping from their client state', async () => {
  const calls: string[] = []
  const session = { id: 'new-session', taskId: task.id, startedAt: 100, endedAt: null }
  const { store } = harness({
    fail: (operation, key) => key.startsWith('chronicle:task_draft') && operation !== 'get',
    api: {
      takeOverTask: async () => { calls.push('takeover'); return session },
      getTaskById: async () => ({ ...task, status: 'DOING' }),
      doAfk: async () => { calls.push('afk'); return { currentSession: null, endedSession: { ...session, endedAt: 200 } } },
    },
  })
  store.getState().startDraft(draft)
  store.setState({ draftTaskId: task.id })
  await store.getState().takeOver(task.id)
  expect(store.getState().currentSession).toEqual(session)
  store.setState({ currentSession: { ...session, taskId: 'T-other' } })
  await store.getState().autoTakeOver(task.id)
  expect(calls).toEqual(['takeover', 'afk', 'takeover'])
  expect(store.getState().currentSession).toEqual(session)
  await store.getState().doAfk()
  expect(store.getState().currentSession).toBeNull()
  expect(store.getState().lastAfkTime).toBe(200)
})
