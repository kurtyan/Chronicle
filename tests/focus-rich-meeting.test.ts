import { test, expect, type Page } from '@playwright/test'

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 1, dayOffset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

test.describe('Focus rich editor and meeting task mentions', () => {
  test('focus editor supports list and code block input rules', async ({ page }) => {
    const date = uniqueScriptDate(Date.now() % 20 + 1)

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
    await page.keyboard.type('- list item')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('const value = 1')

    await expect(editor.locator('ul li')).toContainText('list item')
    await expect(editor.locator('pre code')).toContainText('const value = 1')
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

    await page.route('**/api/meetings/extract', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          llmCallLogId: 'playwright-meeting-extract',
          title: 'Mentioned task sync',
          startedAt: Date.UTC(2099, 0, 1, 10, 0),
          endedAt: Date.UTC(2099, 0, 1, 10, 30),
          content: '<p>Decision: append this meeting note.</p>',
          participants: ['Alice'],
          tags: ['meeting'],
          rawContent: '<p>raw meeting note</p>',
          warnings: [],
        }),
      })
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
  })
})
