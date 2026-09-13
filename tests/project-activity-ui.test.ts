import { test, expect } from './helpers/projectFixtures'
import type { APIRequestContext } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test.use({ locale: 'en-US', viewport: { width: 1600, height: 1000 } })
const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

async function post(request: APIRequestContext, url: string, data: unknown) {
  const response = await request.post(url, { data })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}
function withFixtureDb(run: (db: any) => void) {
  const directory = process.env.CHRONICLE_TEST_DATA_DIR
  if (!directory || !fs.realpathSync(directory).startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)) throw new Error('An isolated temporary project-test database is required')
  const filename = path.join(directory, 'tasks.db')
  if (!fs.existsSync(filename)) throw new Error('Project-test database has not been initialized')
  const Database = createRequire(path.resolve('server/package.json'))('better-sqlite3')
  const db = new Database(filename, { fileMustExist: true })
  try { run(db) } finally { db.close() }
}
async function fixture(request: APIRequestContext, contentHtml = '<p>A specific lesson <strong>retained from the work</strong>.</p>') {
  const area = await post(request, '/api/areas', { name: unique('Evidence area') })
  const first = await post(request, '/api/milestones', { areaId: area.id, name: unique('Delivery evidence') })
  const second = await post(request, '/api/milestones', { areaId: area.id, name: unique('Practice evidence'), kind: 'ongoing' })
  const primary = await post(request, '/api/tasks', { title: unique('Investigation contribution'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: first.id })
  const followup = await post(request, '/api/tasks', { title: unique('Verification contribution'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: first.id })
  const related = await post(request, '/api/tasks', { title: unique('Practice contribution'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: second.id })
  const firstText = unique('Original investigation finding'), secondText = unique('Original practice finding')
  const firstLog = await post(request, `/api/tasks/${primary.id}/logs`, { content: `<p>${firstText}</p>`, type: 'log', silent: true })
  const secondLog = await post(request, `/api/tasks/${related.id}/logs`, { content: `<p>${secondText}</p>`, type: 'log', silent: true })
  const note = await post(request, '/api/notes', { title: unique('Retained outcome'), contentHtml })
  const linked = await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references: [{ targetType: 'milestone', targetId: first.id, role: 'outcome' }] } })
  expect(linked.ok(), await linked.text()).toBe(true)
  const referenced = await request.put('/api/project-references', { data: { sourceType: 'task', sourceId: related.id, expectedRevision: 1, references: [{ targetType: 'milestone', targetId: first.id }] } })
  expect(referenced.ok(), await referenced.text()).toBe(true)
  const end = Date.now() - 3_600_000, start = end - 3_600_000, asOf = end
  const firstSession = unique('original-investigation-session')
  withFixtureDb(db => {
    const insert = db.prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)')
    insert.run(firstSession, primary.id, start - 1_800_000, start + 1_800_000)
    insert.run(unique('verification-session'), followup.id, start + 1_800_000, start + 3_000_000)
    insert.run(unique('running-verification-session'), followup.id, start + 3_000_000, null)
    insert.run(unique('related-session'), related.id, start, start + 2_700_000)
    db.prepare('UPDATE task_entries SET created_at=? WHERE id=?').run(start + 600_000, firstLog.id)
    db.prepare('UPDATE task_entries SET created_at=? WHERE id=?').run(start + 900_000, secondLog.id)
    db.prepare('UPDATE notes SET created_at=?,updated_at=? WHERE id=?').run(start + 1_200_000, start + 1_200_000, note.id)
    db.prepare('UPDATE project_references SET created_at=? WHERE note_id=?').run(start + 1_200_000, note.id)
  })
  const query = new URLSearchParams({ projectReturn: `/projects?view=list&period=all&area=${area.id}&selected=milestone:${first.id}`, projectPeriod: 'Fixture hour', projectStart: String(start), projectEnd: String(end), projectAsOf: String(asOf), lang: 'en' })
  const detailUrl = `/projects/milestones/${first.id}?${query}`
  return { area, first, second, primary, followup, related, firstText, secondText, firstLog, note, firstSession, start, end, asOf, detailUrl }
}

test('the selected period conserves Task contributions and exposes original sessions and source records', async ({ page, request }) => {
  const data = await fixture(request)
  const activityResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/activity' && new URL(response.url()).searchParams.get('asOf') === String(data.asOf))
  await page.goto(data.detailUrl)
  const activity = await (await activityResponse).json()
  expect(activity.window).toEqual({ start: data.start, end: data.end, asOf: data.asOf })
  const panel = page.getByTestId('project-activity-panel')
  await expect(panel.getByText('1.0 h in this period · 2 tasks', { exact: true })).toBeVisible()
  const contributions = panel.getByTestId('project-activity-contribution')
  await expect(contributions).toHaveCount(2)
  await expect(contributions.filter({ hasText: data.primary.title }).getByText('30 min', { exact: true }).first()).toBeVisible()
  await expect(contributions.filter({ hasText: data.followup.title }).getByText('30 min', { exact: true }).first()).toBeVisible()
  await expect(contributions.filter({ hasText: data.related.title })).toHaveCount(0)
  const recorded = await (await request.get(`/api/projects/statistics?start=${data.start}&end=${data.end}&asOf=${data.asOf}`)).json()
  expect(recorded.byMilestone.find((group: any) => group.id === data.first.id).totalMs).toBe(3_600_000)
  expect(recorded.sessions.filter((session: any) => session.milestoneId === data.first.id).reduce((sum: number, session: any) => sum + session.durationMs, 0)).toBe(3_600_000)
  const investigation = contributions.filter({ hasText: data.primary.title })
  await investigation.locator('summary').click()
  await expect(investigation.getByText(data.firstSession, { exact: true })).toBeVisible()
  await expect(investigation.getByText(/Clipped to the selected period/)).toBeVisible()
  const records = panel.getByTestId('project-activity-record')
  await expect(records).toHaveCount(3)
  await expect(records.filter({ hasText: data.secondText })).toContainText('Related reference')
  const note = records.filter({ has: page.getByRole('button', { name: data.note.title, exact: true }) })
  await expect(note).toContainText('Note updated')
  await note.locator('summary').click()
  await expect(note.locator('.prose-mirror-display strong')).toHaveText('retained from the work')
  await expect(note.getByText(data.note.id, { exact: true })).toBeVisible()
})

test('switching objects ignores an older activity response and keeps the new object readable', async ({ page, request }) => {
  const data = await fixture(request)
  let release!: () => void
  let started = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/projects/activity?**', async route => {
    if (new URL(route.request().url()).searchParams.get('targetId') !== data.first.id) { await route.fallback(); return }
    const response = await request.get(route.request().url())
    started = true
    await gate
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: await response.text() })
  })
  try {
    await page.goto(`/projects?view=list&period=all&area=${data.area.id}&selected=milestone:${data.first.id}&lang=en`)
    await expect.poll(() => started).toBe(true)
    await page.locator(`[data-testid="milestone-card"][data-project-object="milestone:${data.second.id}"]`).click()
    const workspace = page.getByTestId('project-object-workspace')
    await expect(workspace.getByRole('heading', { name: data.second.name, exact: true })).toBeVisible()
    await expect(workspace.getByTestId('project-activity-record').filter({ hasText: data.secondText })).toBeVisible()
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/activity' && new URL(response.url()).searchParams.get('targetId') === data.first.id)
    release()
    await oldResponse
    await expect(workspace.getByRole('heading', { name: data.second.name, exact: true })).toBeVisible()
    await expect(workspace.getByTestId('project-activity-record').filter({ hasText: data.firstText })).toHaveCount(0)
    await expect(workspace.getByTestId('project-activity-contribution')).toHaveCount(1)
    await expect(workspace.getByTestId('project-activity-contribution')).toContainText(data.related.title)
  } finally { release() }
})

test('activity failure stays local, preserves recorded effort and can be retried', async ({ page, request }) => {
  const data = await fixture(request)
  let fail = false
  await page.route('**/api/projects/activity?**', async route => {
    if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Activity temporarily unavailable' }) })
    else await route.fallback()
  })
  await page.goto(data.detailUrl)
  const panel = page.getByTestId('project-activity-panel')
  await expect(panel.getByTestId('project-activity-record')).toHaveCount(3)
  fail = true
  await page.evaluate(() => window.dispatchEvent(new Event('chronicle:projects-changed')))
  await expect(panel.getByRole('alert')).toBeVisible()
  await expect(page.getByTestId('project-object-workspace').getByRole('heading', { name: data.first.name, exact: true })).toBeVisible()
  await expect(panel.getByText('1.0 h in this period · 2 tasks', { exact: true })).toBeVisible()
  await expect(panel.getByTestId('project-activity-record')).toHaveCount(3)
  fail = false
  await panel.getByRole('button', { name: 'Retry loading', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByTestId('project-activity-record')).toHaveCount(3)
  await expect(panel.getByRole('button', { name: 'Retry loading', exact: true })).toHaveCount(0)
})

test('source HTML is inert: no script, media request, form submission, navigation or saved-data write', async ({ page, request }) => {
  const payload = '<p>Readable source with a <strong>safe finding</strong>.</p>' +
    '<script>window.__activityExecuted=1;fetch("/api/activity-probe/script",{method:"POST"})</script>' +
    '<img src="/api/activity-probe/image" onerror="window.__activityExecuted=1">' +
    '<iframe src="/api/activity-probe/frame"></iframe><video poster="/api/activity-probe/poster"><source src="/api/activity-probe/video"></video>' +
    '<audio src="/api/activity-probe/audio"></audio><div style="background-image:url(/api/activity-probe/css)">Safe text</div>' +
    '<form action="/api/activity-probe/form" method="post"><input value="hidden mutation"><button>Submit malicious form</button></form>' +
    '<a href="/api/activity-probe/link" onclick="window.__activityExecuted=1">Inert source link</a>'
  const data = await fixture(request, payload)
  const unwanted: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/activity-probe/') || (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && /^\/api\/(tasks|notes|project-references)(\/|$)/.test(url.pathname))) unwanted.push(`${request.method()} ${url.pathname}`)
  })
  await page.route('**/api/activity-probe/**', route => route.abort())
  await page.addInitScript(() => { (window as any).__activityExecuted = 0 })
  await page.goto(data.detailUrl)
  const record = page.getByTestId('project-activity-record').filter({ has: page.getByRole('button', { name: data.note.title, exact: true }) })
  await record.locator('summary').click()
  const preview = record.locator('.prose-mirror-display')
  await expect(preview.locator('strong')).toHaveText('safe finding')
  await expect(preview.locator('script,img,iframe,video,audio,source,form,input,button,style,[style],[onclick],[onerror],[src],[href]')).toHaveCount(0)
  const previousUrl = page.url()
  await preview.getByText('Inert source link', { exact: true }).click()
  expect(page.url()).toBe(previousUrl)
  expect(await page.evaluate(() => (window as any).__activityExecuted)).toBe(0)
  expect(unwanted).toEqual([])
  const saved = await (await request.get(`/api/notes/${data.note.id}`)).json()
  expect(saved.contentHtml).toBe(payload)
  expect(saved.revision).toBe(data.note.revision)
  const task = await (await request.get(`/api/tasks/${data.primary.id}`)).json()
  expect(task.status).toBe('PENDING')
})

test('activity pagination keeps separate same-text logs and reuses the selected cutoff', async ({ page, request }) => {
  const data = await fixture(request)
  for (let i = 0; i < 22; i++) {
    const entry = await post(request, `/api/tasks/${data.primary.id}/logs`, { content: '<p>Same wording, separate recorded fact</p>', type: 'log', silent: true })
    withFixtureDb(db => db.prepare('UPDATE task_entries SET created_at=? WHERE id=?').run(data.start + 1000 + i, entry.id))
  }
  await page.goto(data.detailUrl)
  const panel = page.getByTestId('project-activity-panel')
  await expect(panel.getByTestId('project-activity-record')).toHaveCount(20)
  const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/activity' && new URL(response.url()).searchParams.get('offset') === '20')
  await panel.getByRole('button', { name: 'Load more records', exact: true }).click()
  const requestUrl = new URL((await nextResponse).url())
  expect(requestUrl.searchParams.get('asOf')).toBe(String(data.asOf))
  expect(requestUrl.searchParams.get('start')).toBe(String(data.start))
  expect(requestUrl.searchParams.get('end')).toBe(String(data.end))
  await expect(panel.getByTestId('project-activity-record')).toHaveCount(25)
  await expect(panel.getByTestId('project-activity-record').filter({ hasText: 'Same wording, separate recorded fact' })).toHaveCount(22)
  await expect(panel.getByText('Showing 25 of 25', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Load more records', exact: true })).toHaveCount(0)
})
