import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
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

async function expectBlankLines(content: Locator) {
  await expect(content).toBeVisible()
  const layout = await content.locator(':scope > p').evaluateAll(paragraphs => {
    const rows = paragraphs.map(p => p.getBoundingClientRect())
    return { heights: rows.slice(1, -1).map(row => row.height), distance: rows.at(-1)!.top - rows[0].top, lineHeight: rows[0].height }
  })
  expect(layout.heights).toEqual([layout.lineHeight, layout.lineHeight])
  expect(layout.distance).toBeCloseTo(3 * layout.lineHeight, 0)
}

test('task body and log display blank lines and trailing soft breaks after save and reload', async ({ page, request }) => {
  const linked = await createTask(request, 'Task with blank lines')
  const initial = await request.post(`/api/tasks/${linked.id}/logs`, { data: { type: 'body', content: '<p>Body before</p>' } })
  expect(initial.ok()).toBe(true)
  await saveDocument(request, [line('Task ', 0, linked)])
  await page.goto('/work-outline?lang=en')
  const openTask = () => editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
  await openTask()
  const panel = page.getByTestId('outline-side-panel')
  const entryEditor = panel.locator('[data-rich-editor="true"] .ProseMirror')
  const display = (text: string) => panel.getByTestId('entry-content').filter({ hasText: text })
  const expectEntryBreaks = async (text: string) => {
    const content = display(text)
    await expectBlankLines(content)
    const paragraph = content.locator(':scope > p').last()
    await expect(paragraph.locator('br')).toHaveCount(3)
    const lines = await paragraph.evaluate(p => p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight))
    expect(lines).toBeCloseTo(4)
  }
  await display('Body before').click()
  await entryEditor.locator('p').first().evaluate(p => {
    p.closest<HTMLElement>('[contenteditable="true"]')!.focus()
    window.getSelection()!.collapse(p.firstChild, p.textContent!.length)
    document.dispatchEvent(new Event('selectionchange'))
  })
  for (let index = 0; index < 3; index++) await page.keyboard.press('Enter')
  await page.keyboard.type('Body after')
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+Enter')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expectEntryBreaks('Body after')

  await entryEditor.click()
  await page.keyboard.type('Log before')
  for (let index = 0; index < 3; index++) await page.keyboard.press('Enter')
  await page.keyboard.type('Log after')
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+Enter')
  await panel.getByRole('button', { name: 'Submit Log', exact: true }).click()
  await expectEntryBreaks('Log after')
  for (const [type, first, last] of [['body', 'Body before', 'Body after'], ['log', 'Log before', 'Log after']]) {
    expect(await entries(request, linked.id)).toContainEqual(expect.objectContaining({ type, content: `<p>${first}</p><p></p><p></p><p>${last}<br><br><br></p>` }))
  }

  await page.reload()
  await openTask()
  await expectEntryBreaks('Body after')
  await expectEntryBreaks('Log after')
})

test('pinned and Report entries preserve blank lines alongside normal and soft breaks', async ({ page, request }) => {
  const linked = await createTask(request, 'Preview blank lines')
  const formatted = (label: string) => `<p>${label} before</p><p></p><p></p><p>${label} after</p>`
  const logPath = `/api/tasks/${linked.id}/logs`
  const body = await request.post(logPath, { data: { type: 'body', content: formatted('Preview body') } })
  const log = await request.post(logPath, { data: { type: 'log', content: formatted('Preview log') } })
  const breaks = await request.post(logPath, { data: {
    type: 'log',
    content: '<p>One line</p><p>Next line<br><br>Soft break</p>'
      + '<ol><li><pre><code>code in list</code></pre></li><li><p></p><pre><code>code after placeholder</code></pre></li></ol>'
      + `<blockquote>${formatted('Quoted text')}</blockquote>`,
  } })
  const pinned = await request.post(`/api/tasks/${linked.id}/pinned/append`, { data: { content: formatted('Pinned log') } })
  for (const response of [body, log, breaks, pinned]) expect(response.ok(), await response.text()).toBe(true)

  await saveDocument(request, [line('Task ', 0, linked)])
  await page.goto('/work-outline?lang=en')
  await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
  await expectBlankLines(page.locator('.prose-mirror-display').filter({ hasText: 'Pinned log before' }))
  const normal = page.getByTestId('entry-content').filter({ hasText: 'Soft break' })
  await expect(normal).toBeVisible()
  const layout = await normal.locator(':scope > p').evaluateAll(([first, second]) => ({
    line: first.getBoundingClientRect().height,
    paragraphDistance: second.getBoundingClientRect().top - first.getBoundingClientRect().top,
    softBreakHeight: second.getBoundingClientRect().height,
  }))
  expect(layout.paragraphDistance).toBeCloseTo(layout.line, 0)
  expect(layout.softBreakHeight).toBeCloseTo(3 * layout.line, 0)
  await expect(normal.locator('ol > li > .chronicle-code-list-marker')).toHaveText('1.')
  await expect(normal.locator('ol > li > pre > code')).toHaveText(['code in list', 'code after placeholder'])
  expect(await normal.locator('ol > li > p:empty').evaluate(p => p.getBoundingClientRect().height)).toBe(0)
  await expectBlankLines(normal.locator('blockquote'))

  await page.goto('/report?lang=en')
  await page.getByText('All Tasks', { exact: true }).first().click()
  await page.getByText(linked.title, { exact: true }).click()
  await expectBlankLines(page.locator('.prose-mirror-display').filter({ hasText: 'Preview body before' }))
  await expectBlankLines(page.locator('.prose-mirror-display').filter({ hasText: 'Preview log before' }))
})

test('Cmd+Shift minus and plus fold only the current tree branch and preserve nested folds', async ({ page, request }) => {
  const linked = await createTask(request, 'Fold scope')
  const parent = line('Parent ', 0, linked), child = line('Child', 1), grandchild = line('Grandchild', 2), sibling = line('Sibling')
  await saveDocument(request, [parent, child, grandchild, sibling])
  await page.goto('/work-outline')
  const fold = (id: string) => page.locator(`[data-testid="outline-fold"][data-row-id="${id}"]`)
  const collapse = () => page.keyboard.press('Meta+Shift+Minus')
  const expand = () => page.keyboard.press('Meta+Shift+Equal')
  await fold(child.attrs.id).click()
  await expect(row(page, grandchild.attrs.id)).toBeHidden()
  await cursor(page, parent.attrs.id, 'start')
  await page.evaluate(() => {
    window.addEventListener('keydown', event => {
      if (event.metaKey && event.shiftKey && ['Minus', 'Equal'].includes(event.code)) document.body.dataset.unhandledFoldKey = event.code
    })
  })
  await collapse()
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, child.attrs.id)).toBeHidden()
  await expect(row(page, sibling.attrs.id)).toBeVisible()
  await expect(editor(page)).toBeFocused()
  expect(await page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    return element?.closest<HTMLElement>('[data-outline-row]')?.dataset.outlineRow
  })).toBe(parent.attrs.id)
  await expand()
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'true')
  await expect(row(page, child.attrs.id)).toBeVisible()
  await expect(row(page, grandchild.attrs.id)).toBeHidden()
  await expect(page.locator('body')).not.toHaveAttribute('data-unhandled-fold-key', /./)

  await cursor(page, sibling.attrs.id)
  await collapse()
  await expect(page.locator('body')).toHaveAttribute('data-unhandled-fold-key', 'Minus')
  await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
  const detailEditor = page.getByTestId('outline-side-panel').locator('[data-rich-editor="true"] .ProseMirror')
  await detailEditor.click()
  await collapse()
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()

  await cursor(page, parent.attrs.id, 'start')
  await editor(page).dispatchEvent('keydown', { key: '_', code: 'Minus', metaKey: true, shiftKey: true, isComposing: true })
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ControlOrMeta+f')
  const find = page.locator('[data-find-bar="true"] input')
  await find.fill('Grandchild')
  await expect(row(page, grandchild.attrs.id)).toBeVisible()
  await cursor(page, parent.attrs.id, 'start')
  await collapse()
  await find.press('Escape')
  await expect(row(page, grandchild.attrs.id)).toBeHidden()
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'true')

  await cursor(page, parent.attrs.id, 'start')
  await collapse()
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(fold(parent.attrs.id)).toHaveAttribute('aria-expanded', 'false')
  await fold(parent.attrs.id).click()
  await expect(row(page, child.attrs.id)).toBeVisible()
  await expect(row(page, grandchild.attrs.id)).toBeHidden()
})

test('holding a handled fold shortcut keeps desktop zoom idle until the next press', async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' })
    const zoomCalls: number[] = []
    Object.assign(window, {
      __TAURI__: {},
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { scale: number }) => {
          if (command === 'set_zoom') {
            zoomCalls.push(args.scale)
            document.documentElement.dataset.zoomCalls = JSON.stringify(zoomCalls)
          }
          return null
        },
        transformCallback: () => 0,
      },
    })
  })
  const parent = line('Parent'), child = line('Child', 1)
  await saveDocument(request, [parent, child])
  await page.goto('/work-outline')
  const fold = page.getByTestId('outline-fold')
  const zoom = page.locator('html')
  await cursor(page, parent.attrs.id, 'start')
  await page.keyboard.press('Meta+Shift+Minus')
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.down('Meta')
  await page.keyboard.down('Shift')
  await page.keyboard.down('Equal')
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.down('Equal')
  await page.keyboard.down('Equal')
  await page.keyboard.up('Equal')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
  await expect(zoom).not.toHaveAttribute('data-zoom-calls', /./)

  await page.keyboard.press('Meta+Shift+Equal')
  await expect(zoom).toHaveAttribute('data-zoom-calls', '[1.1]')
  await cursor(page, child.attrs.id)
  await page.keyboard.press('Meta+Shift+Equal')
  await expect(zoom).toHaveAttribute('data-zoom-calls', '[1.1,1.2]')
  await fold.focus()
  await page.keyboard.press('Meta+Minus')
  await expect(zoom).toHaveAttribute('data-zoom-calls', '[1.1,1.2,1.1]')
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
})

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
  await expect(menu.getByRole('option')).toHaveCount(2)
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
  await expect(menu.getByRole('option')).toHaveCount(2)
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
  for (let index = 0; index < 10; index++) await createTask(request, `${prefix}-${index} ${'long result title '.repeat(3)}`)
  const target = line('Choose ')
  await saveDocument(request, [...Array.from({ length: 18 }, (_, index) => line(`Earlier direction ${index}`)), target, ...Array.from({ length: 30 }, (_, index) => line(`Later direction ${index}`))])
  await page.goto('/work-outline')
  await row(page, target.attrs.id).scrollIntoViewIfNeeded()
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@${prefix}`)
  const menu = page.getByTestId('outline-mention-menu')
  const options = menu.getByRole('option')
  await expect(options).toHaveCount(10)
  await expect(page.getByTestId('outline-new-task-option')).toHaveCount(0)
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
  for (let index = 1; index <= 9; index++) { await page.keyboard.press('ArrowDown'); await assertSelected(index) }
  expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  // Navigation stops at the last match; there is no extra slot after it.
  await page.keyboard.press('ArrowDown')
  await assertSelected(9)
  for (let index = 8; index >= 0; index--) { await page.keyboard.press('ArrowUp'); await assertSelected(index) }
  expect(await menu.evaluate(element => element.scrollTop)).toBe(0)
  for (let index = 0; index < 9; index++) await page.keyboard.press('ArrowDown')
  await assertSelected(9)
  // All ten titles still match; resetting cannot be explained by a shorter menu.
  await page.keyboard.type('-')
  await expect(options).toHaveCount(10)
  await assertSelected(0)
  expect(await menu.evaluate(element => element.scrollTop)).toBe(0)
  for (let index = 0; index < 9; index++) await page.keyboard.press('ArrowDown')
  await assertSelected(9)
  await page.keyboard.press('Enter')
  await expect(menu).not.toBeVisible()
  await expect(page.getByTestId('outline-create-form')).toHaveCount(0)
  await expect(row(page, target.attrs.id).locator('[data-outline-task]')).toHaveCount(1)
})

test('@ with no matching Task shows an empty state, and Enter closes the menu without creating anything', async ({ page, request }) => {
  const target = line('Nothing ')
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`@zz-${uid()}`)
  const menu = page.getByTestId('outline-mention-menu')
  await expect(menu.getByRole('option')).toHaveCount(0)
  await expect(page.getByTestId('outline-mention-empty')).toBeVisible()
  await expect(page.getByTestId('outline-new-task-option')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(menu).not.toBeVisible()
  await expect(page.getByTestId('outline-create-form')).toHaveCount(0)
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(1)
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
  const target = line('')
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`${title}`)
  await page.keyboard.press('Meta+n')
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
  await page.keyboard.press('Meta+n')
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
  const target = line(''), other = line('Other ', 0, linked), spare = line('Spare ')
  const title = `Keep recovery ${uid()}`
  await saveDocument(request, [target, other, spare])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`${title}`)
  await page.keyboard.press('Meta+n')
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
    await page.keyboard.type(`Another uncommitted ${uid()}`)
    await page.keyboard.press('Meta+n')
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
  const target = line(''), title = `Abandoned ${uid()}`
  await saveDocument(request, [target])
  await page.goto('/work-outline')
  await cursor(page, target.attrs.id)
  await page.keyboard.type(`${title}`)
  await page.keyboard.press('Meta+n')
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
  await expect(menu.getByRole('option')).toHaveCount(50)
  await expect(page.getByTestId('outline-mention-more')).toContainText('5')
})

async function draftTitle(page: Page, id: string) {
  await cursor(page, id)
  await page.keyboard.press('Meta+n')
  const form = page.getByTestId('outline-create-form')
  await expect(form).toBeVisible()
  return form.getByTestId('outline-create-title')
}

test('Cmd+N uses the direct parent row title even when it is not linked to a Task', async ({ page, request }) => {
  const goal = await createTask(request, 'Goal'), sibling = await createTask(request, 'Sibling')
  const rows = [line('', 0, goal), line('unlinked middle', 1), line('Write spec', 2), line('', 1, sibling), line('Review it', 1)]
  await saveDocument(request, rows)
  await page.goto('/work-outline')
  await expect(await draftTitle(page, rows[2].attrs.id)).toHaveValue('unlinked middle - Write spec')
})

test('Cmd+N prefers the direct linked parent, and a linked sibling is not an ancestor', async ({ page, request }) => {
  const grand = await createTask(request, 'Grand'), parent = await createTask(request, 'Parent'), sibling = await createTask(request, 'Sibling')
  const rows = [line('', 0, grand), line('', 1, parent), line('child', 2), line('', 1, sibling), line('next to a linked sibling', 1)]
  await saveDocument(request, rows)
  await page.goto('/work-outline')
  await expect(await draftTitle(page, rows[2].attrs.id)).toHaveValue(`${parent.title} - child`)
  await page.getByTestId('outline-create-form').getByRole('button', { name: '取消', exact: true }).click()
  await expect(await draftTitle(page, rows[4].attrs.id)).toHaveValue(`${grand.title} - next to a linked sibling`)
})

test('Cmd+N uses plain parent text, falls back to root text, and uses the parent title for an empty row', async ({ page, request }) => {
  const goal = await createTask(request, 'Goal')
  const rows = [line('plain root'), line('plain child', 1), line('', 0, goal), line('', 1)]
  await saveDocument(request, rows)
  await page.goto('/work-outline')
  await expect(await draftTitle(page, rows[0].attrs.id)).toHaveValue('plain root')
  await page.getByTestId('outline-create-form').getByRole('button', { name: '取消', exact: true }).click()
  await expect(await draftTitle(page, rows[1].attrs.id)).toHaveValue('plain root - plain child')
  await page.getByTestId('outline-create-form').getByRole('button', { name: '取消', exact: true }).click()
  await expect(await draftTitle(page, rows[3].attrs.id)).toHaveValue(goal.title)
})

test('Cmd+N skips empty parents and unrelated sibling branches to find a non-empty ancestor', async ({ page, request }) => {
  const rows = [line('Project A'), line('Module B', 1), line('Unrelated sibling', 2), line('Its child', 3), line('   ', 2), line('', 3), line('Fix login', 4)]
  await saveDocument(request, rows)
  await page.goto('/work-outline')
  await expect(await draftTitle(page, rows[6].attrs.id)).toHaveValue('Module B - Fix login')
})

test('Cmd+N ignores an open @ query, and on a row that already has a Task only shows the notice', async ({ page, request }) => {
  const goal = await createTask(request, 'Goal'), own = await createTask(request, 'Own')
  const rows = [line('', 0, goal), line('Plan ', 1), line('', 1, own)]
  await saveDocument(request, rows)
  await page.goto('/work-outline')
  await cursor(page, rows[1].attrs.id)
  await page.keyboard.type('@zz-nothing')
  await page.keyboard.press('Meta+n')
  await expect(page.getByTestId('outline-create-title')).toHaveValue(`${goal.title} - Plan`)
  await expect(page.getByTestId('outline-mention-menu')).not.toBeVisible()
  await expect(row(page, rows[1].attrs.id)).toHaveText('Plan')
  await page.getByTestId('outline-create-form').getByRole('button', { name: '取消', exact: true }).click()
  await cursor(page, rows[2].attrs.id)
  await page.keyboard.press('Meta+n')
  await expect(page.getByRole('status').filter({ hasText: '此行已有 Task' })).toBeVisible()
  await expect(page.getByTestId('outline-create-form')).toHaveCount(0)
})
