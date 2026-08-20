import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 1, dayOffset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function formatZhDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function saveDayScript(page: Page, date: string, document: Record<string, any>) {
  const currentRes = await page.request.get(`/api/day-scripts/${date}`)
  expect(currentRes.ok()).toBeTruthy()
  const current = await currentRes.json()
  const saveRes = await page.request.put(`/api/day-scripts/${date}`, {
    data: {
      expectedRevision: current.revision ?? 0,
      document,
    },
  })
  expect(saveRes.ok()).toBeTruthy()
  return saveRes.json()
}

function paragraph(text: string, taskId?: string) {
  if (!taskId) return { type: 'paragraph', content: [{ type: 'text', text }] }
  const marker = text.indexOf('@')
  if (marker < 0) return { type: 'paragraph', content: [{ type: 'text', text }] }
  const before = text.slice(0, marker)
  const mention = text.slice(marker)
  return {
    type: 'paragraph',
    content: [
      ...(before ? [{ type: 'text', text: before }] : []),
      {
        type: 'text',
        text: mention,
        marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskId)}`, taskId } }],
      },
    ],
  }
}

function trailingLinkDocument(listType: 'orderedList' | 'bulletList' | null, text: string) {
  const linkedParagraph = {
    type: 'paragraph',
    content: [{
      type: 'text',
      text,
      marks: [{ type: 'link', attrs: { href: 'https://example.com/runbook', taskId: null } }],
    }],
  }
  if (!listType) return { type: 'doc', content: [linkedParagraph] }
  return {
    type: 'doc',
    content: [{
      type: listType,
      content: [{ type: 'listItem', content: [linkedParagraph] }],
    }],
  }
}

async function getTaskEntries(page: Page, taskId: string) {
  const res = await page.request.get(`/api/tasks/${taskId}/logs`)
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function startMockLlm(response: string | string[]) {
  const responses = Array.isArray(response) ? response : [response]
  const calls: any[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      calls.push(body ? JSON.parse(body) : {})
      const content = responses[Math.min(calls.length - 1, responses.length - 1)] ?? responses[responses.length - 1] ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${calls.length}`,
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock LLM server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

async function clearFocusEditor(page: Page) {
  const editor = page.locator('.day-script-editor.ProseMirror')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  return editor
}

test.describe('Focus rich editor and meeting task mentions', () => {
  test('focus editor supports list and code block input rules', async ({ page }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 1)

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('- list item')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('const value = 1')

    await expect(editor.locator('ul li')).toContainText('list item')
    await expect(editor.locator('pre code')).toContainText('const value = 1')
  })

  test('a trailing fence opens a code block without discarding text already on the line', async ({ page }) => {
    const date = uniqueScriptDate(1_050 + Math.floor(Math.random() * 100))
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('explain this ```')
    await page.keyboard.press('Enter')
    await expect(editor.locator(':scope > p').first()).toHaveText('explain this')
    await expect(editor.locator(':scope > p + pre > code')).toHaveCount(1)
  })

  test('fenced code remains in the current ordered list item in Focus and task logs', async ({ page }) => {
    const date = uniqueScriptDate(1_250 + Math.floor(Math.random() * 100))
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const focusEditor = await clearFocusEditor(page)
    await page.keyboard.type('1. ```')
    await page.keyboard.press('Enter')
    await expect(focusEditor.locator('ol > li')).toHaveCount(1)
    await expect(focusEditor.locator('ol > li > pre > code')).toHaveCount(1)
    await expect(focusEditor.locator('ol > li > p')).toHaveCount(1)
    await page.keyboard.type('const focusValue = 1')
    await expect(focusEditor.locator('ol > li > pre > code')).toHaveText('const focusValue = 1')

    const title = `ListCodeLog-${Date.now()}`
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.locator('h4').filter({ hasText: title }).first().click()
    const logEditor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await expect(logEditor).toBeVisible()
    await logEditor.click()
    await page.keyboard.type('1. ```')
    await page.keyboard.press('Enter')
    await expect(logEditor.locator('ol > li')).toHaveCount(1)
    await expect(logEditor.locator('ol > li > pre > code')).toHaveCount(1)
    await expect(logEditor.locator('ol > li > p')).toHaveCount(1)
    await page.keyboard.type('const logValue = 1')
    await expect(logEditor.locator('ol > li > pre > code')).toHaveText('const logValue = 1')
  })

  test('read-only task logs render stable markers for code-first list items', async ({ page }) => {
    const task = await createTask(page, `ReadOnlyListCode-${Date.now()}`)
    const logRes = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: {
        type: 'log',
        content: '<ol start="3"><li><pre><code>read-only code</code></pre></li></ol>',
      },
    })
    expect(logRes.ok()).toBeTruthy()

    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: task.title }).first().click()

    const entry = page.getByTestId('task-entry-block').filter({ hasText: 'read-only code' })
    const marker = entry.locator('[data-testid="entry-content"] ol > li > .chronicle-code-list-marker')
    await expect(marker).toBeVisible()
    await expect(marker).toHaveText('3.')
    await expect(entry.locator('[data-testid="entry-content"] ol > li > pre > code')).toHaveText('read-only code')
  })

  test('inline list fence preserves Focus task-link marks and appends code in the same item', async ({ page }) => {
    const task = await createTask(page, `FenceMark-${Date.now()}`)
    const date = uniqueScriptDate(1_350 + Math.floor(Math.random() * 100))
    await saveDayScript(page, date, {
      type: 'doc',
      content: [{
        type: 'orderedList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: `@${task.title}`,
                marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }],
              },
              { type: 'text', text: ' explain ```' },
            ],
          }],
        }],
      }],
    })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = page.locator('.day-script-editor.ProseMirror')
    const paragraph = editor.locator('ol > li > p')
    await paragraph.click()
    // Clicking a task-linked paragraph fires notifyCursorTask -> setActiveTask
    // (async navigation). Wait for the task detail to settle before End/Enter,
    // otherwise the code-fence Enter races the navigation and loses the selection.
    await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')

    await expect(editor.locator(`ol > li > p a[data-task-id="${task.id}"]`)).toHaveText(`@${task.title}`)
    await expect(paragraph).toContainText('explain')
    await expect(editor.locator('ol > li > p + pre > code')).toHaveCount(1)
    await expect(editor.locator('ol > li')).toHaveCount(1)
  })

  test('Focus list Tab and Shift+Tab indent and outdent list items', async ({ page }) => {
    const date = uniqueScriptDate(1_400 + Math.floor(Math.random() * 100))
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('1. first')
    await page.keyboard.press('Enter')
    await page.keyboard.type('second')
    await page.keyboard.press('Tab')
    await expect(editor.locator(':scope > ol > li > ol > li')).toHaveText('second')
    await page.keyboard.press('Shift+Tab')
    await expect(editor.locator(':scope > ol > li')).toHaveCount(2)
  })

  test('Focus shows an ordered-list marker immediately after typing the input shortcut', async ({ page }) => {
    const date = uniqueScriptDate(1_450 + Math.floor(Math.random() * 100))
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('1. ')

    const item = editor.locator(':scope > ol > li')
    const emptyParagraph = item.locator(':scope > p')
    await expect(item).toHaveCount(1)
    await expect(emptyParagraph).toHaveClass(/\bis-empty\b/)
    const emptyContent = await emptyParagraph.evaluate((paragraph) => getComputedStyle(paragraph, '::before').content)
    expect(emptyContent).not.toBe('none')
    expect(emptyContent).not.toContain('Task title')
    expect(await item.evaluate((listItem) => ({
      height: listItem.getBoundingClientRect().height,
      listStyleType: getComputedStyle(listItem).listStyleType,
    }))).toMatchObject({
      listStyleType: 'decimal',
    })
    expect(await item.evaluate((listItem) => listItem.getBoundingClientRect().height)).toBeGreaterThan(0)
  })

  test('focus editor keeps three dashes as ordinary text', async ({ page }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 40)

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('---')

    await expect(editor.locator('hr')).toHaveCount(0)
    await expect(editor.locator('p').first()).toContainText('---')
  })

  test('focus editor Home and End move within the current line', async ({ page }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 45)

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('abc')
    await page.keyboard.press('Home')
    await page.keyboard.type('X')
    await page.keyboard.press('End')
    await page.keyboard.type('Y')

    await expect(editor.locator('p').first()).toContainText('XabcY')
  })

  test('focus editor code block grows from one line up to ten visible lines', async ({ page }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 50)

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')

    const code = editor.locator('pre code').first()
    await expect(code).toBeVisible()
    const emptyMetrics = await code.evaluate((element) => {
      const pre = element.closest('pre')!
      const preStyle = window.getComputedStyle(pre)
      const codeStyle = window.getComputedStyle(element)
      return {
        height: pre.getBoundingClientRect().height,
        overflowY: preStyle.overflowY,
        lineHeight: Number.parseFloat(codeStyle.lineHeight),
        verticalPadding: Number.parseFloat(preStyle.paddingTop) + Number.parseFloat(preStyle.paddingBottom),
      }
    })
    expect(emptyMetrics.height).toBeLessThan(120)

    await page.keyboard.type(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'))
    const fullMetrics = await code.evaluate((element) => {
      const pre = element.closest('pre')!
      const preStyle = window.getComputedStyle(pre)
      const codeStyle = window.getComputedStyle(element)
      return {
        height: pre.getBoundingClientRect().height,
        overflowY: preStyle.overflowY,
        scrollHeight: pre.scrollHeight,
        visibleCodeLines: (pre.getBoundingClientRect().height - (Number.parseFloat(preStyle.paddingTop) + Number.parseFloat(preStyle.paddingBottom))) / Number.parseFloat(codeStyle.lineHeight),
      }
    })
    expect(fullMetrics.visibleCodeLines).toBeGreaterThanOrEqual(9)
    expect(fullMetrics.visibleCodeLines).toBeLessThanOrEqual(12.5)
    expect(fullMetrics.height).toBeLessThan(360)
    expect(fullMetrics.scrollHeight - fullMetrics.height).toBeLessThanOrEqual(1)
  })

  test('focus editor persisted code blocks are not compressed by editor layout', async ({ page }) => {
    const date = uniqueScriptDate(1200 + Math.floor(Math.random() * 1000))
    const codeLines = Array.from({ length: 12 }, (_, index) => `${index + 1}`).join('\n')

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '10:00-10:20 @persisted-code ✅' }] },
        { type: 'codeBlock', attrs: { language: null, softWrap: true }, content: [{ type: 'text', text: codeLines }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'after code block' }] },
      ],
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = page.locator('.day-script-editor.ProseMirror')
    const code = editor.locator('pre code').first()
    await expect(code).toContainText('12')
    const readMetrics = () => code.evaluate((element) => {
      const editorRoot = element.ownerDocument.querySelector('.day-script-editor.ProseMirror')!
      const pre = element.closest('pre')!
      const preStyle = window.getComputedStyle(pre)
      const codeStyle = window.getComputedStyle(element)
      const verticalPadding = (Number.parseFloat(preStyle.paddingTop) || 0) + (Number.parseFloat(preStyle.paddingBottom) || 0)
      const rawLineHeight = Number.parseFloat(codeStyle.lineHeight)
      const fontSize = Number.parseFloat(codeStyle.fontSize) || 16
      const lineHeight = Number.isFinite(rawLineHeight) ? rawLineHeight : fontSize * 1.5
      return {
        editorDisplay: window.getComputedStyle(editorRoot).display,
        height: pre.getBoundingClientRect().height,
        scrollHeight: pre.scrollHeight,
        overflowY: preStyle.overflowY,
        visibleCodeLines: (pre.getBoundingClientRect().height - verticalPadding) / lineHeight,
      }
    })
    await expect.poll(async () => (await readMetrics()).visibleCodeLines).toBeGreaterThanOrEqual(9)
    const metrics = await readMetrics()
    expect(metrics.editorDisplay).toBe('block')
    expect(metrics.visibleCodeLines).toBeGreaterThanOrEqual(9)
    expect(metrics.visibleCodeLines).toBeLessThanOrEqual(12.5)
    expect(metrics.scrollHeight - metrics.height).toBeLessThanOrEqual(1)
  })

  test('completing a task from the focus page keeps it visible', async ({ page }) => {
    const task = await createTask(page, `FocusComplete-${Date.now()}`)
    await page.request.put(`/api/tasks/${task.id}`, {
      data: { status: 'DOING' },
    })
    const date = uniqueScriptDate(Date.now() % 20 + 53)

    await saveDayScript(page, date, {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '10:00-10:20 ' },
          { type: 'text', text: `@${task.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }] },
          { type: 'text', text: ' finish it' },
        ],
      }],
    })

    await page.goto(`/today?date=${date}&task=${encodeURIComponent(task.id)}&lang=en`)
    await page.waitForLoadState('load')

    await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
    await expect(page.locator('.day-script-editor.ProseMirror')).toContainText(task.title)
    await page.getByRole('button', { name: 'Complete' }).click()

    await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
    await expect(page.getByTestId('workspace-info-bar').getByText('Done')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Redo' })).toBeVisible()
    await expect(page.locator('.day-script-editor.ProseMirror')).toContainText(task.title)
    await expect(page).toHaveURL(new RegExp(`task=${task.id}`))
  })

  test('clicking a focus task mention replaces an existing selected task without route thrash', async ({ page }) => {
    const firstTask = await createTask(page, `RouteFirst-${Date.now()}`)
    const secondTask = await createTask(page, `RouteSecond-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 54)

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '09:00-09:20 ' },
            { type: 'text', text: `@${firstTask.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(firstTask.id)}`, taskId: firstTask.id } }] },
            { type: 'text', text: ' first task' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '10:00-10:20 ' },
            { type: 'text', text: `@${secondTask.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(secondTask.id)}`, taskId: secondTask.id } }] },
            { type: 'text', text: ' second task' },
          ],
        },
      ],
    })

    await page.goto(`/today?date=${date}&task=${encodeURIComponent(firstTask.id)}&lang=en`)
    await page.waitForLoadState('load')
    await expect(page.getByRole('heading', { name: firstTask.title })).toBeVisible()

    const secondMention = page.locator('.day-script-editor.ProseMirror a[data-task-id="' + secondTask.id + '"]').first()
    await secondMention.click()

    await expect(page.getByRole('heading', { name: secondTask.title })).toBeVisible()
    await expect(page.getByRole('heading', { name: firstTask.title })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`task=${secondTask.id}`))

    await page.waitForTimeout(700)
    await expect(page.getByRole('heading', { name: secondTask.title })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`task=${secondTask.id}`))
  })

  test('submitting a new focus task keeps the created task selected without route thrash', async ({ page }) => {
    const existingTask = await createTask(page, `RouteExisting-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 56)
    const newTaskTitle = `RouteCreated-${Date.now()}`

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&task=${encodeURIComponent(existingTask.id)}&lang=en`)
    await page.waitForLoadState('load')
    await expect(page.getByRole('heading', { name: existingTask.title })).toBeVisible()

    const editor = await clearFocusEditor(page)
    await page.keyboard.type(`new task ${newTaskTitle}`)
    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/api/day-scripts/${date}`) && response.request().method() === 'PUT'),
      page.waitForResponse((response) => response.url().includes(`/api/day-scripts/${date}/submit-progress`) && response.request().method() === 'POST'),
      page.keyboard.press('Control+Enter'),
    ])

    await expect(page.getByRole('heading', { name: newTaskTitle })).toBeVisible()
    await expect(editor).toContainText(newTaskTitle)
    await expect(page).toHaveURL(/task=T\d+/)

    await page.waitForTimeout(800)
    await expect(page.getByRole('heading', { name: newTaskTitle })).toBeVisible()
    await expect(page.locator('main')).toBeVisible()
  })

  test('overall next steps board combines task summaries and focus carry-over', async ({ page }) => {
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const mock = await startMockLlm([
      JSON.stringify({
        latestProgress: 'Recommended task has context.',
        nextStep: '',
        recommendedNextStep: 'inspect mobile layout',
      }),
    ])
    const base = Date.now() % 20 + 70
    const date = uniqueScriptDate(base)
    const yesterday = uniqueScriptDate(base - 1)
    const explicitTask = await createTask(page, `OverallExplicit-${Date.now()}`)
    const recommendedTask = await createTask(page, `OverallRecommended-${Date.now()}`)
    const focusTask = await createTask(page, `OverallFocus-${Date.now()}`)
    const carryTask = await createTask(page, `OverallCarry-${Date.now()}`)

    try {
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: '', model: '' },
      })
      await page.request.post(`/api/tasks/${explicitTask.id}/logs`, {
        data: { content: '<p>下一步：ship release checklist</p>', type: 'log' },
      })
      const explicitSummaryRes = await page.request.post('/api/task-context/summarize', {
        data: { taskIds: [explicitTask.id] },
      })
      expect(explicitSummaryRes.ok()).toBeTruthy()

      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: mock.baseUrl, model: 'mock-model' },
      })
      await page.request.post(`/api/tasks/${recommendedTask.id}/logs`, {
        data: { content: '<p>Needs a recommendation.</p>', type: 'log' },
      })
      const summaryRes = await page.request.post('/api/task-context/summarize', {
        data: { taskIds: [recommendedTask.id] },
      })
      expect(summaryRes.ok()).toBeTruthy()

      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: '09:00-09:30 Carry over ' },
            { type: 'text', text: `@${carryTask.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(carryTask.id)}`, taskId: carryTask.id } }] },
            { type: 'text', text: ': yesterday carry work' },
          ],
        }],
      })
      await saveDayScript(page, date, {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: '10:00-10:20 ' },
            { type: 'text', text: `@${focusTask.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(focusTask.id)}`, taskId: focusTask.id } }] },
            { type: 'text', text: ' current focus action' },
          ],
        }],
      })

      await page.goto(`/today?date=${date}&lang=en`)
      await page.waitForLoadState('load')

      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      await expect(board).toContainText('Work overview')
      await expect(board).toContainText('Planned / carried')
      await expect(board).toContainText('Explicit')
      await expect(board).toContainText('Recommended')
      await expect(board).toContainText('Carry-over')
      await expect(board).toContainText('current focus action')
      await expect(board).toContainText('ship release checklist')
      await expect(board).toContainText('inspect mobile layout')
      await expect(board).toContainText('yesterday carry work')

      await board.getByRole('button', { name: 'Maximize overall next steps' }).click()
      const maximized = page.getByTestId('overall-next-steps-maximized')
      await expect(maximized).toBeVisible()
      await expect(maximized).toContainText('inspect mobile layout')
      await maximized.getByRole('button', { name: 'Close maximized overall next steps' }).click()
      await expect(maximized).toHaveCount(0)

      await board.getByRole('button', { name: 'Maximize overall next steps' }).click()
      await expect(page.getByTestId('overall-next-steps-maximized')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('overall-next-steps-maximized')).toHaveCount(0)

      const explicitAction = page.locator('[data-next-step-action-id="explicit:' + explicitTask.id + '"]')
      await explicitAction.getByRole('button', { name: 'Plan' }).click()
      await expect(page.locator('.day-script-editor.ProseMirror')).toContainText('ship release checklist')
      await expect(explicitAction).toContainText('In Focus')

      const recommendedAction = page.locator('[data-next-step-action-id="recommended:' + recommendedTask.id + '"]')
      await recommendedAction.click()
      await expect(page.getByRole('heading', { name: recommendedTask.title })).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`task=${recommendedTask.id}`))
      await expect(recommendedAction.getByRole('button', { name: 'Start Work' })).toHaveCount(0)

      const carryAction = page.locator('[data-next-step-action-id^="carry_over:"]').first()
      await carryAction.getByRole('button', { name: 'Plan' }).click()
      const editor = page.locator('.day-script-editor.ProseMirror')
      await expect(editor.locator(`a[data-task-id="${carryTask.id}"]`)).toHaveCount(1)
      await expect(editor).toContainText(`Carry over @${carryTask.title}: yesterday carry work`)
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('focus editor creates a new line after pasting a link with one Enter', async ({ page, context }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 55)

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => navigator.clipboard.writeText('https://example.com/runbook'))
    await page.keyboard.press('ControlOrMeta+V')
    await expect(editor.locator('a[href="https://example.com/runbook"]')).toBeVisible()

    await page.keyboard.press('Enter')
    await page.keyboard.type('next line')

    await expect(editor.locator('p').nth(0)).toContainText('https://example.com/runbook')
    await expect(editor.locator('p').nth(1)).toContainText('next line')
    await expect(editor.locator('p').nth(1).locator('a')).toHaveCount(0)
  })

  test('focus editor continues lists and clears the link mark after a trailing link', async ({ page }) => {
    const cases: Array<{ listType: 'orderedList' | 'bulletList' | null; selector: string; label: string }> = [
      { listType: 'orderedList', selector: 'ol', label: 'ordered list' },
      { listType: 'bulletList', selector: 'ul', label: 'bullet list' },
      { listType: null, selector: '', label: 'paragraph' },
    ]

    for (const [index, scenario] of cases.entries()) {
      await test.step(scenario.label, async () => {
        const date = uniqueScriptDate(1_500 + Math.floor(Math.random() * 1_000) + index)
        const linkText = `trailing link ${scenario.label}`
        await saveDayScript(page, date, trailingLinkDocument(scenario.listType, linkText))
        await page.goto(`/today?date=${date}&lang=en`)
        await page.waitForLoadState('load')

        const editor = page.locator('.day-script-editor.ProseMirror')
        const originalParagraph = scenario.listType
          ? editor.locator(`${scenario.selector} > li > p`).first()
          : editor.locator(':scope > p').first()
        await originalParagraph.locator('a').evaluate((link) => {
          const editorElement = link.closest('[contenteditable="true"]') as HTMLElement
          editorElement.focus()
          const range = document.createRange()
          range.setStartAfter(link)
          range.collapse(true)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
        })
        await page.keyboard.press('Enter')

        if (scenario.listType) {
          const items = editor.locator(`${scenario.selector} > li`)
          await expect(items).toHaveCount(2)
          await expect(items.nth(0).locator('a')).toHaveText(linkText)
          await expect(items.nth(1).locator('p')).toBeEmpty()
          await expect(items.nth(1).locator('a')).toHaveCount(0)
          await page.keyboard.press('Backspace')
          await expect(items).toHaveCount(1)
          await page.keyboard.type(' plain text')
          await expect(items.nth(0)).toContainText(`${linkText} plain text`)
          await expect(items.nth(0).locator('a')).toHaveText(linkText)
        } else {
          const paragraphs = editor.locator(':scope > p')
          await expect(paragraphs).toHaveCount(2)
          await expect(paragraphs.nth(0).locator('a')).toHaveText(linkText)
          await expect(paragraphs.nth(1)).toBeEmpty()
          await expect(paragraphs.nth(1).locator('a')).toHaveCount(0)
        }
      })
    }
  })

  test('Backspace after a trailing link keeps a nested list at its current depth', async ({ page }) => {
    const date = uniqueScriptDate(2_600 + Math.floor(Math.random() * 100))
    const linkText = 'nested trailing link'
    await saveDayScript(page, date, {
      type: 'doc',
      content: [{
        type: 'orderedList',
        content: [{
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'parent item' }] },
            {
              type: 'orderedList',
              content: [
                {
                  type: 'listItem',
                  content: [{
                    type: 'paragraph',
                    content: [{
                      type: 'text',
                      text: linkText,
                      marks: [{ type: 'link', attrs: { href: 'https://example.com/nested', taskId: null } }],
                    }],
                  }],
                },
                { type: 'listItem', content: [{ type: 'paragraph' }] },
              ],
            },
          ],
        }],
      }],
    })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = page.locator('.day-script-editor.ProseMirror')
    const nestedItems = editor.locator(':scope > ol > li > ol > li')
    await nestedItems.nth(1).locator('p').evaluate((paragraph) => {
      const editorElement = paragraph.closest('[contenteditable="true"]') as HTMLElement
      editorElement.focus()
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      range.collapse(true)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.keyboard.press('Backspace')

    await expect(nestedItems).toHaveCount(1)
    await expect(editor.locator(':scope > ol > li')).toHaveCount(1)
    await page.keyboard.type(' plain text')
    await expect(nestedItems.first()).toContainText(`${linkText} plain text`)
    await expect(nestedItems.first().locator('a')).toHaveText(linkText)
  })

  test('focus editor renders new task badge as non-editable', async ({ page }) => {
    const task = await createTask(page, `NewBadgeTask-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 58)

    await saveDayScript(page, date, {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'newTaskBadge', attrs: { label: 'new' } },
          { type: 'text', text: ' ' },
          { type: 'text', text: `@${task.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }] },
        ],
      }],
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const badge = page.locator('.day-script-editor.ProseMirror [data-day-script-new-task]').first()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('new')
    await expect(badge).toHaveAttribute('contenteditable', 'false')
  })

  test('focus editor autosaves the current draft after ten seconds of inactivity', async ({ page }) => {
    const task = await createTask(page, `AutosaveFocus-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 59)
    const progress = `autosaved draft progress ${Date.now()}`

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type(`10:00-10:30 @${task.title.slice(0, 12)}`)
    await page.getByRole('button', { name: new RegExp(task.title) }).first().click()
    await page.keyboard.press('Enter')
    await page.keyboard.type(progress)

    await expect.poll(async () => {
      const res = await page.request.get(`/api/day-scripts/${date}`)
      const script = await res.json()
      return JSON.stringify(script.document).includes(progress)
    }, { timeout: 15_000 }).toBeTruthy()

    await page.reload()
    await expect(editor).toContainText(progress)
  })

  test('Cmd+S saves a focus draft and Ctrl+Enter ignores unfinished progress', async ({ page }) => {
    const task = await createTask(page, `SubmitFocus-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 61)
    const progress = `unfinished submit progress ${Date.now()}`

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        paragraph(`10:00-10:30 @${task.title}`, task.id),
        paragraph(progress),
      ],
    })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = page.locator('.day-script-editor.ProseMirror')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+S')
    await expect.poll(async () => (await getTaskEntries(page, task.id)).length).toBe(0)

    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(500)
    await expect.poll(async () => (await getTaskEntries(page, task.id)).length).toBe(0)
  })

  test('Daily Summary opens after flushing an unsaved focus draft', async ({ page }) => {
    const task = await createTask(page, `SummaryFlush-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 62)
    const progress = `summary flush draft ${Date.now()}`

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    await clearFocusEditor(page)
    await page.keyboard.type(`10:00-10:30 @${task.title.slice(0, 12)}`)
    await page.getByRole('button', { name: new RegExp(task.title) }).first().click()
    await page.keyboard.press('Enter')
    await page.keyboard.type(progress)

    await page.getByLabel('Generate Daily Summary with LLM').click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Daily Summary' })).toBeVisible()
    await expect.poll(async () => {
      const res = await page.request.get(`/api/day-scripts/${date}`)
      const script = await res.json()
      return JSON.stringify(script.document).includes(progress)
    }, { timeout: 5000 }).toBeTruthy()
  })

  test('Plan Today opens after flushing an unsaved focus draft', async ({ page }) => {
    const task = await createTask(page, `PlanFlush-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 63)
    const progress = `plan flush draft ${Date.now()}`

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    await clearFocusEditor(page)
    await page.keyboard.type(`10:00-10:30 @${task.title.slice(0, 12)}`)
    await page.getByRole('button', { name: new RegExp(task.title) }).first().click()
    await page.keyboard.press('Enter')
    await page.keyboard.type(progress)

    await page.getByLabel('Plan Today with LLM task context').click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Plan Today' })).toBeVisible()
    await expect.poll(async () => {
      const res = await page.request.get(`/api/day-scripts/${date}`)
      const script = await res.json()
      return JSON.stringify(script.document).includes(progress)
    }, { timeout: 5000 }).toBeTruthy()
  })

  test('selecting a focus task mention opens that task detail immediately', async ({ page }) => {
    const task = await createTask(page, `MentionOpensDetail-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 60)

    await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = page.locator('.day-script-editor.ProseMirror')
    await editor.click()
    await page.keyboard.type(`10:00-11:00 @${task.title.slice(0, 12)}`)
    const option = page.getByRole('button', { name: new RegExp(task.title) }).first()
    await expect(option).toBeVisible()
    await option.click()

    await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
  })

  test('selecting another task mention replaces the existing mention on the focus line', async ({ page }) => {
    const taskA = await createTask(page, `ReplaceMentionA-${Date.now()}`)
    const taskB = await createTask(page, `ReplaceMentionB-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 65)

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type(`10:00-10:30 @${taskA.title.slice(0, 12)}`)
    const optionA = page.getByRole('button', { name: new RegExp(taskA.title) }).first()
    await expect(optionA).toBeVisible()
    await optionA.click()
    await page.keyboard.type(` follow up @${taskB.title.slice(0, 12)}`)
    const optionB = page.getByRole('button', { name: new RegExp(taskB.title) }).first()
    await expect(optionB).toBeVisible()
    await optionB.click()

    await expect(editor.locator('a[data-task-id]')).toHaveCount(1)
    await expect(editor.locator(`a[data-task-id="${taskB.id}"]`)).toContainText(`@${taskB.title}`)
    await expect(editor).not.toContainText(`@${taskA.title}`)
    await expect(editor.locator('p').first()).toContainText('follow up')
  })

  test('moving cursor across focus headers switches task detail', async ({ page }) => {
    const taskA = await createTask(page, `CursorHeaderA-${Date.now()}`)
    const taskB = await createTask(page, `CursorHeaderB-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 80)

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '10:00-10:30 ' },
            { type: 'text', text: `@${taskA.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskA.id)}`, taskId: taskA.id } }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'A progress' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '11:00-11:30 ' },
            { type: 'text', text: `@${taskB.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskB.id)}`, taskId: taskB.id } }] },
          ],
        },
      ],
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')

    const editor = page.locator('.day-script-editor.ProseMirror')
    await editor.getByText(taskA.title).click()
    await expect(page.getByRole('heading', { name: taskA.title })).toBeVisible()
    await expect(editor.locator('.day-script-line-header').filter({ hasText: taskA.title })).toBeVisible()

    await page.keyboard.press('Escape')
    await editor.getByText(taskB.title).click()
    await expect(page.getByRole('heading', { name: taskB.title })).toBeVisible()
    await expect(editor.locator('.day-script-line-header').filter({ hasText: taskB.title })).toBeVisible()
  })

  test('Cmd+Shift+R reschedules the selected Focus lines', async ({ page }) => {
    const taskA = await createTask(page, `RescheduleShortcutA-${Date.now()}`)
    const taskB = await createTask(page, `RescheduleShortcutB-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 100)

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '08:00-08:10 ' },
            { type: 'text', text: `@${taskA.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskA.id)}`, taskId: taskA.id } }] },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '08:10-08:25 ' },
            { type: 'text', text: `@${taskB.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskB.id)}`, taskId: taskB.id } }] },
          ],
        },
      ],
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    const editor = page.locator('.day-script-editor.ProseMirror')
    await editor.click()
    await page.keyboard.press('Meta+a')
    const rescheduled = page.waitForResponse((response) => response.url().includes(`/api/day-scripts/${date}/reschedule-focus`) && response.request().method() === 'POST')
    await page.keyboard.press('Meta+Shift+r')
    expect((await rescheduled).ok()).toBeTruthy()
    await expect(editor).not.toContainText('08:00-08:10')
    await expect(editor).not.toContainText('08:10-08:25')
  })

  test('Cmd+Shift+R reschedules a selected Focus task created from a new-task line', async ({ page }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 120)
    const title = `RescheduleCreatedTask-${Date.now()}`

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: `08:00-08:20 new task ${title}` }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Initial task body' }] },
      ],
    })
    const submitted = await page.request.post(`/api/day-scripts/${date}/submit-progress`, { data: {} })
    expect(submitted.ok()).toBeTruthy()
    expect((await submitted.json()).createdTasks).toHaveLength(1)

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    const editor = page.locator('.day-script-editor.ProseMirror')
    await editor.click()
    await page.keyboard.press('Meta+a')
    const rescheduled = page.waitForResponse((response) => response.url().includes(`/api/day-scripts/${date}/reschedule-focus`) && response.request().method() === 'POST')
    await page.keyboard.press('Meta+Shift+r')
    expect((await rescheduled).ok()).toBeTruthy()
    await expect(editor).not.toContainText('08:00-08:20')
    await expect(editor).toContainText(`@${title}`)
  })

  test('focus editor maps nested list progress edits to the owning task', async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
    const task = await createTask(page, `NestedProgress-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 30)

    await saveDayScript(page, date, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{
            type: 'text',
            text: `10:00-11:00 @${task.title}`,
            marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }],
          }],
        },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested progress' }] }],
          }],
        },
      ],
    })

    let takeoverCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(`/api/tasks/${task.id}/takeover`)) {
        takeoverCount += 1
      }
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    const editor = page.locator('.day-script-editor.ProseMirror')
    await editor.getByText('nested progress').click()
    await page.keyboard.type(' updated')

    await expect.poll(() => takeoverCount).toBe(1)
  })

  test('record meeting appends extracted content to mentioned task instead of creating a meeting task', async ({ page }) => {
    const task = await createTask(page, `MeetingMention-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const mock = await startMockLlm(JSON.stringify({
      title: 'Mentioned task sync',
      startedAt: '10:00',
      endedAt: '10:30',
      content: '<p>Decision: append this meeting note.</p>',
      participants: ['Alice'],
      tags: ['meeting'],
      warnings: [],
    }))

    try {
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: mock.baseUrl, model: 'mock-model' },
      })

      await page.goto('/?lang=en')
      await page.waitForLoadState('load')
      await page.getByRole('button', { name: 'Meeting' }).first().click()

      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Record Meeting')).toBeVisible()
      const inputEditor = dialog.locator('.ProseMirror').first()
      await inputEditor.click()
      await page.keyboard.type(`10:00-10:30 sync @${task.title.slice(0, 10)}`)
      await expect(page.getByRole('button', { name: task.title }).first()).toBeVisible()
      await page.keyboard.press('Enter')
      await page.keyboard.type(' discussed progress')

      await dialog.getByRole('button', { name: 'Extract' }).click()
      await expect(dialog.getByRole('button', { name: 'Append to Task Log' })).toBeVisible()
      await dialog.getByRole('button', { name: 'Append to Task Log' }).click()

      await expect(dialog).not.toBeVisible()

      const entriesRes = await page.request.get(`/api/tasks/${task.id}/logs`)
      expect(entriesRes.ok()).toBeTruthy()
      const entries = await entriesRes.json()
      expect(entries.some((entry: { content: string }) => (
        entry.content.includes('Mentioned task sync') &&
        entry.content.includes('Decision: append this meeting note.')
      ))).toBeTruthy()

      const afterTasksRes = await page.request.get('/api/tasks')
      expect(afterTasksRes.ok()).toBeTruthy()
      const tasks = await afterTasksRes.json()
      expect(tasks.some((item: { title: string }) => item.title === 'Mentioned task sync')).toBeFalsy()
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('focus page default date follows configured workday offset', async ({ page }) => {
    const offset = 23
    const now = new Date()
    const expected = formatZhDate(new Date(now.getTime() - offset * 3600_000))

    const saveOffset = await page.request.put('/api/settings/start-of-day-offset', { data: { offset } })
    expect(saveOffset.ok()).toBeTruthy()

    await page.goto('/today?lang=en')
    await page.waitForLoadState('load')

    await expect(page.getByText(expected)).toBeVisible()

    await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 5 } })
  })

  test('switching focus dates repeatedly keeps URL and editor stable', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))

    const date = uniqueScriptDate(90)
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    await expect(page.locator('.day-script-editor.ProseMirror')).toBeVisible()

    const previousDateButton = page.locator('section').first().locator('button').first()
    for (let i = 0; i < 8; i += 1) {
      await previousDateButton.click()
      await expect(page.locator('.day-script-editor.ProseMirror')).toBeVisible()
    }

    expect(page.url()).toContain(`date=${uniqueScriptDate(82)}`)
    expect(errors.join('\n')).not.toContain('Maximum update depth exceeded')
  })
})
