import { test, expect } from '@playwright/test'

async function createTaskWithTitle(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  return res.json()
}

async function openTask(page: import('@playwright/test').Page, title: string) {
  await page.goto('/?lang=zh-CN')
  await page.waitForLoadState('load')
  await page.locator('h4').filter({ hasText: title }).first().click()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
}

async function expectIdle(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    const res = await page.request.get('/api/sessions/current')
    return res.ok() ? await res.json() : null
  }).toBeNull()
}

test.describe('Auto takeover on actual edit', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
  })

  test('existing entry takeover waits for content change and fires once per edit session', async ({ page }) => {
    const title = `AutoTakeoverExisting-${Date.now()}`
    const task = await createTaskWithTitle(page, title)
    await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>Original entry</p>', type: 'log' },
    })

    let takeoverCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(`/api/tasks/${task.id}/takeover`)) {
        takeoverCount += 1
      }
    })

    await openTask(page, title)
    await page.getByTestId('task-entry-block').first().click()
    await expect(page.locator('[data-rich-editor="true"] .ProseMirror')).toBeVisible()
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Original entry updated')
    await expect.poll(() => takeoverCount).toBe(1)

    const currentSession = await (await page.request.get('/api/sessions/current')).json()
    expect(currentSession.taskId).toBe(task.id)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Original entry updated again')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(1)

    await page.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: 'AFK' }).click()
    await expectIdle(page)

    await page.getByTestId('task-entry-block').first().click()
    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Second edit session')
    await expect.poll(() => takeoverCount).toBe(2)
  })

  test('new entry takeover waits for user content and restored drafts do not fire', async ({ page }) => {
    const title = `AutoTakeoverNew-${Date.now()}`
    const task = await createTaskWithTitle(page, title)
    const restoredDraft = '<p>Restored draft content</p>'

    await page.addInitScript(({ taskId, content }) => {
      localStorage.setItem(`chronicle:entry_draft:${taskId}:__new__`, content)
    }, { taskId: task.id, content: restoredDraft })

    let takeoverCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(`/api/tasks/${task.id}/takeover`)) {
        takeoverCount += 1
      }
    })

    await openTask(page, title)
    await expect(page.locator('[data-rich-editor="true"] .ProseMirror')).toContainText('Restored draft content')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').click()
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Restored draft content changed')
    await expect.poll(() => takeoverCount).toBe(1)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Restored draft content changed again')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(1)

    await page.getByRole('button', { name: '提交记录' }).click()
    await expect(page.locator('[data-rich-editor="true"] .ProseMirror')).toBeEmpty()
    await page.getByRole('button', { name: 'AFK' }).click()
    await expectIdle(page)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Second new entry')
    await expect.poll(() => takeoverCount).toBe(2)
  })
})
