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

  test('resume from AFK starts a session at the detected return time and allows bounded AFK note', async ({ page }) => {
    const task = await createTask(page, `Integrity-ResumeAfk-${Date.now()}`)
    const takeoverRes = await page.request.post(`/api/tasks/${task.id}/takeover`)
    expect(takeoverRes.ok()).toBeTruthy()
    await page.request.post('/api/afk')

    const triggeredAt = Date.now() - 120_000
    const returnedAt = Date.now() - 30_000
    const resumeRes = await page.request.post(`/api/tasks/${task.id}/resume-from-afk`, {
      data: { startedAt: returnedAt },
    })
    expect(resumeRes.ok()).toBeTruthy()
    const session = await resumeRes.json()
    expect(session.taskId).toBe(task.id)
    expect(session.startedAt).toBe(returnedAt)

    const afkEventRes = await page.request.post('/api/afk-events', {
      data: { reason: 'idle', triggeredAt, submittedAt: returnedAt, userNote: 'returned automatically' },
    })
    expect(afkEventRes.status()).toBe(201)
    const afkEvent = await afkEventRes.json()
    expect(afkEvent.submittedAt).toBe(returnedAt)
  })

  test('AFK event rejects overlap with an active resumed session', async ({ page }) => {
    const task = await createTask(page, `Integrity-AfkOverlap-${Date.now()}`)
    const startedAt = Date.now() - 60_000
    const resumeRes = await page.request.post(`/api/tasks/${task.id}/resume-from-afk`, {
      data: { startedAt },
    })
    expect(resumeRes.ok()).toBeTruthy()

    const afkEventRes = await page.request.post('/api/afk-events', {
      data: { reason: 'idle', triggeredAt: startedAt - 60_000, submittedAt: startedAt + 10_000 },
    })
    expect(afkEventRes.status()).toBe(409)
  })

  test('resume from AFK moves pending task to doing', async ({ page }) => {
    const task = await createTask(page, `Integrity-ResumePending-${Date.now()}`)
    const startedAt = Date.now() - 10_000
    const resumeRes = await page.request.post(`/api/tasks/${task.id}/resume-from-afk`, {
      data: { startedAt },
    })
    expect(resumeRes.ok()).toBeTruthy()
    const updated = await (await page.request.get(`/api/tasks/${task.id}`)).json()
    expect(updated.status).toBe('DOING')
  })
})
