import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import path from "node:path"
import type { OutlineDocument, OutlineLine } from '../shared/workOutlineTypes'

const uid = () => crypto.randomUUID()
const line = (text: string, depth = 0, task?: { id: string; title: string }): OutlineLine => ({ type: 'outlineLine', attrs: { id: uid(), depth }, content: [{ type: 'text', text }, ...(task ? [{ type: 'taskRef' as const, attrs: { taskId: task.id, label: task.title } }] : [])] })
async function saveDocument(request: APIRequestContext, rows: OutlineLine[]) {
  const current = await (await request.get('/api/work-outlines/default')).json()
  const document: OutlineDocument = { type: 'doc', schemaVersion: 1, content: rows }
  const response = await request.put('/api/work-outlines/default', { data: { expectedRevision: current.revision, expectedEpoch: current.epoch, mutationId: uid(), document } })
  expect(response.ok(), await response.text()).toBe(true)
  return document
}
async function task(request: APIRequestContext, title: string) {
  const response = await request.post('/api/tasks', { data: { title: `${title}-${uid().slice(0, 5)}`, type: 'TODO', priority: 'MEDIUM' } })
  expect(response.ok()).toBe(true)
  return response.json()
}
const editor = (page: Page) => page.getByTestId('outline-editor')
const row = (page: Page, id: string) => editor(page).locator(`[data-outline-row="${id}"]`)
async function stored(request: APIRequestContext) { return (await (await request.get('/api/work-outlines/default')).json()).document as OutlineDocument }
async function focusEnd(page: Page, id: string) {
  await row(page, id).click()
  await page.keyboard.press('End')
}
function fixtureDb() {
  const directory = process.env.CHRONICLE_TEST_DATA_DIR
  if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated test database is required')
  const Database = createRequire(path.resolve('server/package.json'))('better-sqlite3')
  return new Database(path.join(directory, 'tasks.db'))
}

test.beforeEach(async ({ request }) => { await saveDocument(request, [line('')]) })

test('clicking a plain row in the tree closes the open Task panel', async ({ page, request }) => {
  const existing = await task(request, 'TreeClick')
  const plain = line('plain row')
  await saveDocument(request, [plain, line('ref', 0, existing)])
  await page.goto('/work-outline')
  await editor(page).locator(`[data-outline-task="${existing.id}"]`).click()
  await expect(page.getByTestId('outline-side-panel')).toBeVisible()
  await row(page, plain.attrs.id).click()
  await expect(page.getByTestId('outline-side-panel')).not.toBeVisible()
})

test('finished Tasks stay grey in the tree but the right-hand table is not dimmed', async ({ page, request }) => {
  const existing = await task(request, 'DoneTable')
  await request.put(`/api/tasks/${existing.id}`, { data: { status: 'DONE' } })
  await saveDocument(request, [line('ref', 0, existing)])
  await page.goto('/work-outline')
  await expect(editor(page).locator('[data-outline-row]')).toHaveClass(/outline-row-done/)
  await expect(page.getByTestId('outline-date-row').first()).not.toHaveClass(/is-dimmed/)
  await expect(page.getByTestId('outline-total').first()).not.toHaveClass(/is-dimmed/)
})

test('Mod+F finds text inside the outline editor and steps through matches', async ({ page, request }) => {
  await saveDocument(request, [line('alpha needle'), line('beta', 1), line('gamma needle', 1)])
  await page.goto('/work-outline')
  await editor(page).locator('[data-outline-row]').first().click()
  await page.keyboard.press('Meta+f')
  const input = page.locator('[data-find-bar="true"] input')
  await expect(input).toBeFocused()
  await input.fill('needle')
  await expect(editor(page).locator('.search-highlight')).toHaveCount(2)
  await expect(page.locator('[data-find-bar="true"]')).toContainText('1/2')
  await input.press('Enter')
  await expect(page.locator('[data-find-bar="true"]')).toContainText('2/2')
  await input.press('Escape')
  await expect(editor(page).locator('.search-highlight')).toHaveCount(0)
})

test('searching temporarily expands folded branches and restores the fold when the bar closes', async ({ page, request }) => {
  const parent = line('parent')
  await saveDocument(request, [parent, line('hidden needle', 1), line('other', 0)])
  await page.goto('/work-outline')
  await page.getByTestId('outline-fold').click()
  await expect(editor(page).locator('[data-outline-row]:visible')).toHaveCount(2)
  await row(page, parent.attrs.id).click()
  await page.keyboard.press('Meta+f')
  const input = page.locator('[data-find-bar="true"] input')
  await input.fill('needle')
  await expect(editor(page).locator('.search-highlight')).toHaveCount(1)
  await expect(editor(page).locator('[data-outline-row]:visible')).toHaveCount(3)
  await input.press('Escape')
  await expect(editor(page).locator('[data-outline-row]:visible')).toHaveCount(2)
})

test('Esc closes the Task panel first, then the find bar even though focus left it', async ({ page, request }) => {
  const existing = await task(request, 'EscOrder')
  await saveDocument(request, [line('needle ref', 0, existing)])
  await page.goto('/work-outline')
  await editor(page).locator('[data-outline-row]').first().click()
  await page.keyboard.press('Meta+f')
  const input = page.locator('[data-find-bar="true"] input')
  await input.fill('needle')
  await editor(page).locator(`[data-outline-task="${existing.id}"]`).click()
  await expect(page.getByTestId('outline-side-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('outline-side-panel')).not.toBeVisible()
  await expect(input).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-find-bar="true"]')).toHaveCount(0)
  await expect(editor(page).locator('.search-highlight')).toHaveCount(0)
})

test('Esc while editing inside the Task detail leaves the edit first; the next Esc closes the panel', async ({ page, request }) => {
  const existing = await task(request, 'EditEsc')
  await saveDocument(request, [line('ref', 0, existing)])
  await page.goto('/work-outline')
  await editor(page).locator(`[data-outline-task="${existing.id}"]`).click()
  const panel = page.getByTestId('outline-side-panel')
  await panel.locator('h1').click()
  const titleInput = panel.locator('input').first()
  await expect(titleInput).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel.locator('h1')).toBeVisible()
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
})
