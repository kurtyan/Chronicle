import type { APIRequestContext } from '@playwright/test'
import { test, expect, inProcess } from './helpers/projectFixtures'

test.use({ locale: 'zh-CN' })
import { createRequire } from 'node:module'
import path from 'node:path'

const requireServer = createRequire(path.resolve('server/package.json'))
const Database = requireServer('better-sqlite3')
const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
async function post(request: APIRequestContext, url: string, data: unknown) {
  const response = await request.post(url, { data })
  expect(response.ok(), `${url}: ${await response.text()}`).toBeTruthy()
  return response.json()
}
async function get(request: APIRequestContext, url: string) {
  const response = await request.get(url)
  expect(response.ok(), `${url}: ${await response.text()}`).toBeTruthy()
  return response.json()
}
async function setup(request: APIRequestContext) {
  const area = await post(request, '/api/areas', { name: unique('业务方向') })
  const growth = await post(request, '/api/areas', { name: unique('职业成长') })
  const milestone = await post(request, '/api/milestones', { areaId: area.id, name: unique('交付目标'), completionCriteria: '验证成果' })
  const ongoing = await post(request, '/api/milestones', { areaId: growth.id, name: unique('分析能力'), kind: 'ongoing' })
  const task = await post(request, '/api/tasks', { title: unique('实际工作'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
  return { area, growth, milestone, ongoing, task }
}
function record(taskId: string, start: number, end: number | null) {
  const directory = process.env.CHRONICLE_TEST_DATA_DIR
  if (!directory) throw new Error('This test requires its isolated project-test database')
  const db = new Database(path.join(directory, 'tasks.db'))
  try { db.prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(unique('session'), taskId, start, end) }
  finally { db.close() }
}

test('HTTP objects, typed backlinks, rename and statistical conservation', async ({ request }) => {
  const { area, growth, milestone, ongoing, task } = await setup(request)
  const note = await post(request, '/api/notes', { title: unique('复盘知识'), contentHtml: '<p>具体判断和实践。</p>' })
  const start = Date.now() - 7_200_000, end = start + 3_600_000
  record(task.id, start, end)
  const replaced = await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1,
    references: [{ targetType: 'milestone', targetId: milestone.id, role: 'outcome' }, { targetType: 'milestone', targetId: ongoing.id, role: 'growth' }, { targetType: 'area', targetId: area.id }] } })
  expect(replaced.ok(), await replaced.text()).toBeTruthy()
  const refs = await get(request, `/api/project-references?sourceType=note&sourceId=${note.id}`)
  expect(refs.references).toHaveLength(3)
  const backlinks = await get(request, `/api/project-references/backlinks?targetType=area&targetId=${area.id}`)
  expect(backlinks.notes.filter((n: any) => n.sourceId === note.id)).toHaveLength(1)
  const stats = await get(request, `/api/projects/statistics?start=${start}&end=${end}&asOf=${end}`)
  expect(stats.byMilestone.find((m: any) => m.id === milestone.id).totalMs).toBe(3_600_000)
  expect(stats.byArea.find((a: any) => a.id === growth.id)).toBeUndefined()
  expect(stats.byArea.reduce((sum: number, a: any) => sum + a.totalMs, stats.unassignedMs)).toBe(stats.totalMs)
  expect(stats.byMilestone.reduce((sum: number, m: any) => sum + m.totalMs, stats.unassignedMs)).toBe(stats.totalMs)
  const renamed = await request.patch(`/api/areas/${area.id}`, { data: { name: unique('重命名方向'), expectedRevision: area.revision } })
  expect(renamed.ok()).toBeTruthy()
  const latestArea = await renamed.json()
  const latestRefs = await get(request, `/api/project-references?sourceType=note&sourceId=${note.id}`)
  expect(latestRefs.references.find((r: any) => r.targetId === area.id).name).toBe(latestArea.name)
  const search = await get(request, `/api/search?q=${encodeURIComponent(latestArea.name)}&scope=all`)
  expect(search.results.areas.some((a: any) => a.id === area.id)).toBeTruthy()
})

test('legacy Task updates cannot bypass assignment preview; apply and undo remain atomic', async ({ request }) => {
  const { milestone, ongoing, task } = await setup(request)
  record(task.id, Date.now() - 60_000, Date.now() - 30_000)
  const blocked = await request.put(`/api/tasks/${task.id}`, { data: { primaryMilestoneId: ongoing.id, expectedProjectRevision: task.projectRevision } })
  expect(blocked.status()).toBe(409)
  expect((await get(request, `/api/tasks/${task.id}`)).primaryMilestoneId).toBe(milestone.id)
  const preview = await post(request, '/api/projects/assignments/preview', { changes: [{ taskId: task.id, primaryMilestoneId: ongoing.id, expectedRevision: task.projectRevision }] })
  const applied = await post(request, '/api/projects/assignments/apply', { token: preview.token })
  expect((await get(request, `/api/tasks/${task.id}`)).primaryMilestoneId).toBe(ongoing.id)
  expect((await request.post('/api/projects/assignments/apply', { data: { token: preview.token } })).status()).toBe(409)
  await post(request, '/api/projects/assignments/undo', { eventId: applied.eventId })
  expect((await get(request, `/api/tasks/${task.id}`)).primaryMilestoneId).toBe(milestone.id)
  const titleOnly = await request.put(`/api/tasks/${task.id}`, { data: { title: unique('仅改标题') } })
  expect(titleOnly.ok()).toBeTruthy()
  expect((await titleOnly.json()).primaryMilestoneId).toBe(milestone.id)
})

test('milestone completion and confirmed review versions are independent of Note roles', async ({ request }) => {
  const { milestone, task, ongoing } = await setup(request)
  await request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
  expect((await get(request, `/api/milestones/${milestone.id}`)).status).toBe('planned')
  expect((await request.patch(`/api/milestones/${milestone.id}`, { data: { expectedRevision: 1, status: 'completed' } })).status()).toBe(409)
  const complete = await request.patch(`/api/milestones/${milestone.id}`, { data: { expectedRevision: 1, status: 'completed', confirmCompletion: true } })
  expect(complete.ok()).toBeTruthy()
  expect((await get(request, `/api/milestones/${milestone.id}`)).reviewStatus).toBe('pending')
  const review = await post(request, '/api/project-reviews', { targetType: 'milestone', targetId: milestone.id, kind: 'completion', contentHtml: '<p>先验证假设，再决定方案。</p>' })
  const note = await get(request, `/api/notes/${review.noteId}`)
  expect((await get(request, `/api/milestones/${milestone.id}`)).reviewStatus).toBe('pending')
  const confirmed = await post(request, `/api/project-reviews/${review.id}/confirm`, { expectedNoteRevision: note.revision })
  expect(confirmed.versions).toHaveLength(1)
  expect((await get(request, `/api/milestones/${milestone.id}`)).reviewStatus).toBe('confirmed')
  await request.put(`/api/notes/${note.id}`, { data: { expectedRevision: note.revision, contentHtml: '<p>新的认识，尚未再次确认。</p>' } })
  const updated = await get(request, `/api/project-reviews/${review.id}`)
  expect(updated.noteChangedSinceConfirmation).toBe(true)
  expect(updated.versions[0].contentHtml).toContain('先验证假设')
  const refs = await get(request, `/api/project-references?sourceType=note&sourceId=${note.id}`)
  await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: refs.projectRevision, references: [] } })
  expect((await get(request, `/api/milestones/${milestone.id}`)).reviewStatus).toBe('confirmed')
  const deleted = await request.delete(`/api/notes/${note.id}`)
  expect(deleted.ok()).toBeTruthy()
  expect((await get(request, `/api/project-reviews/${review.id}`)).versions[0].contentHtml).toContain('先验证假设')
  expect((await request.patch(`/api/milestones/${ongoing.id}`, { data: { expectedRevision: 1, status: 'completed', confirmCompletion: true } })).status()).toBe(400)
})

test('backup import retains typed references, review evidence and indexed objects', async ({ request }) => {
  const { area, ongoing } = await setup(request)
  const review = await post(request, '/api/project-reviews', { targetType: 'milestone', targetId: ongoing.id, kind: 'periodic', contentHtml: '<p>已验证的方法与适用边界。</p>' })
  const note = await get(request, `/api/notes/${review.noteId}`)
  await post(request, `/api/project-reviews/${review.id}/confirm`, { expectedNoteRevision: note.revision })
  const backup = await request.get('/api/settings/export')
  expect(backup.ok()).toBeTruthy()
  const bytes = await backup.body()
  const imported = await request.post('/api/settings/import', { multipart: { file: { name: 'project-roundtrip.zip', mimeType: 'application/zip', buffer: bytes } } })
  expect(imported.ok(), await imported.text()).toBeTruthy()
  expect((await get(request, `/api/project-reviews/${review.id}`)).versions[0].evidence.sources.length).toBeGreaterThan(0)
  expect((await get(request, `/api/project-references?sourceType=note&sourceId=${note.id}`)).references.some((r: any) => r.targetId === ongoing.id)).toBe(true)
  expect((await get(request, `/api/areas/${area.id}`)).id).toBe(area.id)
})

test('MCP discovers and uses the same Area and primary milestone model', async ({ request }) => {
  await get(request, '/api/version')
  const { Client } = requireServer('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = requireServer('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'project-integration', version: '1.0.0' })
  try {
    if (inProcess) {
      const { InMemoryTransport } = requireServer('@modelcontextprotocol/sdk/inMemory.js')
      const { createMcpServer } = require('../server/src/mcp/start')
      const { AppService } = require('../server/src/services/appService')
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const server = createMcpServer(new AppService())
      await server.connect(serverTransport)
      await client.connect(clientTransport)
    } else await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.CHRONICLE_TEST_MCP_PORT}/mcp`)))
    const listed = await client.listTools()
    expect(listed.tools.some((tool: any) => tool.name === 'preview_project_assignment')).toBe(true)
    const created = await client.callTool({ name: 'create_area', arguments: { name: unique('MCP Area') } })
    expect(created.isError).not.toBe(true)
    const area = JSON.parse(created.content[0].text)
    const detail = await client.callTool({ name: 'get_project', arguments: { targetType: 'area', targetId: area.id } })
    expect(JSON.parse(detail.content[0].text).name).toBe(area.name)
    const milestoneResult = await client.callTool({ name: 'create_milestone', arguments: { areaId: area.id, name: unique('MCP里程碑') } })
    expect(milestoneResult.isError).not.toBe(true)
    const milestone = JSON.parse(milestoneResult.content[0].text)
    const taskResult = await client.callTool({ name: 'create_task', arguments: { title: unique('MCP任务'), primaryMilestoneId: milestone.id,
      references: [{ targetType: 'area', targetId: area.id, role: 'related' }] } })
    expect(taskResult.isError).not.toBe(true)
    const task = JSON.parse(taskResult.content[0].text)
    expect((await get(request, `/api/tasks/${task.id}`)).primaryMilestoneId).toBe(milestone.id)
    expect((await get(request, `/api/project-references?sourceType=task&sourceId=${task.id}`)).references[0].targetId).toBe(area.id)
    const stale = await client.callTool({ name: 'update_area', arguments: { id: area.id, expectedRevision: 99, name: '不能覆盖' } })
    expect(stale.isError).toBe(true)
    expect((await get(request, `/api/areas/${area.id}`)).name).toBe(area.name)
  } finally { await client.close() }
})

test('project page creates an Area and opens a stage milestone with navigable references', async ({ page, request }) => {
  const { milestone, task } = await setup(request)
  await page.goto('/projects')
  await expect(page.getByRole('heading', { name: '方向与里程碑' })).toBeVisible()
  await page.getByRole('button', { name: '新建方向', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const name = unique('界面创建方向')
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/areas')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const createdArea = await (await created).json()
  const panel = page.getByTestId('project-context-panel')
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/projects')
  expect(new URL(page.url()).searchParams.get('selected')).toBe(`area:${createdArea.id}`)
  expect((await get(request, `/api/areas/${createdArea.id}`)).name).toBe(name)
  await panel.getByRole('button', { name: '关闭详情', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await page.goto(`/projects/milestones/${milestone.id}`)
  await expect(page.getByRole('heading', { name: milestone.name, exact: true })).toBeVisible()
  await expect(page.getByTestId('project-object-tasks').getByText(task.title, { exact: true })).toBeVisible()
})

test('invalid project requests fail without mutations', async ({ request }) => {
  expect((await request.post('/api/areas', { data: null })).status()).toBe(400)
  expect((await request.post('/api/areas', { data: { name: '' } })).status()).toBe(400)
  expect((await request.get('/api/projects/statistics?start=NaN')).status()).toBe(400)
  expect((await request.get('/api/project-reviews/missing')).status()).toBe(404)
  for (const operation of ['cancel', 'retry', 'accept']) {
    expect((await request.post(`/api/project-insights/missing/${operation}`, { data: {} })).status()).toBe(404)
  }
  expect((await request.put('/api/project-references', { data: { sourceType: 'wrong', sourceId: 'missing', references: [] } })).status()).toBe(400)
})

test('Note content and typed relationships use independent conflict protection', async ({ request }) => {
  const { milestone } = await setup(request)
  const note = await post(request, '/api/notes', { title: unique('并发编辑'), contentHtml: '<p>原文</p>' })
  const relation = { sourceType: 'note', sourceId: note.id, expectedRevision: note.projectRevision,
    references: [{ targetType: 'milestone', targetId: milestone.id, role: 'growth' }] }
  expect((await request.put('/api/project-references', { data: relation })).ok()).toBe(true)
  expect((await get(request, `/api/notes/${note.id}`)).revision).toBe(note.revision)
  const saved = await request.put(`/api/notes/${note.id}`, { data: { expectedRevision: note.revision, contentHtml: '<p>已保存的新认识</p>' } })
  expect(saved.ok()).toBe(true)
  expect((await request.put('/api/project-references', { data: { ...relation, references: [] } })).status()).toBe(409)
  expect((await request.put(`/api/notes/${note.id}`, { data: { expectedRevision: note.revision, contentHtml: '<p>迟到的旧正文</p>' } })).status()).toBe(409)
  expect((await get(request, `/api/notes/${note.id}`)).contentHtml).toBe('<p>已保存的新认识</p>')
  expect((await get(request, `/api/project-references?sourceType=note&sourceId=${note.id}`)).references[0].targetId).toBe(milestone.id)
})

test('SSE promptly connects and exposes committed object and review changes to a second client', async ({ request, harness, baseURL }) => {
  const connection = new AbortController()
  const timer = setTimeout(() => connection.abort(), 1500)
  let response: Response
  try {
    response = inProcess
      ? await harness!.app.request('/api/events?clientId=project-observer')
      : await fetch(`${baseURL}/api/events?clientId=project-observer`, { signal: connection.signal })
  } finally { clearTimeout(timer) }
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader(), decoder = new TextDecoder(), events: string[] = []
  let firstFrameTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => { firstFrameTimeout = setTimeout(() => reject(new Error('SSE must send an initial frame without waiting for a work event')), 1500) }),
    ])
    expect(decoder.decode(first.value)).toContain('event: heartbeat')
  } catch (error) { await reader.cancel(); throw error }
  finally { clearTimeout(firstFrameTimeout) }
  const consume = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      events.push(decoder.decode(value))
    }
  })()
  try {
    const area = await post(request, '/api/areas', { name: unique('SSE方向') })
    await expect.poll(() => events.join('')).toContain(area.id)
    events.length = 0
    await post(request, '/api/project-reviews', { targetType: 'area', targetId: area.id, kind: 'periodic' })
    await expect.poll(() => events.join('')).toContain('"kind":"review"')
  } finally { await reader.cancel(); await consume }
})
