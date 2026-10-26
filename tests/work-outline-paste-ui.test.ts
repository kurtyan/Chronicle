import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import type { OutlineDocument, OutlineLine } from '../shared/workOutlineTypes'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated work-outline runner required')
const uid = () => crypto.randomUUID()
const editor = (page: Page) => page.getByTestId('outline-editor')
const tasks: string[] = [], notes: string[] = []
const line = (text = '', depth = 0): OutlineLine => ({ type: 'outlineLine', attrs: { id: uid(), depth }, content: text ? [{ type: 'text', text }] : [] })
const textOf = (value: OutlineLine) => (value.content ?? []).map(node => node.type === 'text' ? node.text : `@${node.attrs.label}`).join('')
const taskOf = (value: OutlineLine) => value.content?.find(node => node.type === 'taskRef')?.attrs.taskId
async function stored(request: APIRequestContext): Promise<OutlineDocument> { return (await (await request.get('/api/work-outlines/default')).json()).document }
async function save(request: APIRequestContext, content: OutlineLine[]) {
  const current = await (await request.get('/api/work-outlines/default')).json()
  const response = await request.put('/api/work-outlines/default', { data: { expectedRevision: current.revision, expectedEpoch: current.epoch, mutationId: uid(), document: { type: 'doc', schemaVersion: 1, content } } })
  expect(response.ok(), await response.text()).toBe(true)
}
async function createTask(request: APIRequestContext) {
  const response = await request.post('/api/tasks', { data: { title: `Clipboard Task ${uid()}`, type: 'TODO', priority: 'MEDIUM' } })
  expect(response.ok()).toBe(true)
  const task = await response.json(); tasks.push(task.id); return task
}
async function openOutline(page: Page) {
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tasks' && response.request().method() === 'GET')
  await page.goto('/work-outline'); await loaded
  await expect(editor(page)).toBeVisible()
  await editor(page).locator('[data-outline-row]').first().click()
}
async function paste(page: Page, value: { html?: string; text?: string; raw?: string }) {
  await editor(page).evaluate((element, data) => {
    const transfer = new DataTransfer()
    if (data.raw) transfer.setData('application/x-chronicle-outline', data.raw)
    if (data.html) transfer.setData('text/html', data.html)
    if (data.text) transfer.setData('text/plain', data.text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  }, value)
}
async function saveAndExpect(page: Page, request: APIRequestContext, depths: number[], texts: string[]) {
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.map(value => value.attrs.depth)).toEqual(depths)
  await expect.poll(async () => (await stored(request)).content.map(textOf)).toEqual(texts)
}

test.beforeEach(async ({ request }) => { await request.post('/api/afk'); await save(request, [line()]) })
test.afterEach(async ({ request }) => {
  for (const id of notes.splice(0)) await request.post(`/api/notes/${id}/archive`)
  for (const id of tasks.splice(0)) await request.delete(`/api/tasks/${id}`)
})

test('actual Notes editor clipboard retains nested lists and Task references after save and reload', async ({ page, request }) => {
  const linked = await createTask(request)
  const response = await request.post('/api/notes', { data: {
    title: `Clipboard source ${uid()}`, linkedTaskIds: [linked.id],
    contentHtml: `<ul><li><p>MLOps Agent</p><ul><li><p>Deployment <a href="/?task=${linked.id}" data-task-id="${linked.id}">@${linked.title}</a></p><ol><li><p>Prepare package</p></li></ol></li><li><p>Monitor</p></li></ul></li><li><p>Other direction</p></li></ul>`,
  } })
  expect(response.ok()).toBe(true)
  const note = await response.json(); notes.push(note.id)
  await page.goto(`/notes?id=${note.id}`)
  const rich = page.locator('[data-rich-editor="true"] .ProseMirror')
  await expect(rich).toContainText('MLOps Agent')
  await rich.click(); await rich.press('ControlOrMeta+a')
  const copied = await rich.evaluate(element => {
    const transfer = new DataTransfer()
    element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }))
    return { html: transfer.getData('text/html'), text: transfer.getData('text/plain') }
  })
  expect(copied.html).toContain('<ul')
  expect(copied.html).toContain('data-task-id')
  await openOutline(page); await paste(page, copied)
  const expected = ['MLOps Agent', `Deployment @${linked.title}`, 'Prepare package', 'Monitor', 'Other direction']
  await saveAndExpect(page, request, [0, 1, 2, 1, 0], expected)
  expect((await stored(request)).content.map(taskOf)).toEqual([undefined, linked.id, undefined, undefined, undefined])
  await page.reload()
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(5)
  expect(await editor(page).locator('[data-outline-row]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-depth'))))).toEqual([0, 1, 2, 1, 0])
  await editor(page).locator(`[data-outline-task="${linked.id}"]`).click()
  await expect(page.getByTestId('outline-side-panel')).toBeVisible()
})

test('external plain text accepts Unicode and numbered lists with spaces, tabs and mixed indentation', async ({ page, request }) => {
  await openOutline(page)
  await paste(page, { text: '• Direction\r\n    1. Task one\r\n        ◦ Detail\r\n    2) Task two\r\n• Other\r\n\t- Tab task\r\n\t  ▪ Mixed child\r\n\t- Peer\r\n' })
  await saveAndExpect(page, request, [0, 1, 2, 1, 0, 1, 2, 1], ['Direction', 'Task one', 'Detail', 'Task two', 'Other', 'Tab task', 'Mixed child', 'Peer'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(8)
})

test('Apple Notes and Chrome HTML wrappers preserve nested lists without importing active markup', async ({ page, request }) => {
  await openOutline(page)
  await page.evaluate(() => { (window as any).__outlinePasteExecuted = false })
  const external: string[] = []
  page.on('request', request => { if (request.url().includes('paste-test.invalid')) external.push(request.url()) })
  await paste(page, { html: `<meta charset="utf-8"><!--StartFragment--><div class="Apple-rich-text"><ul style="margin-left:0"><li><p><span>Direction</span></p><ul><li><p>Child</p><ol><li><p>Grandchild</p></li></ol></li><li><p>Peer</p></li></ul></li></ul></div><script>window.__outlinePasteExecuted=true</script><img src="https://paste-test.invalid/image" onerror="window.__outlinePasteExecuted=true"><iframe src="https://paste-test.invalid/frame"></iframe><!--EndFragment-->`, text: 'Flattened fallback must not win' })
  await saveAndExpect(page, request, [0, 1, 2, 1], ['Direction', 'Child', 'Grandchild', 'Peer'])
  expect(await page.evaluate(() => (window as any).__outlinePasteExecuted)).toBe(false)
  expect(external).toEqual([])
  await expect(editor(page).locator('script,img,iframe')).toHaveCount(0)
})

test('HTML paste at a nonempty selection preserves prefix, suffix and the existing Task atom', async ({ page, request }) => {
  const linked = await createTask(request)
  const target = line('prefix replace suffix ')
  target.content!.push({ type: 'taskRef', attrs: { taskId: linked.id, label: linked.title } })
  await save(request, [target]); await openOutline(page)
  await editor(page).locator('[data-outline-row]').evaluate(element => {
    const text = element.firstChild!
    const range = document.createRange(); range.setStart(text, 7); range.setEnd(text, 14)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await paste(page, { html: '<ul><li><p>Inserted</p><ul><li><p>Child</p></li></ul></li></ul>', text: 'Inserted\nChild' })
  await saveAndExpect(page, request, [0, 1], ['prefix Inserted', `Child suffix @${linked.title}`])
  expect((await stored(request)).content.map(taskOf)).toEqual([undefined, linked.id])
})

test('internal clipboard takes precedence over HTML and copying generates fresh row IDs', async ({ page, request }) => {
  const source = line('Internal root', 3), child = line('Internal child', 4)
  await openOutline(page)
  await paste(page, { raw: JSON.stringify({ type: 'doc', schemaVersion: 1, content: [source, child] }), html: '<p>Wrong HTML</p>', text: 'Wrong plain text' })
  await saveAndExpect(page, request, [0, 1], ['Internal root', 'Internal child'])
  const savedIds = (await stored(request)).content.map(value => value.attrs.id)
  expect(savedIds).not.toContain(source.attrs.id); expect(savedIds).not.toContain(child.attrs.id)
})
