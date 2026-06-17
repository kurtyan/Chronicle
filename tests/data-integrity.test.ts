import { test, expect } from '@playwright/test'

async function createTask(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

test.describe('Task entry data integrity', () => {
  test('entry delete requires matching task id', async ({ page }) => {
    const taskA = await createTask(page, `Integrity-A-${Date.now()}`)
    const taskB = await createTask(page, `Integrity-B-${Date.now()}`)
    const entryRes = await page.request.post(`/api/tasks/${taskB.id}/logs`, {
      data: { content: '<p>belongs to task B</p>', type: 'log' },
    })
    expect(entryRes.ok()).toBeTruthy()
    const entry = await entryRes.json()

    const wrongTaskDelete = await page.request.delete(`/api/tasks/${taskA.id}/logs/${entry.id}`)
    expect(wrongTaskDelete.status()).toBe(404)

    const taskBEntries = await (await page.request.get(`/api/tasks/${taskB.id}/logs`)).json()
    expect(taskBEntries.some((item: { id: string }) => item.id === entry.id)).toBeTruthy()
  })

  test('search finds Chinese multi-token query despite tokenizer segmentation', async ({ page }) => {
    const task = await createTask(page, `Integrity-ChineseSearch-${Date.now()}`)
    const content = '<p>首都天安门广场出现一小撮暴徒。</p>'
    const entryRes = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content, type: 'log' },
    })
    expect(entryRes.ok()).toBeTruthy()

    const searchRes = await page.request.get(`/api/search?q=${encodeURIComponent('天安门 暴徒')}`)
    expect(searchRes.ok()).toBeTruthy()
    const search = await searchRes.json()
    expect(search.results.some((result: { taskId: string }) => result.taskId === task.id)).toBeTruthy()
  })
})
