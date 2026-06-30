import { test, expect } from '@playwright/test'

test.describe('Search DONE task detail', () => {
  test('Global search on Board closes with Escape', async ({ page }) => {
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+F' : 'Control+Shift+F')
    const searchInput = page.getByRole('dialog').getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(searchInput).not.toBeVisible()
  })

  test('Global search opens DONE task detail without adding it to the active list', async ({ page }) => {
    // Clean up any existing session
    await page.request.post('/api/afk').catch(() => {})

    // Create a PENDING task (will be selected before search)
    const pendingName = `PreSearch-${Date.now()}`
    const res1 = await page.request.post('/api/tasks', {
      data: { title: pendingName, type: 'TODO', priority: 'MEDIUM' }
    })
    const pendingTask = await res1.json()

    // Create a DONE task (will be found via search)
    const doneName = `SearchDone-${Date.now()}`
    const res2 = await page.request.post('/api/tasks', {
      data: { title: doneName, type: 'TODO', priority: 'MEDIUM' }
    })
    const doneTask = await res2.json()
    await page.request.put(`/api/tasks/${doneTask.id}`, { data: { status: 'DOING' } })
    await page.request.put(`/api/tasks/${doneTask.id}/done`)

    // Navigate to the page
    await page.goto('/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)

    // Select the PENDING task
    await page.locator('h4').filter({ hasText: pendingName }).first().click()
    await page.waitForTimeout(500)

    // Verify PENDING task is displayed on the right
    const infoBar = page.getByTestId('workspace-info-bar')
    await expect(infoBar.getByText('待开始')).toBeVisible()

    // Open global search with Cmd+Shift+F
    await page.keyboard.press('Meta+Shift+F')
    await page.waitForTimeout(300)

    // Search for the DONE task
    const searchInput = page.getByRole('dialog').getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()
    await searchInput.fill(doneName)

    // Click on the DONE search result
    const result = page.getByRole('dialog').getByRole('button').filter({ hasText: doneName }).first()
    await expect(result).toBeVisible()
    await result.click()
    await page.waitForTimeout(500)

    // Verify the right panel shows the DONE task
    await expect(infoBar.getByText('已完成')).toBeVisible()
    await expect(infoBar.getByRole('button', { name: '重做' })).toBeVisible()
    await expect(page.locator('h1').filter({ hasText: doneName })).toBeVisible()

    // Verify the DONE task is NOT in the task list
    await expect(page.locator('h4').filter({ hasText: doneName })).not.toBeVisible()
  })

  test('Global search opens DONE task when no task was pre-selected', async ({ page }) => {
    // Clean up any existing session
    await page.request.post('/api/afk').catch(() => {})

    // Create a DONE task
    const doneName = `SearchDone-NoPre-${Date.now()}`
    const res = await page.request.post('/api/tasks', {
      data: { title: doneName, type: 'TODO', priority: 'MEDIUM' }
    })
    const doneTask = await res.json()
    await page.request.put(`/api/tasks/${doneTask.id}`, { data: { status: 'DOING' } })
    await page.request.put(`/api/tasks/${doneTask.id}/done`)

    // Navigate to the page
    await page.goto('/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)

    // No task is selected yet — right panel should show the empty workspace
    const infoBar = page.getByTestId('workspace-info-bar')
    await expect(infoBar).not.toBeVisible()

    // Open global search, find the DONE task
    await page.keyboard.press('Meta+Shift+F')
    await page.waitForTimeout(300)
    const searchInput = page.getByRole('dialog').getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()
    await searchInput.fill(doneName)

    // Click the DONE search result
    const result = page.getByRole('dialog').getByRole('button').filter({ hasText: doneName }).first()
    await expect(result).toBeVisible()
    await result.click()
    await page.waitForTimeout(500)

    // Verify the right panel shows the DONE task
    await expect(infoBar.getByText('已完成')).toBeVisible()
    await expect(page.locator('h1').filter({ hasText: doneName })).toBeVisible()

    // Verify the DONE task is still not inserted into the active task list
    await expect(page.locator('h4').filter({ hasText: doneName })).not.toBeVisible()
  })
})
