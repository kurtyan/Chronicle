import { test, expect } from '@playwright/test'

test.describe('Cmd+S Draft Entry', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
  })

  test('Cmd+S saves one draft entry and updates it on repeated saves', async ({ page }) => {
    const uniqueName = `DraftSave-${Date.now()}`
    const res = await page.request.post('/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    // Type content and Cmd+S
    await page.locator('.ProseMirror').fill('Hello draft content')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    // Entry list should show the draft entry
    const entryCount = await page.getByTestId('task-entry-block').count()
    expect(entryCount).toBe(1)

    // But verify the entry was saved to DB
    const entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    const entriesJson = await entries.json()
    expect(entriesJson.length).toBe(1)
    expect(entriesJson[0].content).toContain('Hello draft content')

    // Continue editing and Cmd+S again
    await page.locator('.ProseMirror').fill('Hello draft content updated')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    // Still one entry in UI
    const entryCount2 = await page.getByTestId('task-entry-block').count()
    expect(entryCount2).toBe(1)

    // Verify DB has only 1 entry (updated, not duplicated)
    const entries2 = await page.request.get(`/api/tasks/${task.id}/logs`)
    const entriesJson2 = await entries2.json()
    expect(entriesJson2.length).toBe(1)
    expect(entriesJson2[0].content).toContain('Hello draft content updated')
  })

  test('Submit Log shows entry in list and clears draft binding', async ({ page }) => {
    const uniqueName = `DraftSubmit-${Date.now()}`
    const res = await page.request.post('/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    // Type and Cmd+S — creates a draft entry
    await page.locator('.ProseMirror').fill('Draft before submit')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    // Verify entry in DB and UI
    let entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    let entriesJson = await entries.json()
    expect(entriesJson.length).toBe(1)
    expect(await page.getByTestId('task-entry-block').count()).toBe(1)

    // Type new content and Submit Log
    await page.locator('.ProseMirror').fill('Submit log content')
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '提交' }).click()
    await page.waitForTimeout(1000)

    // Submit updates the draft entry instead of duplicating it
    expect(await page.getByTestId('task-entry-block').count()).toBe(1)

    // Verify DB still has 1 entry
    entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    entriesJson = await entries.json()
    expect(entriesJson.length).toBe(1)
    expect(entriesJson[0].content).toContain('Submit log content')

    // Cmd+S after submit should create a NEW entry (binding was cleared)
    await page.locator('.ProseMirror').fill('New draft after submit')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    // DB should have 2 entries now
    entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    entriesJson = await entries.json()
    expect(entriesJson.length).toBe(2)
  })
})
