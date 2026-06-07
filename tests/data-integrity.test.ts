import { test, expect } from '@playwright/test'

async function createTask(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function createPlanEntry(page: import('@playwright/test').Page, taskId: string, content: string, date: string, detailId?: string) {
  const res = await page.request.post('/api/plan-items/batch', {
    data: {
      planDate: date,
      items: [{
        taskId,
        content,
        estimatedMinutes: 30,
        estimatedStart: '',
        estimatedEnd: '',
        sortOrder: 0,
        detailId,
      }],
    },
  })
  expect(res.ok()).toBeTruthy()
  const items = await res.json()
  return items[0]
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

  test('deleting a plan-backed task entry removes its plan detail', async ({ page }) => {
    const task = await createTask(page, `Integrity-Plan-${Date.now()}`)
    const plan = await createPlanEntry(page, task.id, '<p>planned work</p>', '2099-01-01')
    const entries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    const entry = entries.find((item: { planDetailId?: string }) => item.planDetailId === plan.detailId)
    expect(entry).toBeTruthy()

    const deleteRes = await page.request.delete(`/api/tasks/${task.id}/logs/${entry.id}`)
    expect(deleteRes.status()).toBe(200)

    const afterEntries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    expect(afterEntries.some((item: { id: string }) => item.id === entry.id)).toBeFalsy()
    const planDeleteAgain = await page.request.delete(`/api/plan-items/${plan.detailId}`)
    expect(planDeleteAgain.status()).toBe(404)
  })

  test('deleting a plan item directly removes its task entry', async ({ page }) => {
    const task = await createTask(page, `Integrity-PlanDirect-${Date.now()}`)
    const plan = await createPlanEntry(page, task.id, '<p>direct plan delete</p>', '2099-01-04')

    const deleteRes = await page.request.delete(`/api/plan-items/${plan.detailId}`)
    expect(deleteRes.status()).toBe(204)

    const afterEntries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    expect(afterEntries.some((item: { planDetailId?: string }) => item.planDetailId === plan.detailId)).toBeFalsy()
  })

  test('deleting a carried-over unfinished plan entry succeeds from task detail', async ({ page }) => {
    const task = await createTask(page, `Integrity-Unfinished-${Date.now()}`)
    const original = await createPlanEntry(page, task.id, '<p>carry this work</p>', '2099-01-02')
    await createPlanEntry(page, task.id, '<p>carried work copy</p>', '2099-01-03', original.detailId)

    const entries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    const oldEntry = entries.find((item: { planDetailId?: string; planStatus?: string }) =>
      item.planDetailId === original.detailId && item.planStatus === 'UNFINISHED'
    )
    expect(oldEntry).toBeTruthy()

    const deleteRes = await page.request.delete(`/api/tasks/${task.id}/logs/${oldEntry.id}`)
    expect(deleteRes.status()).toBe(200)

    const afterEntries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    expect(afterEntries.some((item: { id: string }) => item.id === oldEntry.id)).toBeFalsy()
  })

  test('starting a carried-over unfinished plan entry revives it', async ({ page }) => {
    const task = await createTask(page, `Integrity-StartUnfinished-${Date.now()}`)
    const original = await createPlanEntry(page, task.id, '<p>start old carried work</p>', '2099-01-05')
    await createPlanEntry(page, task.id, '<p>new carried work copy</p>', '2099-01-06', original.detailId)

    const startRes = await page.request.put(`/api/plan-items/${original.detailId}`, {
      data: { status: 'DOING', actualStartedAt: Date.now() },
    })
    expect(startRes.ok()).toBeTruthy()

    const entries = await (await page.request.get(`/api/tasks/${task.id}/logs`)).json()
    const oldEntry = entries.find((item: { planDetailId?: string }) => item.planDetailId === original.detailId)
    expect(oldEntry.planStatus).toBe('DOING')
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
