import { test, expect } from '@playwright/test'

test.describe('Phase 4: Task Status Enhancement', () => {
  test('T1: Task status flow - PENDING -> DOING -> DONE -> DOING -> DROPPED', async ({ page }) => {
    const uniqueName = `T1-UI-${Date.now()}`
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(300)

    // === Phase 1: PENDING ===
    // Click on the task
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    const infoBar = page.getByTestId('workspace-info-bar')
    await expect(infoBar.getByText('待开始')).toBeVisible()
    await expect(infoBar.getByRole('button', { name: '开始' })).toBeVisible()

    // Click Start → DOING
    await infoBar.getByRole('button', { name: '开始' }).click()
    await page.waitForTimeout(500)

    // === Phase 2: DOING ===
    await expect(infoBar.getByText('进行中')).toBeVisible()
    await expect(infoBar.locator('button.bg-green-500')).toBeVisible()
    await expect(infoBar.getByRole('button', { name: '废弃' })).toBeVisible()

    // === Phase 3: Mark as DONE via API ===
    await page.request.put(`http://localhost:8083/api/tasks/${task.id}`, { data: { status: 'DONE' } })

    // Reload page to get fresh data with DONE status
    await page.reload()
    await page.waitForLoadState('load')
    await page.waitForTimeout(300)

    // Switch to Done filter
    const doneFilterBtn = page.getByRole('button', { name: '完成' }).first()
    await doneFilterBtn.dispatchEvent('click')
    await page.waitForTimeout(500)

    // Click the task in Done list
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    const infoBar2 = page.getByTestId('workspace-info-bar')
    await expect(infoBar2.getByText('已完成')).toBeVisible()
    await expect(infoBar2.getByRole('button', { name: '重做' })).toBeVisible()

    // === Phase 4: Redo → back to DOING ===
    await page.request.put(`http://localhost:8083/api/tasks/${task.id}`, { data: { status: 'DOING' } })

    // Reload to get fresh data
    await page.reload()
    await page.waitForLoadState('load')
    await page.waitForTimeout(300)

    // Click the task in active list
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    const infoBar3 = page.getByTestId('workspace-info-bar')
    await expect(infoBar3.getByText('进行中')).toBeVisible()

    // === Phase 5: Drop ===
    await infoBar3.getByRole('button', { name: '废弃' }).click()
    await page.waitForTimeout(500)

    // Drop dialog should appear
    await expect(page.getByPlaceholder('请输入废弃原因...')).toBeVisible()

    // Type reason and confirm
    await page.getByPlaceholder('请输入废弃原因...').fill('不需要了')
    await page.getByRole('button', { name: '废弃' }).last().click()
    await page.waitForTimeout(500)

    // Reload page to verify task is dropped (status should be DROPPED, not visible in active list)
    await page.reload()
    await page.waitForLoadState('load')
    await page.waitForTimeout(300)

    // Task should NOT be visible in the active task list (DROPPED tasks are filtered out)
    await expect(page.locator('h4').filter({ hasText: uniqueName })).not.toBeVisible()
  })

  test('T2: Filter by Done and Dropped', async ({ page }) => {
    // Create and complete a task
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: `T2-Done-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()
    await page.request.put(`http://localhost:8083/api/tasks/${task.id}`, { data: { status: 'DOING' } })
    await page.request.put(`http://localhost:8083/api/tasks/${task.id}/done`)

    // Create and drop a task
    const res2 = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: `T2-Dropped-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })
    const task2 = await res2.json()
    await page.request.post(`http://localhost:8083/api/tasks/${task2.id}/drop`, { data: { reason: '废弃测试' } })

    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(300)

    // Click Done filter
    const doneFilterBtn = page.getByRole('button', { name: '完成' }).first()
    await doneFilterBtn.dispatchEvent('click')
    await page.waitForTimeout(500)
    await expect(page.getByText('T2-Done').first()).toBeVisible()

    // Click Dropped filter (this toggles from Done to Dropped)
    const droppedFilterBtn = page.getByRole('button', { name: '废弃' }).first()
    await droppedFilterBtn.dispatchEvent('click')
    await page.waitForTimeout(500)
    await expect(page.getByText('T2-Dropped').first()).toBeVisible()

    // Click Dropped again to toggle it off (clears filter, returns to active)
    await droppedFilterBtn.dispatchEvent('click')
    await page.waitForTimeout(500)
    await expect(page.getByText('T2-Done').first()).not.toBeVisible()
    await expect(page.getByText('T2-Dropped').first()).not.toBeVisible()
  })

  test('T3: Take Over / AFK workflow', async ({ page }) => {
    // Clean up any existing session from previous tests
    await page.request.post('http://localhost:8083/api/afk')

    const uniqueName = `T3-TakeOver-${Date.now()}`
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)

    // Click to open task
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    const infoBar = page.getByTestId('workspace-info-bar')

    // Should see "Take" button (label is "Take" not "Take Over")
    await expect(infoBar.getByRole('button', { name: 'Take' })).toBeVisible()

    // Click Take
    await infoBar.getByRole('button', { name: 'Take' }).click()
    await page.waitForTimeout(500)

    // Should see "AFK" button instead (amber button)
    await expect(infoBar.locator('button.bg-amber-500')).toBeVisible()

    // Wait 2 seconds
    await page.waitForTimeout(2000)

    // Click AFK
    await infoBar.locator('button.bg-amber-500').click()
    await page.waitForTimeout(500)

    // Should see "Take" button again
    await expect(infoBar.getByRole('button', { name: 'Take' })).toBeVisible()

    // Verify session was recorded
    const sessionsRes = await page.request.get('http://localhost:8083/api/sessions?start=0&end=9999999999999')
    const sessions = await sessionsRes.json()
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions[0].endedAt).not.toBeNull()
  })

  test('T4: Report page - session section visible', async ({ page }) => {
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: `T4-Report-${Date.now()}`, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()
    await page.request.post(`http://localhost:8083/api/tasks/${task.id}/takeover`)
    await page.waitForTimeout(2000)
    await page.request.post('http://localhost:8083/api/afk')

    await page.goto('http://localhost:8083/report?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.waitForTimeout(1000)

    // Should see day/week/month tabs
    await expect(page.locator('button').filter({ hasText: /^天$/ })).toBeVisible()
    await expect(page.locator('button').filter({ hasText: /^周$/ })).toBeVisible()
    await expect(page.locator('button').filter({ hasText: /^月$/ })).toBeVisible()

    // Should see stats labels
    await expect(page.getByText('在岗时长')).toBeVisible()
    await expect(page.getByText('工作时长')).toBeVisible()
    await expect(page.getByText('摸鱼时长')).toBeVisible()

    // Should see session data
    const sessionsRes = await page.request.get('http://localhost:8083/api/sessions?start=0&end=9999999999999')
    const sessions = await sessionsRes.json()
    expect(sessions.length).toBeGreaterThan(0)
  })

  test('T5: Cmd+N creates draft, ESC cancels', async ({ page }) => {
    const uniqueName = `T5-CmdN-${Date.now()}`
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()
    await page.request.post(`http://localhost:8083/api/tasks/${task.id}/takeover`)

    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    // Press Cmd+N
    await page.keyboard.press('Meta+n')
    await page.waitForTimeout(500)

    // Should show draft creation UI
    await expect(page.getByPlaceholder('输入任务标题...')).toBeVisible()

    // Press ESC to cancel draft (Cmd+W doesn't cancel drafts in this app)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Should be back to the task - check h1 title
    await expect(page.locator('h1').filter({ hasText: uniqueName })).toBeVisible()

    // Clean up: AFK to close the restored session
    await page.request.post('http://localhost:8083/api/afk')
  })

  test('T6: Drop dialog - confirm disabled without reason', async ({ page }) => {
    const uniqueName = `T6-DropValidation-${Date.now()}`
    const res = await page.request.post('http://localhost:8083/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('http://localhost:8083/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
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
    await expect(page.locator('h4').filter({ hasText: uniqueName }).first()).toBeVisible()
  })
})
