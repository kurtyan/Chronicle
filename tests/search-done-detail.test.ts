import { test, expect } from '@playwright/test'

test.describe('Search DONE task detail', () => {
  test('Search DONE task, view detail, exit search restores previous task', async ({ page }) => {
    // Clean up any existing session
    await page.request.post('http://localhost:8083/api/afk').catch(() => {})

    // Create a PENDING task (will be selected before search)
    const pendingName = `PreSearch-${Date.now()}`
    const res1 = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: pendingName, type: 'TODO', priority: 'MEDIUM' }
    })
    const pendingTask = await res1.json()

    // Create a DONE task (will be found via search)
    const doneName = `SearchDone-${Date.now()}`
    const res2 = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: doneName, type: 'TODO', priority: 'MEDIUM' }
    })
    const doneTask = await res2.json()
    await page.request.put(`http://localhost:8083/api/tasks/${doneTask.id}`, { data: { status: 'DOING' } })
    await page.request.put(`http://localhost:8083/api/tasks/${doneTask.id}/done`)

    // Navigate to the page
    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)

    // Select the PENDING task
    await page.locator('h4').filter({ hasText: pendingName }).first().click()
    await page.waitForTimeout(500)

    // Verify PENDING task is displayed on the right
    const infoBar = page.getByTestId('workspace-info-bar')
    await expect(infoBar.getByText('待开始')).toBeVisible()

    // Open search with Cmd+Shift+F
    await page.keyboard.press('Meta+Shift+F')
    await page.waitForTimeout(300)

    // Search for the DONE task
    const searchInput = page.getByPlaceholder('搜索任务...')
    await expect(searchInput).toBeVisible()
    await searchInput.fill(doneName)
    await searchInput.press('Enter')
    await page.waitForTimeout(500)

    // Click on the DONE search result
    const result = page.locator('[role="button"]').filter({ hasText: doneName }).first()
    await expect(result).toBeVisible()
    await result.click()
    await page.waitForTimeout(500)

    // Verify the right panel shows the DONE task
    await expect(infoBar.getByText('已完成')).toBeVisible()
    await expect(infoBar.getByRole('button', { name: '重做' })).toBeVisible()
    await expect(page.locator('h1').filter({ hasText: doneName })).toBeVisible()

    // Exit search mode: clear input, then Escape
    await searchInput.clear()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Verify the DONE task is NOT in the task list
    await expect(page.locator('h4').filter({ hasText: doneName })).not.toBeVisible()

    // Verify the pre-search PENDING task is restored on the right panel
    await expect(infoBar.getByText('待开始')).toBeVisible()
    await expect(page.locator('h1').filter({ hasText: pendingName })).toBeVisible()
  })

  test('Search DONE task when no task pre-selected, exit clears right panel', async ({ page }) => {
    // Clean up any existing session
    await page.request.post('http://localhost:8083/api/afk').catch(() => {})

    // Create a DONE task
    const doneName = `SearchDone-NoPre-${Date.now()}`
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: doneName, type: 'TODO', priority: 'MEDIUM' }
    })
    const doneTask = await res.json()
    await page.request.put(`http://localhost:8083/api/tasks/${doneTask.id}`, { data: { status: 'DOING' } })
    await page.request.put(`http://localhost:8083/api/tasks/${doneTask.id}/done`)

    // Navigate to the page
    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)

    // No task is selected yet — right panel should show the empty workspace
    const infoBar = page.getByTestId('workspace-info-bar')
    await expect(infoBar).not.toBeVisible()

    // Open search, find the DONE task
    await page.keyboard.press('Meta+Shift+F')
    await page.waitForTimeout(300)
    const searchInput = page.getByPlaceholder('搜索任务...')
    await expect(searchInput).toBeVisible()
    await searchInput.fill(doneName)
    await searchInput.press('Enter')
    await page.waitForTimeout(500)

    // Click the DONE search result
    const result = page.locator('[role="button"]').filter({ hasText: doneName }).first()
    await expect(result).toBeVisible()
    await result.click()
    await page.waitForTimeout(500)

    // Verify the right panel shows the DONE task
    await expect(infoBar.getByText('已完成')).toBeVisible()
    await expect(page.locator('h1').filter({ hasText: doneName })).toBeVisible()

    // Exit search mode
    await searchInput.clear()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Verify the right panel is cleared (empty workspace)
    await expect(infoBar).not.toBeVisible()
    await expect(page.locator('h1').filter({ hasText: doneName })).not.toBeVisible()
  })
})
