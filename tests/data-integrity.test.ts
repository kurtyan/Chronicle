import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

async function createTask(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

test.describe('Task entry data integrity', () => {
  test('rejects HTTP writes from an untrusted browser origin', async ({ page }) => {
    const response = await page.request.post('/api/tasks', {
      headers: { Origin: 'https://evil.example' },
      data: { title: 'must not be created', type: 'TODO', priority: 'LOW' },
    })
    expect(response.status()).toBe(403)
  })

  test('allows a local Vite origin on a different port to save a note', async ({ page }) => {
    const origin = 'http://localhost:18090'
    const created = await page.request.post('/api/notes', {
      headers: { Origin: origin },
      data: { title: `LocalOrigin-${Date.now()}`, contentHtml: '<p>draft</p>', tags: [] },
    })
    expect(created.status()).toBe(201)
    expect(created.headers()['access-control-allow-origin']).toBe(origin)
    const note = await created.json()

    const updated = await page.request.put(`/api/notes/${note.id}`, {
      headers: { Origin: origin },
      data: {
        title: note.title,
        contentHtml: '<p>saved from Vite</p>',
        tags: note.tags,
        pinned: note.pinned,
        archived: note.archived,
        expectedRevision: note.revision,
      },
    })
    expect(updated.status()).toBe(200)
    expect(updated.headers()['access-control-allow-origin']).toBe(origin)
  })

  test('rejects invalid task domain values before they reach persistence', async ({ page }) => {
    const create = await page.request.post('/api/tasks', {
      data: { title: 'Invalid status', type: 'TODO', priority: 'LOW', status: 'BANANA' },
    })
    expect(create.status()).toBe(400)
  })

  test('never queries the UI-only draft task ID during local or SSE refreshes', async ({ page }) => {
    let draftRequestCount = 0
    await page.route('**/api/tasks/__draft__**', async (route) => {
      draftRequestCount++
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) })
    })

    await page.goto('/?lang=en')
    await page.getByRole('button', { name: 'New' }).first().click()
    await expect(page.getByPlaceholder('Task title...')).toBeVisible()

    const title = `ExternalSseRefresh-${Date.now()}`
    const created = await page.request.post('/api/tasks', {
      data: { title, type: 'TODO', priority: 'MEDIUM' },
    })
    expect(created.ok()).toBeTruthy()
    await expect(page.getByText(title)).toBeVisible()
    expect(draftRequestCount).toBe(0)
  })

  test('does not reuse a deleted task id', async ({ page }) => {
    const first = await createTask(page, `NoIdReuse-First-${Date.now()}`)
    const deleted = await page.request.delete(`/api/tasks/${first.id}`)
    expect(deleted.status()).toBe(204)
    const second = await createTask(page, `NoIdReuse-Second-${Date.now()}`)
    expect(second.id).not.toBe(first.id)
  })

  test('claims a durable draft task-id reservation instead of predicting the next id', async ({ page }) => {
    const reservation = await page.request.post('/api/tasks/reservations')
    expect(reservation.ok()).toBeTruthy()
    const { id: reservedId } = await reservation.json()

    const unrelated = await createTask(page, `Reservation-Unrelated-${Date.now()}`)
    expect(unrelated.id).not.toBe(reservedId)

    const claimed = await page.request.post('/api/tasks', {
      data: {
        title: `Reservation-Claimed-${Date.now()}`,
        type: 'TODO',
        priority: 'MEDIUM',
        reservedId,
        body: '<p>Attachment-bearing draft body</p>',
      },
    })
    expect(claimed.status()).toBe(201)
    expect((await claimed.json()).id).toBe(reservedId)

    const reused = await page.request.post('/api/tasks', {
      data: { title: 'Reservation must not be reused', type: 'TODO', priority: 'LOW', reservedId },
    })
    expect(reused.status()).toBe(409)
  })

  test('exports and restores a complete ZIP backup including recent writes and attachments', async ({ page }) => {
    const task = await createTask(page, `ExportSnapshot-${Date.now()}`)
    const attachmentPath = `/private/tmp/chronicle-playwright-data/attachments/${task.id}/evidence.txt`
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true })
    fs.writeFileSync(attachmentPath, 'backup attachment')
    const exported = await page.request.get('/api/settings/export')
    expect(exported.ok()).toBeTruthy()
    const bundle = await exported.body()
    expect(Buffer.from(bundle).subarray(0, 4).toString('ascii')).toBe('PK\x03\x04')

    fs.rmSync(path.dirname(attachmentPath), { recursive: true, force: true })
    const imported = await page.request.post('/api/settings/import', { multipart: { file: { name: 'chronicle-backup.zip', mimeType: 'application/zip', buffer: bundle } } })
    expect(imported.ok()).toBeTruthy()

    const restoredTask = await page.request.get(`/api/tasks/${task.id}`)
    expect(restoredTask.ok()).toBeTruthy()
    expect(fs.readFileSync(attachmentPath, 'utf8')).toBe('backup attachment')
  })

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

  test('search indexes technical tokens and ignores HTML tag noise', async ({ page }) => {
    const unique = Date.now()
    const technicalTask = await createTask(page, `Integrity-TechSearch-${unique}`)
    const htmlOnlyTask = await createTask(page, `Integrity-HtmlNoise-${unique}`)
    await page.request.post(`/api/tasks/${technicalTask.id}/logs`, {
      data: { content: '<p>OAuth2 react-native node_modules https://example.com/api</p>', type: 'log' },
    })
    await page.request.post(`/api/tasks/${htmlOnlyTask.id}/logs`, {
      data: { content: '<pre><code>No searchable marker in text</code></pre>', type: 'log' },
    })

    for (const query of [technicalTask.id, 'OAuth2', 'react-native', 'node_modules', 'https://example.com/api']) {
      const searchRes = await page.request.get(`/api/search?q=${encodeURIComponent(query)}`)
      expect(searchRes.ok()).toBeTruthy()
      const search = await searchRes.json()
      expect(search.results.some((result: { taskId: string }) => result.taskId === technicalTask.id)).toBeTruthy()
    }

    const htmlTagSearch = await (await page.request.get(`/api/search?q=${encodeURIComponent('code')}`)).json()
    expect(htmlTagSearch.results.some((result: { taskId: string }) => result.taskId === htmlOnlyTask.id)).toBeFalsy()
  })

  test('short English search does not fall back to substring matches inside longer words', async ({ page }) => {
    const unique = Date.now()
    const aiTask = await createTask(page, `Integrity-AI-${unique}`)
    const pairTask = await createTask(page, `Integrity-Pair-${unique}`)
    await page.request.post(`/api/tasks/${aiTask.id}/logs`, {
      data: { content: '<p>AI planning note</p>', type: 'log' },
    })
    await page.request.post(`/api/tasks/${pairTask.id}/logs`, {
      data: { content: '<p>Repair pair plain stairs</p>', type: 'log' },
    })

    const search = await (await page.request.get('/api/search?q=AI')).json()
    expect(search.results.some((result: { taskId: string }) => result.taskId === aiTask.id)).toBeTruthy()
    expect(search.results.some((result: { taskId: string }) => result.taskId === pairTask.id)).toBeFalsy()
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

  test('AFK event without submittedAt is bounded by the resumed session start', async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
    const task = await createTask(page, `Integrity-AfkAutoBound-${Date.now()}`)
    const triggeredAt = Date.now()
    const startedAt = triggeredAt + 10
    const resumeRes = await page.request.post(`/api/tasks/${task.id}/resume-from-afk`, {
      data: { startedAt },
    })
    expect(resumeRes.ok()).toBeTruthy()
    await page.waitForTimeout(20)

    const afkEventRes = await page.request.post('/api/afk-events', {
      data: { reason: 'idle', triggeredAt, userNote: 'submitted after auto resume' },
    })
    expect(afkEventRes.status()).toBe(201)
    const afkEvent = await afkEventRes.json()
    expect(afkEvent.submittedAt).toBe(startedAt)
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
