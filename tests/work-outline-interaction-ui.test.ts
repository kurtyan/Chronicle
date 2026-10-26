import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import type { OutlineDocument, OutlineLine } from '../shared/workOutlineTypes'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated work-outline runner required')
const uid = () => crypto.randomUUID()
const createdTasks: string[] = []
const editor = (page: Page) => page.getByTestId('outline-editor')
const row = (page: Page, id: string) => editor(page).locator(`[data-outline-row="${id}"]`)
const line = (text: string, depth = 0, task?: { id: string; title: string }): OutlineLine => ({ type: 'outlineLine', attrs: { id: uid(), depth }, content: [...(text ? [{ type: 'text' as const, text }] : []), ...(task ? [{ type: 'taskRef' as const, attrs: { taskId: task.id, label: task.title } }] : [])] })
const taskId = (value: OutlineLine) => value.content?.find(node => node.type === 'taskRef')?.attrs.taskId
async function stored(request: APIRequestContext): Promise<OutlineDocument> { return (await (await request.get('/api/work-outlines/default')).json()).document }
async function saveDocument(request: APIRequestContext, rows: OutlineLine[]) {
  const current = await (await request.get('/api/work-outlines/default')).json()
  const response = await request.put('/api/work-outlines/default', { data: { expectedRevision: current.revision, expectedEpoch: current.epoch, mutationId: uid(), document: { type: 'doc', schemaVersion: 1, content: rows } } })
  expect(response.ok(), await response.text()).toBe(true)
}
async function createTask(request: APIRequestContext, prefix: string) {
  const response = await request.post('/api/tasks', { data: { title: `${prefix}-${uid().slice(0, 8)}`, type: 'TODO', priority: 'MEDIUM' } })
  expect(response.ok()).toBe(true)
  const task = await response.json(); createdTasks.push(task.id); return task
}
async function taskStatus(request: APIRequestContext, id: string) { return (await (await request.get(`/api/tasks/${id}`)).json()).status }
async function entries(request: APIRequestContext, id: string): Promise<any[]> { return (await request.get(`/api/tasks/${id}/logs`)).json() }
async function cursor(page: Page, id: string, edge: 'start' | 'end' = 'end') {
  await row(page, id).evaluate((element, at) => {
    (element.closest('[contenteditable="true"]') as HTMLElement).focus()
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(at === 'start')
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, edge)
}
async function clipboard(page: Page, operation: 'copy' | 'cut') {
  return editor(page).evaluate((element, type) => {
    const transfer = new DataTransfer()
    element.dispatchEvent(new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: transfer }))
    return { raw: transfer.getData('application/x-chronicle-outline'), text: transfer.getData('text/plain') }
  }, operation)
}
async function paste(page: Page, value: { raw: string; text: string }) {
  await editor(page).evaluate((element, data) => {
    const transfer = new DataTransfer(); transfer.setData('application/x-chronicle-outline', data.raw); transfer.setData('text/plain', data.text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  }, value)
}

test.beforeEach(async ({ request }) => { await request.post('/api/afk'); await saveDocument(request, [line('')]) })
test.afterEach(async ({ request }) => { await request.post('/api/afk'); for (const id of createdTasks.splice(0)) await request.delete(`/api/tasks/${id}`) })

test('Ctrl+Enter in the outline preserves the detail log draft; the detail editor submits it once', async ({ page, request }) => {
  const linked = await createTask(request, 'Draft scope')
  const target = line('Draft direction ', 0, linked)
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
  const panel = page.getByTestId('outline-side-panel')
  const detailEditor = panel.locator('[data-rich-editor="true"] .ProseMirror')
  await expect(detailEditor).toBeVisible()
  const draft = `Unsubmitted detail ${uid()}`
  await detailEditor.fill(draft)
  await cursor(page, target.attrs.id)
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detailEditor).toContainText(draft)
  expect((await entries(request, linked.id)).filter(entry => entry.content.includes(draft))).toHaveLength(0)
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(1)
  await detailEditor.press('Control+Enter')
  await expect.poll(async () => (await entries(request, linked.id)).filter(entry => entry.content.includes(draft)).length).toBe(1)
  await expect(detailEditor).not.toContainText(draft)
})

test('start and complete shortcuts act only when the Task detail panel owns focus', async ({ page, request }) => {
  const linked = await createTask(request, 'Status scope'), target = line('Status direction ', 0, linked)
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
  const panel = page.getByTestId('outline-side-panel')
  await expect(panel.getByTestId('workspace-info-bar')).toBeVisible()
  const statusWrites: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/tasks/${linked.id}` && request.method() === 'PUT') statusWrites.push(request.postData() || '') })
  await cursor(page, target.attrs.id)
  await page.keyboard.press('ControlOrMeta+Shift+s')
  expect(await taskStatus(request, linked.id)).toBe('PENDING')
  expect(statusWrites).toHaveLength(0)
  await panel.focus()
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await expect.poll(() => taskStatus(request, linked.id)).toBe('DOING')
  const beforeComplete = statusWrites.length
  await cursor(page, target.attrs.id)
  await page.keyboard.press('ControlOrMeta+Shift+d')
  expect(await taskStatus(request, linked.id)).toBe('DOING')
  expect(statusWrites).toHaveLength(beforeComplete)
  await panel.focus()
  await page.keyboard.press('ControlOrMeta+Shift+d')
  await expect.poll(() => taskStatus(request, linked.id)).toBe('DONE')
  await expect(panel).toBeVisible()
  await expect(row(page, target.attrs.id)).toHaveClass(/outline-row-done/)
})

test('@ Escape keeps text, Tab indents without choosing a Task, and arrow selection links the chosen match', async ({ page, request }) => {
  const prefix = `Mention-${uid().slice(0, 8)}`
  const first = await createTask(request, prefix), second = await createTask(request, prefix)
  const root = line('Direction'), target = line('')
  await saveDocument(request, [root, target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${prefix}`)
  const menu = page.getByTestId('outline-mention-menu')
  await expect(menu.getByRole('option')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(row(page, target.attrs.id)).toContainText(`@${prefix}`)
  await page.keyboard.press('Backspace')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(row(page, target.attrs.id)).toHaveAttribute('data-depth', '1')
  await expect(editor(page).locator('[data-outline-task]')).toHaveCount(0)
  // Editing the query reopens suggestions after an explicit dismissal.
  await page.keyboard.type(prefix.at(-1)!)
  await expect(menu.getByRole('option')).toHaveCount(3)
  const chosenText = await menu.getByRole('option').nth(1).innerText()
  const chosen = [first, second].find(task => chosenText.includes(task.title))!
  expect(chosen).toBeTruthy()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(row(page, target.attrs.id).locator(`[data-outline-task="${chosen.id}"]`)).toBeVisible()
  await expect(menu).not.toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => taskId((await stored(request)).content.find(value => value.attrs.id === target.attrs.id)!)).toBe(chosen.id)
})

test('@ arrow navigation scrolls only its menu, keeps every selected option visible, and resets for a new query', async ({ page, request }) => {
  const prefix = `Scroll-${uid().slice(0, 8)}`
  for (let index = 0; index < 8; index++) await createTask(request, `${prefix}-${index} ${'long result title '.repeat(3)}`)
  const target = line('Choose ')
  await saveDocument(request, [...Array.from({ length: 18 }, (_, index) => line(`Earlier direction ${index}`)), target, ...Array.from({ length: 30 }, (_, index) => line(`Later direction ${index}`))])
  await page.goto('/work-outline')
  await row(page, target.attrs.id).scrollIntoViewIfNeeded()
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${prefix}`)
  const menu = page.getByTestId('outline-mention-menu')
  const options = menu.getByRole('option')
  await expect(options).toHaveCount(9)
  await expect(page.getByTestId('outline-save-status')).toHaveText('已保存')
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const scrollState = () => page.evaluate(() => {
    const grid = document.querySelector('[data-testid="outline-grid-scroll"]')!
    return { top: grid.scrollTop, left: grid.scrollLeft, x: window.scrollX, y: window.scrollY }
  })
  const originalScroll = await scrollState()
  const assertSelected = async (index: number) => {
    await expect(options.nth(index)).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => menu.evaluate(element => {
      const selected = element.querySelector('[aria-selected="true"]')!
      const menu = element.getBoundingClientRect(), item = selected.getBoundingClientRect()
      const top = menu.top + element.clientTop
      return item.top >= top - 1 && item.bottom <= top + element.clientHeight + 1
    })).toBe(true)
    await expect(editor(page)).toBeFocused()
    expect(await scrollState()).toEqual(originalScroll)
  }
  await assertSelected(0)
  for (let index = 1; index <= 8; index++) { await page.keyboard.press('ArrowDown'); await assertSelected(index) }
  expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByTestId('outline-new-task-option')).toHaveAttribute('aria-selected', 'true')
  for (let index = 7; index >= 0; index--) { await page.keyboard.press('ArrowUp'); await assertSelected(index) }
  expect(await menu.evaluate(element => element.scrollTop)).toBe(0)
  for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowDown')
  await assertSelected(8)
  // All eight titles still match; resetting cannot be explained by a shorter menu.
  await page.keyboard.type('-')
  await expect(options).toHaveCount(9)
  await assertSelected(0)
  expect(await menu.evaluate(element => element.scrollTop)).toBe(0)
  for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowDown')
  await assertSelected(8)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('outline-create-form')).toBeVisible()
  await expect(page.getByTestId('outline-create-title')).toHaveValue(`${prefix}-`)
  await page.getByTestId('outline-create-form').getByRole('button', { name: '取消', exact: true }).click()
  expect((await stored(request)).content.map(taskId).filter(Boolean)).toEqual([])
})

test('Delete and Backspace cannot merge two adjacent Task references and silently drop one', async ({ page, request }) => {
  const one = await createTask(request, 'Merge one'), two = await createTask(request, 'Merge two')
  const first = line('First ', 0, one), second = line('Second ', 0, two)
  await saveDocument(request, [first, second])
  await page.goto('/work-outline')
  await cursor(page, first.attrs.id)
  await page.keyboard.press('Delete')
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(2)
  await expect(editor(page).locator('[data-outline-task]')).toHaveCount(2)
  await cursor(page, second.attrs.id, 'start')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.map(value => [value.attrs.id, taskId(value)])).toEqual([[first.attrs.id, one.id], [second.attrs.id, two.id]])
  await expect(editor(page).locator(`[data-outline-task="${one.id}"]`)).toBeVisible()
  await expect(editor(page).locator(`[data-outline-task="${two.id}"]`)).toBeVisible()
})

test('copy generates new row IDs while cut and paste preserve row IDs and Task references', async ({ page, request }) => {
  const linked = await createTask(request, 'Clipboard')
  const first = line('Clipboard parent ', 0, linked), second = line('Clipboard child', 1)
  await saveDocument(request, [first, second])
  await page.goto('/work-outline')
  await editor(page).press('ControlOrMeta+a')
  const copied = await clipboard(page, 'copy')
  expect(JSON.parse(copied.raw).content.map((value: OutlineLine) => value.attrs.id)).toEqual([first.attrs.id, second.attrs.id])
  await cursor(page, second.attrs.id)
  await page.keyboard.press('Enter')
  await paste(page, copied)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.length).toBe(4)
  const duplicated = await stored(request), ids = duplicated.content.map(value => value.attrs.id)
  expect(ids.slice(0, 2)).toEqual([first.attrs.id, second.attrs.id])
  expect(new Set(ids).size).toBe(4)
  expect(duplicated.content.filter(value => taskId(value) === linked.id)).toHaveLength(2)
  await editor(page).press('ControlOrMeta+a')
  const cut = await clipboard(page, 'cut')
  await expect(editor(page).locator('[data-outline-task]')).toHaveCount(0)
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(1)
  await editor(page).click()
  await paste(page, cut)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.map(value => value.attrs.id)).toEqual(ids)
  await expect(editor(page).locator(`[data-outline-task="${linked.id}"]`)).toHaveCount(2)
  expect((await request.get(`/api/tasks/${linked.id}`)).ok()).toBe(true)
})

test('canceling a new Task form creates nothing and rapid repeated submits create one Task', async ({ page, request }) => {
  const title = `Create interaction ${uid()}`
  const target = line('Create target ')
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${title}`)
  await page.getByTestId('outline-new-task-option').click()
  const form = page.getByTestId('outline-create-form')
  await expect(form.getByTestId('outline-create-title')).toHaveValue(title)
  await cursor(page, target.attrs.id)
  await page.keyboard.press('Control+Enter')
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await expect(form).not.toBeVisible()
  const allTasks = async () => (await (await request.get('/api/tasks?status=PENDING,DOING,DONE,DROPPED,ON_HOLD')).json()).filter((task: any) => task.title === title)
  expect(await allTasks()).toHaveLength(0)
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${title}`)
  await page.getByTestId('outline-new-task-option').click()
  let posts = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/work-outlines/default/rows/*/task', async route => {
    posts++; await gate; await route.continue()
  })
  try {
    await form.evaluate(element => { const form = element as HTMLFormElement; form.requestSubmit(); form.requestSubmit() })
    await expect.poll(() => posts).toBe(1)
    await expect(form.getByTestId('outline-create-submit')).toBeDisabled()
    release()
    await expect.poll(async () => (await allTasks()).length).toBe(1)
    const [created] = await allTasks(); createdTasks.push(created.id)
    await expect(editor(page).locator(`[data-outline-task="${created.id}"]`)).toBeVisible()
    expect(posts).toBe(1)
  } finally { release() }
})

test('an unresolved create keeps its recovery form when another reference, date cell, or new Task is opened', async ({ page, request }) => {
  const linked = await createTask(request, 'Other existing Task')
  const target = line('Create here '), other = line('Other ', 0, linked), spare = line('Spare ')
  const title = `Keep recovery ${uid()}`
  await saveDocument(request, [target, other, spare])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${title}`)
  await page.getByTestId('outline-new-task-option').click()
  const form = page.getByTestId('outline-create-form')
  let posts = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/work-outlines/default/rows/*/task', async route => {
    posts++
    if (posts === 1) {
      await gate
      // The transaction commits, but the client receives no acknowledgement.
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  const allTasks = async () => (await (await request.get('/api/tasks?status=PENDING,DOING,DONE,DROPPED,ON_HOLD')).json()).filter((task: any) => task.title === title)
  try {
    await form.getByTestId('outline-create-submit').click()
    await expect.poll(() => posts).toBe(1)
    await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
    await expect(form).toBeVisible()
    await expect(form.getByTestId('outline-create-title')).toHaveValue(title)
    release()
    await expect(form.getByRole('alert')).toBeVisible()
    const [committed] = await allTasks()
    expect(committed).toBeTruthy(); createdTasks.push(committed.id)
    await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
    await expect(form).toBeVisible()
    // Exercise date selection even though the current overlay covers the cell.
    await page.locator(`[data-testid="outline-day-cell"][data-task-id="${linked.id}"]`).last().dispatchEvent('click')
    await expect(form).toBeVisible()
    await cursor(page, spare.attrs.id)
    await page.keyboard.type(`@Another uncommitted ${uid()}`)
    await page.getByTestId('outline-new-task-option').click()
    await expect(form.getByTestId('outline-create-title')).toHaveValue(title)
    await form.getByTestId('outline-create-submit').click()
    await expect(editor(page).locator(`[data-outline-task="${committed.id}"]`)).toBeVisible()
    await expect(form).not.toBeVisible()
    expect(await allTasks()).toHaveLength(1)
    expect(posts).toBe(2)
  } finally { release() }
})

test('copying and cutting a non-root branch preserve its nested sibling relationships', async ({ page, request }) => {
  const linked = await createTask(request, 'Nested clipboard')
  const root = line('Root'), branch = line('Branch ', 1, linked), child = line('Child', 2), grandchild = line('Grandchild', 3), sibling = line('Sibling', 2), destination = line('')
  const branchRows = [branch, child, grandchild, sibling]
  await saveDocument(request, [root, ...branchRows, destination])
  await page.goto('/work-outline')
  async function selectBranch(ids: string[]) {
    await editor(page).evaluate((element, selectionIds) => {
      ;(element as HTMLElement).focus()
      const first = element.querySelector(`[data-outline-row="${selectionIds[0]}"]`)!
      const last = element.querySelector(`[data-outline-row="${selectionIds.at(-1)}"]`)!
      const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.childNodes.length)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }, ids)
  }
  await selectBranch(branchRows.map(value => value.attrs.id))
  const copied = await clipboard(page, 'copy')
  expect(JSON.parse(copied.raw).content.map((value: OutlineLine) => value.attrs.depth)).toEqual([1, 2, 3, 2])
  await cursor(page, destination.attrs.id)
  await paste(page, copied)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.slice(-4).map(value => value.attrs.depth)).toEqual([0, 1, 2, 1])
  const copyRows = (await stored(request)).content.slice(-4)
  expect(copyRows.map(value => value.attrs.id).some(id => branchRows.some(value => value.attrs.id === id))).toBe(false)
  expect(taskId(copyRows[0])).toBe(linked.id)
  await selectBranch(branchRows.map(value => value.attrs.id))
  const cut = await clipboard(page, 'cut')
  await cursor(page, copyRows.at(-1)!.attrs.id)
  await page.keyboard.press('Enter')
  await paste(page, cut)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.slice(-4).map(value => [value.attrs.id, value.attrs.depth])).toEqual(branchRows.map(value => [value.attrs.id, value.attrs.depth]))
  expect(taskId((await stored(request)).content.at(-4)!)).toBe(linked.id)
})

test('an unconfirmed create can be abandoned: the form closes, autosave resumes and no Task is created', async ({ page, request }) => {
  const target = line('Create here '), title = `Abandoned ${uid()}`
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${title}`)
  await page.getByTestId('outline-new-task-option').click()
  const form = page.getByTestId('outline-create-form')
  await page.route('**/api/work-outlines/default/rows/*/task', route => route.abort('failed'))
  await form.getByTestId('outline-create-submit').click()
  await expect(form.getByRole('alert')).toBeVisible()
  // Without an exit the form would stay locked and block leaving the page.
  await expect(form.getByTestId('outline-create-title')).toBeDisabled()
  await form.getByTestId('outline-create-abandon').click()
  await expect(form).not.toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '已放弃' })).toBeVisible()
  await cursor(page, target.attrs.id)
  await page.keyboard.type(' typed after abandoning')
  await expect.poll(async () => JSON.stringify(await stored(request))).toContain('typed after abandoning')
  const matching = (await (await request.get('/api/tasks?status=PENDING,DOING,DONE,DROPPED,ON_HOLD')).json()).filter((task: any) => task.title === title)
  expect(matching).toHaveLength(0)
})

test('the @ menu lists the best 50 matches and says how many more exist', async ({ page, request }) => {
  const prefix = `Many-${uid().slice(0, 6)}`, target = line('')
  for (let index = 0; index < 55; index++) await createTask(request, prefix)
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${prefix}`)
  const menu = page.getByTestId('outline-mention-menu')
  await expect(menu.getByRole('option')).toHaveCount(51)
  await expect(page.getByTestId('outline-mention-more')).toContainText('5')
})
