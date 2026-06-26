import { test, expect } from '@playwright/test'

test.describe('Pinned content', () => {
  test('rejects direct pinned creation through generic log APIs', async ({ page }) => {
    const taskRes = await page.request.post('/api/tasks', {
      data: { title: `PinnedApiGuard-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await taskRes.json()

    const singleRes = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>Hidden pinned content</p>', type: 'pinned' }
    })
    expect(singleRes.status()).toBe(400)

    const batchRes = await page.request.post('/api/tasks/logs/batch', {
      data: { taskIds: [task.id], content: '<p>Hidden pinned content</p>', type: 'pinned' }
    })
    expect(batchRes.status()).toBe(400)

    const entries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    const pinned = await (await page.request.get(`/api/tasks/${task.id}/pinned`)).json()
    expect(entries).toEqual([])
    expect(pinned.entry).toBeNull()
  })

  test('does not show stale pinned content while switching tasks', async ({ page }) => {
    const firstTask = await (await page.request.post('/api/tasks', {
      data: { title: `PinnedSwitchA-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })).json()
    const secondTask = await (await page.request.post('/api/tasks', {
      data: { title: `PinnedSwitchB-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })).json()

    await page.request.post(`/api/tasks/${firstTask.id}/pinned/append`, {
      data: { content: '<p>Only belongs to first task</p>' }
    })

    await page.goto(`/?lang=en`)
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: firstTask.title }).first().click()
    await expect(page.getByText('Only belongs to first task')).toBeVisible()

    await page.route(`**/api/tasks/${secondTask.id}/pinned`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue()
    })

    await page.locator('h4').filter({ hasText: secondTask.title }).first().click()
    await expect(page.getByText('Only belongs to first task')).not.toBeVisible()
    await expect(page.getByText('Only belongs to first task')).not.toBeVisible({ timeout: 1200 })
  })

  test('pin a log, append selected text, edit, and unpin', async ({ page }) => {
    // Create a task
    const taskRes = await page.request.post('/api/tasks', {
      data: { title: `PinnedTest-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await taskRes.json()

    // Add two log entries
    const log1 = await (await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>Branch: feature/pinned-content</p>', type: 'log' }
    })).json()
    const log2 = await (await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>PR link: https://github.com/example/repo/pull/42</p>', type: 'log' }
    })).json()

    await page.goto(`/?lang=en`)
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)

    // Select the task
    await page.locator('h4').filter({ hasText: task.title }).first().click()
    await page.waitForTimeout(500)

    // Pin the first log entry
    const firstEntry = page.getByTestId('task-entry-block').filter({ hasText: 'Branch: feature/pinned-content' })
    await firstEntry.hover()
    await firstEntry.getByTitle('Pin this log').click()
    await page.waitForTimeout(500)

    // Verify pinned section appears
    await expect(page.getByText('Pinned', { exact: true })).toBeVisible()
    const pinnedSection = page.locator('.max-w-\\[560px\\]').filter({ hasText: 'Pinned' })
    const logList = page.locator('[data-testid="task-entry-block"]')
    await expect(pinnedSection.getByText('Branch: feature/pinned-content')).toBeVisible()

    // The original log entry remains in the normal log list (single consolidated pin appends content)
    await expect(logList).toHaveCount(2)

    // Select text in the second log and add to pin
    const secondEntry = page.getByTestId('task-entry-block').filter({ hasText: 'PR link' })
    const secondContent = secondEntry.locator('[data-testid="entry-content"]')
    await secondContent.evaluate((el) => {
      const p = el.querySelector('p')
      if (!p) return
      const range = document.createRange()
      range.selectNodeContents(p)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })
    await secondContent.dispatchEvent('mouseup')
    await page.waitForTimeout(300)

    const addToPin = page.getByText('Add to pin')
    await expect(addToPin).toBeVisible()
    await addToPin.click()
    await page.waitForTimeout(500)

    // Verify appended content inside the pinned section
    await expect(pinnedSection.getByText('https://github.com/example/repo/pull/42')).toBeVisible()

    // Edit pinned content
    await page.getByTitle('Edit pinned').click()
    await page.waitForTimeout(200)
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.fill('Updated pinned content')
    await page.getByRole('button', { name: 'Save' }).click()
    await page.waitForTimeout(500)
    await expect(pinnedSection.getByText('Updated pinned content')).toBeVisible()

    // Unpin
    await page.getByTitle('Unpin').click()
    await page.waitForTimeout(500)

    // Pinned section should be gone
    await expect(page.getByText('Pinned', { exact: true })).not.toBeVisible()

    // The unpinned content should appear as a new log entry
    await expect(logList.filter({ hasText: 'Updated pinned content' })).toHaveCount(1)
    await expect(logList).toHaveCount(3)
  })
})
