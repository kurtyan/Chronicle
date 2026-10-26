import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'
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

test('the fourth sidebar entry and Mod+4 open outline while Settings stays last at Mod+7', async ({ page }) => {
  await page.goto('/settings')
  const navigation = page.locator('aside nav').first()
  await expect(navigation.getByRole('button').last()).toHaveAttribute('aria-label', '设置')
  await expect(navigation.getByRole('button').nth(3)).toHaveAttribute('aria-label', '工作大纲')
  await expect(navigation.getByRole('button', { name: '工作大纲', exact: true })).toHaveAttribute('aria-keyshortcuts', /(?:Meta|Control)\+4/)
  await expect(navigation.getByRole('button').last()).toHaveAttribute('aria-keyshortcuts', /(?:Meta|Control)\+7/)
  await expect(navigation.getByRole('button', { name: '工作大纲', exact: true })).toHaveAttribute('title', /(?:⌘|Ctrl\+)4/)
  await expect(navigation.getByRole('button').last()).toHaveAttribute('title', /(?:⌘|Ctrl\+)7/)
  await page.keyboard.press('ControlOrMeta+4')
  await expect(page).toHaveURL(/\/work-outline$/)
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+7')
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByRole('button', { name: '工作大纲', exact: true }).click()
  await expect(editor(page)).toBeVisible()
})

test('plain text Enter, indentation, save and reload keep line identities and child ownership', async ({ page, request }) => {
  const parent = line('Parent'), child = line('Child', 1), other = line('Other')
  await saveDocument(request, [parent, child, other])
  await page.goto('/work-outline')
  await focusEnd(page, parent.attrs.id)
  await page.keyboard.press('Enter')
  await page.keyboard.type('New sibling')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.map(l => l.content?.filter(n => n.type === 'text').map(n => n.text).join(''))).toEqual(['Parent', 'Child', 'New sibling', 'Other'])
  const document = await stored(request)
  expect(document.content.map(l => l.attrs.depth)).toEqual([0, 1, 0, 0])
  expect(document.content[0].attrs.id).toBe(parent.attrs.id)
  expect(document.content[1].attrs.id).toBe(child.attrs.id)
  await page.reload()
  await expect(editor(page)).toContainText('New sibling')
})

test('minus marker, multiline paste, deep indent and undo remain text editing operations', async ({ page, request }) => {
  await page.goto('/work-outline')
  await editor(page).click()
  await page.keyboard.type('- Root')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Child')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Grandchild')
  await page.keyboard.press('Tab')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.map(l => l.attrs.depth)).toEqual([0, 1, 2])
  await expect(editor(page)).toContainText('Root')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await stored(request)).content.at(-1)?.attrs.depth).toBe(1)
  await editor(page).evaluate(el => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', '- Pasted\n\t- Nested')
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  })
  await expect(editor(page)).toContainText('Pasted')
  await expect(editor(page)).toContainText('Nested')
})

test('@ associates an existing completed Task and links can open details and be removed without deleting Task', async ({ page, request }) => {
  const existing = await task(request, 'Reference')
  await request.put(`/api/tasks/${existing.id}`, { data: { status: 'DONE' } })
  await page.goto('/work-outline')
  await editor(page).click()
  await page.keyboard.type(`@${existing.title}`)
  await expect(page.getByTestId('outline-mention-menu')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(editor(page).locator(`[data-outline-task="${existing.id}"]`)).toBeVisible()
  await expect(editor(page).locator('[data-outline-row]')).toHaveClass(/outline-row-done/)
  await editor(page).locator(`[data-outline-task="${existing.id}"]`).click()
  await expect(page.getByTestId('outline-side-panel')).toBeVisible()
  await expect(page.getByTestId('outline-side-panel')).toContainText(existing.title)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('outline-side-panel')).not.toBeVisible()
  await page.getByRole('button', { name: '移除 Task 引用', exact: true }).click()
  await expect(editor(page).locator('[data-outline-task]')).toHaveCount(0)
  expect((await request.get(`/api/tasks/${existing.id}`)).ok()).toBe(true)
})

test('@ new Task moves focus into right form; actual Ctrl+Enter creates once and returns reference', async ({ page, request }) => {
  const title = `Created by outline ${uid()}`
  await page.goto('/work-outline')
  await editor(page).click()
  await page.keyboard.type(`@${title}`)
  await page.getByTestId('outline-new-task-option').click()
  const form = page.getByTestId('outline-create-form')
  await expect(form).toBeVisible()
  const input = form.getByRole('textbox', { name: '任务名称', exact: true })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(title)
  const response = page.waitForResponse(r => /\/work-outlines\/default\/rows\/.+\/task$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await input.press('Control+Enter')
  const result = await (await response).json()
  await expect(editor(page).locator(`[data-outline-task="${result.task.id}"]`)).toBeVisible()
  await expect(page.getByTestId('outline-side-panel')).toBeVisible()
  expect(result.task.status).toBe('PENDING')
  const tasks = await (await request.get('/api/tasks?status=PENDING,DOING,DONE')).json()
  expect(tasks.filter((t: any) => t.title === title)).toHaveLength(1)
})

test('completion inheritance respects independent child Task boundaries and parent all-done rollup', async ({ page, request }) => {
  const completed = await task(request, 'Completed parent'), active = await task(request, 'Active child')
  await request.put(`/api/tasks/${completed.id}`, { data: { status: 'DONE' } })
  const root = line('Direction'), own = line('Parent', 1, completed), plain = line('Plain', 2), grand = line('Grandchild', 3), independent = line('Independent', 2, active), inside = line('Inside', 3)
  await saveDocument(request, [root, own, plain, grand, independent, inside])
  await page.goto('/work-outline')
  for (const l of [own, plain, grand]) await expect(row(page, l.attrs.id)).toHaveClass(/outline-row-done/)
  for (const l of [root, independent, inside]) await expect(row(page, l.attrs.id)).not.toHaveClass(/outline-row-done/)
  await request.put(`/api/tasks/${active.id}`, { data: { status: 'DONE' } })
  for (const l of [root, independent, inside]) await expect(row(page, l.attrs.id)).toHaveClass(/outline-row-done/)
  await request.put(`/api/tasks/${active.id}`, { data: { status: 'PENDING' } })
  await expect(row(page, root.attrs.id)).not.toHaveClass(/outline-row-done/)
})

test('branch moves preserve IDs and references; deleting placement preserves Task history', async ({ page, request }) => {
  const linked = await task(request, 'Move branch')
  await request.post(`/api/tasks/${linked.id}/logs`, { data: { content: '<p>Preserved entry</p>', type: 'log' } })
  const first = line('First'), child = line('Child', 1, linked), second = line('Second')
  await saveDocument(request, [first, child, second])
  await page.goto('/work-outline')
  await focusEnd(page, first.attrs.id)
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.map(l => l.attrs.id)).toEqual([second.attrs.id, first.attrs.id, child.attrs.id])
  await editor(page).press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await stored(request)).content.filter(l => l.content?.some(n => n.type === 'taskRef')).length).toBe(0)
  expect((await request.get(`/api/tasks/${linked.id}`)).ok()).toBe(true)
  const entries = await (await request.get(`/api/tasks/${linked.id}/logs`)).json()
  expect(entries.some((e: any) => e.content.includes('Preserved entry'))).toBe(true)
})

test('closed-date summary and today time use Focus boundary and never leak today cached summary', async ({ page, request }) => {
  const linked = await task(request, 'Daily timeline')
  const info = await (await request.get('/api/settings/task-daily-summary')).json()
  const calendar = info.calendar
  const query = await (await request.post('/api/task-days/query', { data: { taskIds: [linked.id], fromDate: calendar.lastClosedWorkDate, toDate: calendar.currentWorkDate, includeTotals: true } })).json()
  const historical = query.columns.find((c: any) => !c.isCurrent), today = query.columns.find((c: any) => c.isCurrent)
  const db = fixtureDb()
  try {
    for (const [column, text] of [[historical, '昨日完成核对并记录结果'], [today, 'THIS_TODAY_SUMMARY_MUST_NEVER_APPEAR']] as const) {
      db.prepare('INSERT INTO task_daily_summaries(id,task_id,work_date,calendar_policy_id,period_start,period_end,summary_text,content_kind,input_fingerprint,evidence_json,source_entry_ids_json,model,prompt_version,generation,generated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(), linked.id, column.date, calendar.policyId, column.start, column.end, text, 'llm', 'fixture', '[]', '[]', 'fixture', 'fixture', 1, Date.now())
    }
    const now = Date.now()
    db.prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(uid(), linked.id, historical.start, historical.start + 3600000)
    db.prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(uid(), linked.id, Math.max(today.start, now - 600000), now)
  } finally { db.close() }
  await saveDocument(request, [line('Daily task ', 0, linked)])
  await page.goto('/work-outline')
  await expect(page.getByTestId('outline-grid-scroll')).toContainText('昨日完成核对并记录结果')
  await expect(page.getByTestId('outline-grid-scroll')).not.toContainText('THIS_TODAY_SUMMARY_MUST_NEVER_APPEAR')
  const fresh = await (await request.post('/api/task-days/query', { data: { taskIds: [linked.id], fromDate: today.date, toDate: today.date } })).json()
  expect(fresh.cells[0].summary).toEqual({ availability: 'not_applicable', reason: 'date_not_closed' })
  expect(fresh.cells[0].recordedMs).toBeGreaterThan(0)
})

test('two-window conflicts preserve local edits and expose explicit conflict resolution', async ({ page, browser, request, baseURL }) => {
  const initial = line('Initial')
  await saveDocument(request, [initial])
  await page.goto('/work-outline')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  await page.route('**/api/work-outlines/default', async route => {
    if (route.request().method() === 'PUT') { started = true; await gate }
    await route.continue()
  })
  await focusEnd(page, initial.attrs.id)
  await page.keyboard.type(' local text')
  await expect.poll(() => started).toBe(true)
  const otherContext = await browser.newContext({ baseURL, locale: 'zh-CN' })
  const other = await otherContext.newPage()
  try {
    await other.goto('/work-outline')
    await focusEnd(other, initial.attrs.id)
    await other.keyboard.type(' remote text')
    await other.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => JSON.stringify(await stored(request))).toContain('remote text')
    release()
    await expect(page.locator('.outline-conflict')).toBeVisible()
    await expect(editor(page)).toContainText('local text')
    await expect(editor(page)).not.toContainText('remote text')
  } finally { release(); await otherContext.close() }
})

test('a database replacement cannot silently overwrite imported content even without an SSE event', async ({ page, request }) => {
  const initial = line('Before import')
  await saveDocument(request, [initial])
  await page.goto('/work-outline')
  const imported: OutlineDocument = { type: 'doc', schemaVersion: 1, content: [line('Imported backup')] }
  let replaced = false
  await page.route('**/api/work-outlines/default', async route => {
    if (route.request().method() === 'PUT' && !replaced) {
      replaced = true
      const db = fixtureDb()
      try {
        db.prepare('UPDATE work_outlines SET document_json=? WHERE id=?').run(JSON.stringify(imported), 'default')
        db.prepare('UPDATE _meta SET value=? WHERE key=?').run(uid(), 'work_outline_epoch')
      } finally { db.close() }
    }
    await route.continue()
  })
  await focusEnd(page, initial.attrs.id)
  await page.keyboard.type(' with unsaved edit')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.outline-conflict')).toBeVisible()
  await expect(editor(page)).toContainText('with unsaved edit')
  expect(await stored(request)).toEqual(imported)
  await page.getByRole('button', { name: '查看版本', exact: true }).click()
  await page.getByRole('button', { name: '采用服务器版本', exact: true }).click()
  await expect(editor(page)).toContainText('Imported backup')
})

test('folding, width changes and date navigation keep outline rows aligned with the table', async ({ page, request }) => {
  const linked = await task(request, 'Layout')
  const root = line('A long direction '.repeat(12)), child = line('Nested task ', 1, linked), leaf = line('Grandchild detail', 2)
  await saveDocument(request, [root, child, leaf])
  await page.goto('/work-outline')
  await expect(page.getByTestId('outline-date-row')).toHaveCount(3)
  async function aligned(id: string) {
    // ResizeObserver commits on the next animation frame. Read both rectangles
    // together after it settles, rather than comparing different render frames.
    await expect.poll(() => page.evaluate(rowId => {
      const outline = document.querySelector(`[data-outline-row="${rowId}"]`)?.getBoundingClientRect()
      const table = document.querySelector(`[data-testid="outline-date-row"][data-row-id="${rowId}"]`)?.getBoundingClientRect()
      return outline && table ? Math.max(Math.abs(outline.y - table.y), Math.abs(outline.height - table.height)) : Infinity
    }, id)).toBeLessThan(2)
  }
  await aligned(child.attrs.id)
  const handle = page.getByRole('separator', { name: '调整大纲宽度' })
  const box = await handle.boundingBox()
  await page.mouse.move(box!.x + 3, box!.y + 25); await page.mouse.down(); await page.mouse.move(box!.x + 130, box!.y + 25); await page.mouse.up()
  await aligned(child.attrs.id)
  await page.getByTestId('outline-fold').first().click()
  await expect(row(page, child.attrs.id)).not.toBeVisible()
  await expect(page.getByTestId('outline-date-row')).toHaveCount(1)
  await page.getByRole('button', { name: '展开分支', exact: true }).click()
  await expect(page.getByTestId('outline-date-row')).toHaveCount(3)
  await aligned(child.attrs.id)
  await page.getByTitle('上一周', { exact: true }).click()
  await expect(page.getByTestId('outline-grid-scroll')).not.toContainText('今天 · 仅工时')
  await page.getByRole('button', { name: '今天', exact: true }).click()
  await expect(page.getByTestId('outline-grid-scroll')).toContainText('今天 · 仅工时')
  await page.screenshot({ path: path.join(process.env.CHRONICLE_TEST_DATA_DIR!, 'work-outline.png'), fullPage: true })
})

test('historical cells expose evidence and refresh; source failures remain visible and recoverable', async ({ page, request }) => {
  const linked = await task(request, 'Evidence')
  const entry = await (await request.post(`/api/tasks/${linked.id}/logs`, { data: { content: '<p>Historical evidence content</p>', type: 'log' } })).json()
  const { calendar } = await (await request.get('/api/settings/task-daily-summary')).json()
  const db = fixtureDb()
  try { db.prepare("UPDATE task_entries SET work_date=?,work_date_source='explicit' WHERE id=?").run(calendar.lastClosedWorkDate, entry.id) } finally { db.close() }
  await saveDocument(request, [line('Inspect ', 0, linked)])
  await page.goto('/work-outline')
  const cell = page.locator(`[data-testid=outline-day-cell][data-date='${calendar.lastClosedWorkDate}'][data-task-id='${linked.id}']`)
  await cell.click()
  await expect(page.getByTestId('outline-day-details')).toContainText('Historical evidence content')
  await page.getByRole('button', { name: '重新检查摘要', exact: true }).click()
  await expect(page.getByTestId('outline-day-details')).toContainText('等待生成')
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  await page.route('**/api/task-days/query', route => route.fulfill({ status: 503, json: { error: 'Daily data unavailable' } }))
  await page.getByRole('button', { name: '今天', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Daily data unavailable' })).toBeVisible()
  await page.unroute('**/api/task-days/query')
  await page.getByRole('button', { name: '重试 / 关闭', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Daily data unavailable' })).not.toBeVisible()
})

test('deleting a Task leaves an editable dangling reference and IME Enter does not split a row', async ({ page, request }) => {
  const linked = await task(request, 'Dangling')
  const original = line('Keep text ', 0, linked)
  await saveDocument(request, [original])
  await request.delete(`/api/tasks/${linked.id}`)
  await page.goto('/work-outline')
  await expect(editor(page).locator('[data-outline-task]')).toHaveClass(/outline-task-missing/)
  await focusEnd(page, original.attrs.id)
  await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(editor(page).locator('[data-outline-row]')).toHaveCount(1)
  await page.keyboard.type(' Still editable')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => JSON.stringify(await stored(request))).toContain('Still editable')
})
