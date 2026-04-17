import { test, expect } from '@playwright/test'

test.describe('Phase 4: Task Status Enhancement', () => {
  test('T1: Task status flow - PENDING -> DOING -> DONE -> DOING -> DROPPED', async ({ page }) => {
    const res = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T1-UI Test', type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('http://localhost:8080/?lang=zh-CN')
    await page.waitForLoadState('networkidle')

    // Click on the task (use first() since duplicate tasks may exist)
    await page.getByText('T1-UI Test').first().click()
    await page.waitForTimeout(500)

    // PENDING: status badge "待开始" + Start button + Drop button
    const infoBar = page.getByTestId('workspace-info-bar')
    await expect(infoBar.locator('span').filter({ hasText: '待开始' })).toBeVisible()
    await expect(infoBar.getByRole('button', { name: '开始' })).toBeVisible()

    // Click Start
    await infoBar.getByRole('button', { name: '开始' }).click()
    await page.waitForTimeout(500)

    // DOING: status badge "进行中" + Done button (green) + Drop button (red border)
    await expect(infoBar.locator('span').filter({ hasText: '进行中' })).toBeVisible()
    await expect(infoBar.locator('button.bg-green-500')).toBeVisible()
    await expect(infoBar.locator('button.border-red-300')).toBeVisible()

    // Click Done (green button in info bar)
    await infoBar.locator('button.bg-green-500').click()
    await page.waitForTimeout(500)

    // DONE: status badge "已完成" + Redo button
    await expect(infoBar.locator('span').filter({ hasText: '已完成' })).toBeVisible()
    await expect(infoBar.locator('button').filter({ hasText: '重做' })).toBeVisible()

    // Click Redo
    await infoBar.locator('button').filter({ hasText: '重做' }).click()
    await page.waitForTimeout(500)

    // Back to DOING
    await expect(infoBar.locator('span').filter({ hasText: '进行中' })).toBeVisible()

    // Click Drop (the red-bordered button in info bar)
    await infoBar.locator('button.border-red-300').click()
    await page.waitForTimeout(500)

    // Drop dialog should appear
    await expect(page.getByPlaceholder('请输入废弃原因...')).toBeVisible()

    // Type reason and confirm
    await page.getByPlaceholder('请输入废弃原因...').fill('不需要了')
    await page.getByRole('button', { name: '废弃' }).last().click()
    await page.waitForTimeout(500)

    // Task should be removed from active view
    await expect(page.locator('h4').filter({ hasText: 'T1-UI Test' })).not.toBeVisible()
  })

  test('T2: Filter by Done and Dropped', async ({ page }) => {
    // Create and complete a task
    const res = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T2-Done', type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()
    await page.request.put(`http://localhost:8080/api/tasks/${task.id}`, { data: { status: 'DOING' } })
    await page.request.put(`http://localhost:8080/api/tasks/${task.id}/done`)

    // Create and drop a task
    const res2 = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T2-Dropped', type: 'TODO', priority: 'MEDIUM' }
    })
    const task2 = await res2.json()
    await page.request.post(`http://localhost:8080/api/tasks/${task2.id}/drop`, { data: { reason: '废弃测试' } })

    await page.goto('http://localhost:8080/?lang=zh-CN')
    await page.waitForLoadState('networkidle')

    // Click Done filter (in the filter bar, which is in the task list panel)
    const filterBar = page.locator('.border-r').locator('.h-10')
    await filterBar.locator('button').filter({ hasText: '完成' }).click()
    await page.waitForTimeout(500)
    await expect(page.getByText('T2-Done').first()).toBeVisible()

    // Click Dropped filter
    await filterBar.locator('button').filter({ hasText: '废弃' }).click()
    await page.waitForTimeout(500)
    await expect(page.getByText('T2-Dropped').first()).toBeVisible()

    // Click Active filter (the first "进行中" is the filter button, second is status badge)
    await filterBar.locator('button').filter({ hasText: '进行中' }).first().click()
    await page.waitForTimeout(500)
    await expect(page.getByText('T2-Done').first()).not.toBeVisible()
    await expect(page.getByText('T2-Dropped').first()).not.toBeVisible()
  })

  test('T3: Take Over / AFK workflow', async ({ page }) => {
    // Clean up any existing session from previous tests
    await page.request.post('http://localhost:8080/api/afk')

    const res = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T3-TakeOver', type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('http://localhost:8080/?lang=zh-CN')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    // Click to open task
    const taskButton = page.locator('button').filter({ hasText: 'T3-TakeOver' }).first()
    await taskButton.click()
    await page.waitForTimeout(500)

    const infoBar = page.getByTestId('workspace-info-bar')

    // Should see "Take Over" button (blue button in workspace)
    await expect(infoBar.locator('button.bg-blue-500').filter({ hasText: 'Take Over' })).toBeVisible()

    // Click Take Over
    await infoBar.locator('button.bg-blue-500').filter({ hasText: 'Take Over' }).click()
    await page.waitForTimeout(500)

    // Should see "AFK" button instead (amber button)
    await expect(infoBar.locator('button.bg-amber-500')).toBeVisible()

    // Wait 2 seconds
    await page.waitForTimeout(2000)

    // Click AFK
    await infoBar.locator('button.bg-amber-500').click()
    await page.waitForTimeout(500)

    // Should see "Take Over" button again
    await expect(infoBar.locator('button.bg-blue-500').filter({ hasText: 'Take Over' })).toBeVisible()

    // Verify session was recorded
    const sessionsRes = await page.request.get('http://localhost:8080/api/sessions?start=0&end=9999999999999')
    const sessions = await sessionsRes.json()
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions[0].endedAt).not.toBeNull()
  })

  test('T4: Report page - session section visible', async ({ page }) => {
    const res = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T4-Report', type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()
    await page.request.post(`http://localhost:8080/api/tasks/${task.id}/takeover`)
    await page.waitForTimeout(2000)
    await page.request.post('http://localhost:8080/api/afk')

    await page.goto('http://localhost:8080/report?lang=zh-CN')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    await page.screenshot({ path: '/Users/yanke/IdeaProjects/task-manager/test-report-page.png', fullPage: true })

    // Should see day/week/month tabs (use regex to match single character)
    await expect(page.locator('button').filter({ hasText: /^天$/ })).toBeVisible()
    await expect(page.locator('button').filter({ hasText: /^周$/ })).toBeVisible()
    await expect(page.locator('button').filter({ hasText: /^月$/ })).toBeVisible()

    // Should see stats labels
    await expect(page.getByText('在岗时长')).toBeVisible()
    await expect(page.getByText('工作时长')).toBeVisible()
    await expect(page.getByText('摸鱼时长')).toBeVisible()

    // Should see session data
    const sessionsRes = await page.request.get('http://localhost:8080/api/sessions?start=0&end=9999999999999')
    const sessions = await sessionsRes.json()
    expect(sessions.length).toBeGreaterThan(0)
  })

  test('T5: Cmd+N creates draft, Cmd+W cancels', async ({ page }) => {
    const res = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T5-CmdN', type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()
    await page.request.post(`http://localhost:8080/api/tasks/${task.id}/takeover`)

    await page.goto('http://localhost:8080/?lang=zh-CN')
    await page.waitForLoadState('networkidle')
    await page.getByText('T5-CmdN').first().click()
    await page.waitForTimeout(500)

    // Press Cmd+N
    await page.keyboard.press('Meta+n')
    await page.waitForTimeout(500)

    // Should show draft creation UI - check the input placeholder
    await expect(page.getByPlaceholder('输入任务标题...')).toBeVisible()

    // Press Cmd+W (should cancel since no content)
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(500)

    // Should be back to the task - check h1 title (not h4 list item)
    await expect(page.locator('h1').filter({ hasText: 'T5-CmdN' })).toBeVisible()

    // Clean up: AFK to close the restored session
    await page.request.post('http://localhost:8080/api/afk')
  })

  test('T6: Drop dialog - confirm disabled without reason', async ({ page }) => {
    const res = await page.request.post('http://localhost:8080/api/tasks', {
      data: { title: 'T6-DropValidation', type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('http://localhost:8080/?lang=zh-CN')
    await page.waitForLoadState('networkidle')
    await page.getByText('T6-DropValidation').first().click()
    await page.waitForTimeout(500)

    const infoBar = page.getByTestId('workspace-info-bar')

    // Click "废弃" button (the red-bordered one in info bar)
    await infoBar.locator('button.border-red-300').click()
    await page.waitForTimeout(500)

    // Drop dialog should appear
    await expect(page.getByPlaceholder('请输入废弃原因...')).toBeVisible()

    // Confirm button should be disabled when no reason
    const confirmButton = page.locator('button.bg-red-500').filter({ hasText: '废弃' })
    await expect(confirmButton).toBeDisabled()

    // Type a reason
    await page.getByPlaceholder('请输入废弃原因...').fill('test reason')
    await expect(confirmButton).not.toBeDisabled()

    // Cancel the dialog
    await page.getByRole('button', { name: '取消' }).click()
    await page.waitForTimeout(500)

    // Task should still be visible
    await expect(page.getByText('T6-DropValidation').first()).toBeVisible()
  })
})
