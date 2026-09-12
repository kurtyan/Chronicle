import { test, expect, type Page } from '@playwright/test'

// Regression gates for the failures reproduced in the rollout assessment.
// Each injected project failure must leave the original workflow usable.
// Run only with scripts/test-legacy-regression.mjs (fresh DB / unused ports).
const unique = (label: string) => `${label}-${Date.now()}`
async function seedTask(page: Page, title: string) {
  const response = await page.request.post('/api/tasks', { data: { title, type: 'TODO', priority: 'MEDIUM' } })
  expect(response.ok()).toBe(true)
  return response.json()
}
test.beforeEach(async ({ request }) => { await request.post('/api/afk') })

test('ordinary task creation, timing and log save work with project HTTP 500', async ({ page }) => {
  await page.route(/\/api\/(projects(?:\/|\?)|project-references)/, route => route.fulfill({ status: 500, json: { error: 'isolated project failure' } }))
  await page.goto('/?lang=zh-CN')
  await page.keyboard.press('Meta+n')
  const title = unique('HTTP500普通Task')
  await page.getByPlaceholder('输入任务标题...').fill(title)
  const createdResponse = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST')
  await page.getByPlaceholder('输入任务标题...').press('Meta+Enter')
  const response = await createdResponse
  expect(response.request().postDataJSON()).not.toHaveProperty('references')
  expect(response.request().postDataJSON()).not.toHaveProperty('primaryMilestoneId')
  const created = await response.json()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await page.getByTestId('workspace-info-bar').getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.getByTestId('workspace-info-bar')).toContainText('进行中')
  await page.locator('.ProseMirror').fill('项目HTTP错误期间仍保存普通日志')
  await page.keyboard.press('Meta+s')
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${created.id}/log-draft`)).json())?.content).toContain('项目HTTP错误期间仍保存普通日志')
})

test('malformed project catalog preserves Board and ordinary Task editing', async ({ page }) => {
  const task = await seedTask(page, unique('目录隔离'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/?lang=zh-CN')
  await page.locator('h4').filter({ hasText: task.title }).click()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await page.route('**/api/projects/catalog?*', route => route.fulfill({ json: { areas: null, milestones: null } }))
  const catalog = page.waitForResponse(r => r.url().includes('/api/projects/catalog'))
  await page.evaluate(() => window.dispatchEvent(new Event('chronicle:projects-changed')))
  await catalog
  await page.getByTestId('workspace-info-bar').getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.getByTestId('workspace-info-bar')).toContainText('进行中')
  await page.locator('.ProseMirror').fill('目录错误后保存的旧任务草稿')
  await page.keyboard.press('Meta+s')
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}/log-draft`)).json())?.content).toContain('目录错误后保存的旧任务草稿')
  expect(errors).toEqual([])
})

test('unavailable draft cache does not block ordinary create, save, timing or cancel', async ({ page }) => {
  const task = await seedTask(page, unique('缓存隔离'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/?lang=zh-CN')
  await page.locator('h4').filter({ hasText: task.title }).click()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await page.evaluate(() => {
    const original = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('chronicle:task_draft')) throw new DOMException('Injected draft cache quota', 'QuotaExceededError')
      return original.call(this, key, value)
    }
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('chronicle:task_draft')) throw new DOMException('Injected draft cache denied', 'SecurityError')
      return originalRemove.call(this, key)
    }
  })
  await page.keyboard.press('Meta+n')
  const title = unique('缓存失败仍创建')
  await page.getByPlaceholder('输入任务标题...').fill(title)
  const createdResponse = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST')
  await page.getByPlaceholder('输入任务标题...').press('Meta+Enter')
  expect((await createdResponse).ok()).toBe(true)
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await page.getByTestId('workspace-info-bar').getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.getByTestId('workspace-info-bar')).toContainText('进行中')
  await page.keyboard.press('Meta+n')
  await expect(page.getByPlaceholder('输入任务标题...')).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByPlaceholder('输入任务标题...')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
  expect(errors).toEqual([])
})

for (const workspace of ['Board', 'Focus']) test(`unrelated Area update preserves ${workspace} log editor, selection and undo`, async ({ page }) => {
  const task = await seedTask(page, unique('后台刷新'))
  const area = await (await page.request.post('/api/areas', { data: { name: unique('无关方向') } })).json()
  const entry = await (await page.request.post(`/api/tasks/${task.id}/logs`, { data: { type: 'log', content: '<p>正在编辑的既有日志</p>' } })).json()
  await page.request.post(`/api/tasks/${task.id}/takeover`)
  const connected = page.waitForEvent('console', m => m.text().includes('[SSE] Connected'))
  await page.goto(workspace === 'Focus' ? `/today?date=2099-06-16&task=${task.id}&lang=zh-CN` : '/?lang=zh-CN')
  await connected
  if (workspace === 'Board') await page.locator('h4').filter({ hasText: task.title }).click()
  await page.locator(`[data-task-entry-id="${entry.id}"]`).getByTestId('entry-content').click()
  const editor = page.locator('.ProseMirror[contenteditable="true"]:not(.day-script-editor)')
  await expect(editor).toHaveCount(1)
  await editor.fill('正在编辑的既有日志，尚未保存的补充')
  // Separate the next edit's undo group and settle pre-existing SSE activity.
  await page.waitForTimeout(550)
  await editor.press('End')
  await page.keyboard.type('UNDO_MARKER')
  await page.keyboard.press('Shift+ArrowLeft')
  const selection = () => page.evaluate(() => {
    const selection = window.getSelection()
    return { text: selection?.toString(), anchor: selection?.anchorOffset, focus: selection?.focusOffset }
  })
  const beforeSelection = await selection()
  const original = await editor.elementHandle()
  expect(original).not.toBeNull()
  const logReads: string[] = []
  page.on('request', req => { if (req.url().endsWith(`/api/tasks/${task.id}/logs`) && req.method() === 'GET') logReads.push(req.url()) })
  const progress = unique('另一个客户端修改无关方向')
  const refreshed = page.waitForResponse(async r => r.url().includes('/api/projects/catalog') && (await r.json()).areas.some((a: any) => a.id === area.id && a.latestProgress === progress))
  const response = await page.request.patch(`/api/areas/${area.id}`, { data: { expectedRevision: area.revision, latestProgress: progress } })
  expect(response.ok()).toBe(true)
  await refreshed
  expect(await original!.evaluate(node => node.isConnected)).toBe(true)
  await expect(editor).toHaveCount(1)
  await expect(editor).toContainText('尚未保存的补充')
  expect(await selection()).toEqual(beforeSelection)
  expect(logReads).toEqual([])
  await editor.press('Meta+z')
  await expect(editor).not.toContainText('UNDO_MARKER')
  await editor.press('Meta+Shift+z')
  await expect(editor).toContainText('UNDO_MARKER')
})

test('periodic project statistics failure leaves original Report work time ticking', async ({ page }) => {
  const task = await seedTask(page, unique('报表隔离'))
  await page.request.post(`/api/tasks/${task.id}/takeover`)
  let fail = false
  let successful = 0
  await page.route('**/api/projects/statistics?*', async route => {
    if (fail) return route.fulfill({ status: 500, json: { error: 'Injected project statistics failure' } })
    const response = await route.fetch()
    successful++
    await route.fulfill({ response })
  })
  await page.goto('/report?lang=zh-CN')
  await expect.poll(() => successful).toBeGreaterThan(0)
  await expect(page.getByText(/同本页期间 · 合计/)).toBeVisible()
  const work = page.getByText('工作时长', { exact: true }).locator('..').getByRole('button')
  const duty = page.getByText('在岗时长', { exact: true }).locator('..').getByRole('button')
  await expect(work).toBeVisible()
  await page.waitForTimeout(700)
  fail = true
  // Use the actual periodic refresh: a projects-changed event also reloads
  // sessions and resets the snapshot, which is a different (fallback) path.
  await expect(page.getByRole('alert').filter({ hasText: '以下保留上次结果' })).toBeVisible({ timeout: 15_000 })
  const before = { work: await work.innerText(), duty: await duty.innerText() }
  await page.waitForTimeout(2400)
  const after = { work: await work.innerText(), duty: await duty.innerText() }
  expect(after.work).not.toBe(before.work)
  expect(after.duty).not.toBe(before.duty)
})

test('malformed project references leave Focus saving and Task detail usable', async ({ page }) => {
  const task = await seedTask(page, unique('Focus关联异常'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/project-references?*', route => route.fulfill({ json: {
    sourceType: 'task', sourceId: task.id, projectRevision: 1, references: {},
  } }))
  const date = '2099-06-17'
  await page.goto(`/today?date=${date}&task=${task.id}&lang=zh-CN`)
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await expect(page.getByTestId('project-relations').getByRole('alert')).toBeVisible()
  const focus = page.locator('.day-script-editor.ProseMirror')
  const text = unique('项目异常期间保存Focus')
  await focus.fill(text)
  await focus.press('Meta+s')
  await expect.poll(async () => JSON.stringify((await (await page.request.get(`/api/day-scripts/${date}`)).json()).document)).toContain(text)
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  expect(errors).toEqual([])
})

test('project distribution rendering error is contained while Report and navigation remain usable', async ({ page }) => {
  const task = await seedTask(page, unique('报表组件隔离'))
  await page.request.post(`/api/tasks/${task.id}/takeover`)
  await page.route('**/api/projects/statistics?*', async route => {
    const response = await route.fetch()
    const statistics = await response.json()
    await route.fulfill({ json: { ...statistics, byMilestone: null } })
  })
  await page.goto('/report?lang=zh-CN')
  await expect(page.getByTestId('project-feature-error')).toBeVisible()
  const work = page.getByText('工作时长', { exact: true }).locator('..').getByRole('button')
  const before = await work.innerText()
  await expect.poll(() => work.innerText()).not.toBe(before)
  await page.getByRole('button', { name: '看板', exact: true }).click()
  await page.locator('h4').filter({ hasText: task.title }).click()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
})

test('assignment metadata still updates across clients without replacing the log editor', async ({ page }) => {
  const area = await (await page.request.post('/api/areas', { data: { name: unique('安全更新归属') } })).json()
  const first = await (await page.request.post('/api/milestones', { data: { areaId: area.id, name: unique('旧归属') } })).json()
  const second = await (await page.request.post('/api/milestones', { data: { areaId: area.id, name: unique('新归属') } })).json()
  const task = await (await page.request.post('/api/tasks', { data: { title: unique('归属任务'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: first.id } })).json()
  const entry = await (await page.request.post(`/api/tasks/${task.id}/logs`, { data: { type: 'log', content: '<p>归属调整期间编辑的日志</p>' } })).json()
  await page.request.post(`/api/tasks/${task.id}/takeover`)
  await page.goto('/?lang=zh-CN')
  await expect(page.getByTitle('connected', { exact: true })).toBeVisible()
  await page.locator('h4').filter({ hasText: task.title }).click()
  await page.locator(`[data-task-entry-id="${entry.id}"]`).getByTestId('entry-content').click()
  const editor = page.locator('.ProseMirror[contenteditable="true"]')
  await editor.fill('归属调整期间还没有保存的补充')
  const original = await editor.elementHandle()
  const preview = await (await page.request.post('/api/projects/assignments/preview', { data: { changes: [{ taskId: task.id, primaryMilestoneId: second.id, expectedRevision: task.projectRevision }] } })).json()
  const applied = await page.request.post('/api/projects/assignments/apply', { data: { token: preview.token } })
  expect(applied.ok()).toBe(true)
  await expect(page.getByTestId('project-relations').getByRole('button', { name: `${area.name} › ${second.name}`, exact: true })).toBeVisible()
  expect(await original!.evaluate(node => node.isConnected)).toBe(true)
  await expect(editor).toContainText('还没有保存的补充')
})

for (const shortcut of ['Control+Enter', 'Meta+Enter']) test(`Mac draft body ${shortcut} creates exactly one Task`, async ({ page }) => {
  await page.goto('/?lang=zh-CN')
  test.skip(!await page.evaluate(() => /Mac/i.test(navigator.platform)), 'Mac shortcut compatibility')
  await page.keyboard.press('Meta+n')
  const title = unique(`正文快捷键${shortcut}`)
  await page.getByPlaceholder('输入任务标题...').fill(title)
  const body = page.locator('.ProseMirror[contenteditable="true"]')
  await body.fill('保存任务的正文')
  const writes: string[] = []
  page.on('request', request => { if (request.url().endsWith('/api/tasks') && request.method() === 'POST') writes.push(request.url()) })
  const created = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST')
  await body.press(shortcut)
  expect((await created).ok()).toBe(true)
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
  expect(writes).toHaveLength(1)
})

test('unrelated Area updates preserve Report pagination and selected Task detail', async ({ page }) => {
  const task = await seedTask(page, unique('保留第二页详情'))
  for (let i = 0; i < 50; i++) await seedTask(page, unique(`分页占位${i}`))
  const area = await (await page.request.post('/api/areas', { data: { name: unique('报表无关方向') } })).json()
  await page.goto('/report?lang=zh-CN')
  await expect(page.getByTitle('connected', { exact: true })).toBeVisible()
  await page.getByText('All Tasks', { exact: true }).click()
  await page.getByRole('button', { name: /Load more/ }).click()
  await page.getByText(task.title, { exact: true }).click()
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible()
  const progress = unique('仅更新方向进展')
  const refreshed = page.waitForResponse(async r => r.url().includes('/api/projects/catalog') && (await r.json()).areas.some((a: any) => a.id === area.id && a.latestProgress === progress))
  const reads: string[] = []
  page.on('request', request => { if (/\/api\/(report-tasks|reports\/tasks)/.test(request.url())) reads.push(request.url()) })
  expect((await page.request.patch(`/api/areas/${area.id}`, { data: { expectedRevision: area.revision, latestProgress: progress } })).ok()).toBe(true)
  await refreshed
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible()
  expect(reads).toEqual([])
})
