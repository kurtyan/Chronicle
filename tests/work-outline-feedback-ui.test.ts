import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import type { OutlineLine } from '../shared/workOutlineTypes'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated work-outline runner required')
const uid = () => crypto.randomUUID()
const tasks: string[] = []
const line = (text: string, depth = 0, task?: { id: string; title: string }): OutlineLine => ({ type: 'outlineLine', attrs: { id: uid(), depth }, content: [{ type: 'text', text }, ...(task ? [{ type: 'taskRef' as const, attrs: { taskId: task.id, label: task.title } }] : [])] })
async function saveDocument(request: APIRequestContext, rows: OutlineLine[]) {
  const current = await (await request.get('/api/work-outlines/default')).json()
  const response = await request.put('/api/work-outlines/default', { data: { expectedEpoch: current.epoch, expectedRevision: current.revision, mutationId: uid(), document: { type: 'doc', schemaVersion: 1, content: rows } } })
  expect(response.ok(), await response.text()).toBeTruthy()
}
async function task(request: APIRequestContext) {
  const response = await request.post('/api/tasks', { data: { title: `Panel task ${uid()}`, type: 'TODO', priority: 'MEDIUM' } })
  const value = await response.json(); tasks.push(value.id); return value
}
async function cursor(page: Page, id: string) {
  await page.locator(`[data-outline-row="${id}"]`).evaluate(element => {
    (element.closest('[contenteditable="true"]') as HTMLElement).focus()
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
}
async function openCreate(page: Page, id: string, title: string) {
  await cursor(page, id); await page.keyboard.type(`@${title}`)
  await page.getByTestId('outline-new-task-option').click()
  await expect(page.getByTestId('outline-create-title')).toBeFocused()
}
async function panelGeometry(page: Page) {
  return page.evaluate(() => {
    const pageBox = document.querySelector('.work-outline-page')!.getBoundingClientRect()
    const workspace = document.querySelector('.outline-workspace')!.getBoundingClientRect()
    const panel = document.querySelector('.outline-side-panel')!.getBoundingClientRect()
    const text = document.querySelector('.outline-text-column')!.getBoundingClientRect()
    return { topDifference: panel.top - pageBox.top, bottomDifference: panel.bottom - pageBox.bottom, rightDifference: panel.right - pageBox.right,
      leftDifference: panel.left - text.right, workspaceTop: workspace.top, pageTop: pageBox.top, panelTop: panel.top, panelHeight: panel.height, pageHeight: pageBox.height }
  })
}
test.beforeEach(async ({ request }) => { await request.post('/api/afk') })
test.afterEach(async ({ request }) => { await request.post('/api/afk'); for (const id of tasks.splice(0)) await request.delete(`/api/tasks/${id}`) })

test('Task detail overlays the whole right side while the outline stays editable and independently scrollable', async ({ page, request }) => {
  const linked = await task(request)
  const rows = [line('Editable direction ', 0, linked), ...Array.from({ length: 65 }, (_, index) => line(`Following work ${index}`))]
  await saveDocument(request, rows)
  for (let index = 0; index < 9; index++) await request.post(`/api/tasks/${linked.id}/logs`, { data: { content: `<p>Historical entry ${index} ${'Long detailed evidence. '.repeat(28)}</p>` } })
  await page.goto('/work-outline')
  await page.locator(`[data-outline-task="${linked.id}"]`).click()
  const panel = page.getByTestId('outline-side-panel')
  await expect(panel.getByTestId('workspace-info-bar')).toBeVisible()
  const geometry = await panelGeometry(page)
  expect(geometry, JSON.stringify(geometry)).toMatchObject({ topDifference: 0, bottomDifference: 0, rightDifference: 0, leftDifference: 0 })
  const info = await panel.getByTestId('workspace-info-bar').boundingBox()
  expect(info!.y).toBeLessThan(geometry.pageTop + 100)
  await cursor(page, rows[1].attrs.id); await page.keyboard.type(' edited beside detail')
  await expect(page.locator(`[data-outline-row="${rows[1].attrs.id}"]`)).toContainText('edited beside detail')
  await page.screenshot({ path: path.join(directory!, 'feedback-task-detail.png') })
  await page.getByTestId('outline-grid-scroll').evaluate(element => { element.scrollTop = 700; element.scrollLeft = 300 })
  expect(await panelGeometry(page)).toMatchObject({ topDifference: 0, bottomDifference: 0, rightDifference: 0, leftDifference: 0 })
  const content = panel.locator('.overflow-y-auto').last()
  await expect.poll(() => content.evaluate(element => element.clientHeight)).toBeGreaterThan(250)
  expect(await content.evaluate(element => element.scrollHeight)).toBeGreaterThan(await content.evaluate(element => element.clientHeight))
  await content.evaluate(element => { element.scrollTop = 200 })
  expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})

test('outline text uses compact natural heights without row borders and the date grid follows wrapped text', async ({ page, request }) => {
  const rows = [line('Direction'), line('Small child', 1), line('Long natural note text '.repeat(45), 1), line('Following sibling')]
  await saveDocument(request, rows); await page.goto('/work-outline')
  await expect(page.getByTestId('outline-date-row')).toHaveCount(rows.length)
  const dimensions = await page.locator(`[data-outline-row="${rows[0].attrs.id}"]`).evaluate(element => {
    const style = getComputedStyle(element); return { height: element.getBoundingClientRect().height, border: style.borderBottomWidth, padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) }
  })
  expect(dimensions.height).toBeLessThanOrEqual(32); expect(dimensions.border).toBe('0px'); expect(dimensions.padding).toBeLessThanOrEqual(6)
  const long = await page.locator(`[data-outline-row="${rows[2].attrs.id}"]`).boundingBox()
  expect(long!.height).toBeGreaterThan(dimensions.height * 3)
  for (const value of rows) await expect.poll(() => page.evaluate(id => {
    const text = document.querySelector(`[data-outline-row="${id}"]`)!.getBoundingClientRect()
    const cell = document.querySelector(`[data-testid="outline-date-row"][data-row-id="${id}"]`)!.getBoundingClientRect()
    return Math.max(Math.abs(text.top - cell.top), Math.abs(text.height - cell.height))
  }, value.attrs.id)).toBeLessThan(2)
})

test('Escape and Cancel discard all unsubmitted new Task fields when reopening the same row', async ({ page, request }) => {
  const target = line('Direction ')
  await saveDocument(request, [target]); await page.goto('/work-outline')
  for (const cancel of ['Escape', '取消']) {
    await openCreate(page, target.attrs.id, 'Fresh task')
    const form = page.getByTestId('outline-create-form')
    await expect(form.getByLabel('任务名称', { exact: true })).toHaveValue('Fresh task')
    await expect(form.getByLabel('说明', { exact: true })).toHaveValue('')
    await expect(form.locator('select').nth(0)).toHaveValue('TODO')
    await expect(form.locator('select').nth(1)).toHaveValue('MEDIUM')
    await expect(form.getByLabel('标签', { exact: true })).toHaveValue('')
    await expect(form.getByLabel('截止日期', { exact: true })).toHaveValue('')
    await form.getByLabel('任务名称', { exact: true }).fill('Abandoned title')
    await form.getByLabel('说明', { exact: true }).fill('Abandoned description')
    await form.locator('select').nth(0).selectOption('TOREAD')
    await form.locator('select').nth(1).selectOption('HIGH')
    await form.getByLabel('标签', { exact: true }).fill('old, draft')
    await form.getByLabel('截止日期', { exact: true }).fill('2026-12-31')
    if (cancel === 'Escape') await page.keyboard.press('Escape')
    else await form.getByRole('button', { name: '取消', exact: true }).click()
    await expect(form).not.toBeVisible()
  }
  await openCreate(page, target.attrs.id, 'New session')
  const form = page.getByTestId('outline-create-form')
  await expect(form.getByLabel('任务名称', { exact: true })).toHaveValue('New session')
  await expect(form.getByLabel('说明', { exact: true })).toHaveValue('')
  await expect(form.locator('select').nth(0)).toHaveValue('TODO')
  await expect(form.locator('select').nth(1)).toHaveValue('MEDIUM')
  await expect(form.getByLabel('标签', { exact: true })).toHaveValue('')
  await expect(form.getByLabel('截止日期', { exact: true })).toHaveValue('')
  expect(await panelGeometry(page)).toMatchObject({ topDifference: 0, bottomDifference: 0, rightDifference: 0, leftDifference: 0 })
  await page.screenshot({ path: path.join(directory!, 'feedback-create-task.png') })
})

test('a saved wide outline clamps to a narrow window and leaves the full create panel and close control reachable', async ({ page, request }) => {
  const target = line('Small-window direction ')
  await saveDocument(request, [target])
  // A shorter viewport makes the form itself scroll. Filling a fixed-height
  // textarea only scrolls its own contents, so it cannot establish this case.
  await page.setViewportSize({ width: 960, height: 440 })
  await page.addInitScript(() => localStorage.setItem('chronicle:outline:width', '800'))
  await page.goto('/work-outline'); await openCreate(page, target.attrs.id, 'Narrow-window task')
  const panel = page.getByTestId('outline-side-panel'), form = page.getByTestId('outline-create-form')
  await expect.poll(() => panelGeometry(page)).toMatchObject({ topDifference: 0, bottomDifference: 0, rightDifference: 0, leftDifference: 0 })
  const bounds = await panel.boundingBox()
  expect(bounds!.width).toBeGreaterThanOrEqual(340)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(960)
  const close = panel.getByRole('button', { name: '关闭任务详情', exact: true })
  await expect(close).toBeInViewport()
  await form.getByLabel('说明', { exact: true }).fill('Long draft '.repeat(200))
  expect(await form.evaluate(element => element.scrollHeight)).toBeGreaterThan(await form.evaluate(element => element.clientHeight))
  await form.getByTestId('outline-create-submit').scrollIntoViewIfNeeded()
  await expect(form.getByTestId('outline-create-submit')).toBeInViewport()
  await expect(close).toBeInViewport()
  await cursor(page, target.attrs.id); await page.keyboard.type(' editable beside narrow panel')
  await expect(page.locator(`[data-outline-row="${target.attrs.id}"]`)).toContainText('editable beside narrow panel')
  await close.click(); await expect(panel).not.toBeVisible()
})
