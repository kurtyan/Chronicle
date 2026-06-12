import { test, expect } from '@playwright/test'

test.describe('Cmd+S Draft Entry', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
  })

  test('Cmd+S saves a working draft without creating a formal log', async ({ page }) => {
    const uniqueName = `DraftSave-${Date.now()}`
    const res = await page.request.post('/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    await page.locator('.ProseMirror').fill('Hello draft content')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    await expect(page.locator('.ProseMirror')).toContainText('Hello draft content')
    expect(await page.getByTestId('task-entry-block').count()).toBe(0)

    const entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    const entriesJson = await entries.json()
    expect(entriesJson.length).toBe(0)

    const draft = await page.request.get(`/api/tasks/${task.id}/log-draft`)
    const draftJson = await draft.json()
    expect(draftJson.content).toContain('Hello draft content')

    await page.locator('.ProseMirror').fill('Hello draft content updated')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    expect(await page.getByTestId('task-entry-block').count()).toBe(0)

    const entries2 = await page.request.get(`/api/tasks/${task.id}/logs`)
    const entriesJson2 = await entries2.json()
    expect(entriesJson2.length).toBe(0)

    const draft2 = await page.request.get(`/api/tasks/${task.id}/log-draft`)
    const draftJson2 = await draft2.json()
    expect(draftJson2.content).toContain('Hello draft content updated')

    await page.reload()
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)
    await expect(page.locator('.ProseMirror')).toContainText('Hello draft content updated')
  })

  test('Submit Log creates one formal log and clears the working draft', async ({ page }) => {
    const uniqueName = `DraftSubmit-${Date.now()}`
    const res = await page.request.post('/api/tasks', {
      data: { title: uniqueName, type: 'TODO', priority: 'MEDIUM' }
    })
    const task = await res.json()

    await page.goto('/?lang=zh-CN')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: uniqueName }).first().click()
    await page.waitForTimeout(500)

    await page.locator('.ProseMirror').fill('Draft before submit')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    let entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    let entriesJson = await entries.json()
    expect(entriesJson.length).toBe(0)
    expect(await page.getByTestId('task-entry-block').count()).toBe(0)

    await page.locator('.ProseMirror').fill('Submit log content')
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '提交' }).click()
    await page.waitForTimeout(1000)

    expect(await page.getByTestId('task-entry-block').count()).toBe(1)

    entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    entriesJson = await entries.json()
    expect(entriesJson.length).toBe(1)
    expect(entriesJson[0].content).toContain('Submit log content')

    const draftAfterSubmit = await page.request.get(`/api/tasks/${task.id}/log-draft`)
    expect(await draftAfterSubmit.json()).toBeNull()

    await page.locator('.ProseMirror').fill('New draft after submit')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1000)

    entries = await page.request.get(`/api/tasks/${task.id}/logs`)
    entriesJson = await entries.json()
    expect(entriesJson.length).toBe(1)

    const draftAfterNewSave = await page.request.get(`/api/tasks/${task.id}/log-draft`)
    const draftAfterNewSaveJson = await draftAfterNewSave.json()
    expect(draftAfterNewSaveJson.content).toContain('New draft after submit')
  })
})
