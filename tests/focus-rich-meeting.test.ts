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

async function startMockLlm(response: string) {
  const calls: any[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      calls.push(body ? JSON.parse(body) : {})
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${calls.length}`,
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: response } }],
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
    expect(fullMetrics.visibleCodeLines).toBeLessThanOrEqual(10.6)
    expect(fullMetrics.height).toBeLessThan(360)
    expect(fullMetrics.scrollHeight).toBeGreaterThan(fullMetrics.height)
    expect(['auto', 'scroll']).toContain(fullMetrics.overflowY)
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

    await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
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
        },
      },
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

  test('focus editor maps nested list progress edits to the owning task', async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
    const task = await createTask(page, `NestedProgress-${Date.now()}`)
    const date = uniqueScriptDate(Date.now() % 20 + 30)

    await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
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
        },
      },
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
