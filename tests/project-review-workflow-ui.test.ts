import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './helpers/projectFixtures'
import { selectProjectOption } from './helpers/projectSelect'
import { withProjectNavigation } from '../web/src/lib/projectNavigation'

test.use({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1728, height: 1117 } })

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const editor = (page: Page) => page.locator('.ProseMirror[contenteditable="true"]')
const currentPath = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search

async function seed(request: APIRequestContext) {
  const area = await (await request.post('/api/areas', { data: { name: unique('Review area') } })).json()
  const milestone = await (await request.post('/api/milestones', { data: {
    areaId: area.id, name: unique('Review milestone'), goal: 'Learn from the evidence.',
    completionCriteria: 'The outcome has been checked.',
  } })).json()
  const range = { start: Date.parse('2026-09-07T05:00:00+08:00'), end: Date.parse('2026-09-14T05:00:00+08:00') }
  const returnTo = `/projects?period=custom&start=2026-09-07&end=2026-09-13&view=list&selected=milestone%3A${milestone.id}&area=${area.id}&q=${encodeURIComponent(milestone.name)}&filters=1`
  return { area, milestone, range, returnTo }
}

async function seedReview(request: APIRequestContext) {
  const data = await seed(request)
  const response = await request.post('/api/project-reviews', { data: {
    targetType: 'milestone', targetId: data.milestone.id, kind: 'periodic', locale: 'en',
    periodStart: data.range.start, periodEnd: data.range.end,
  } })
  expect(response.ok(), await response.text()).toBe(true)
  const review = await response.json()
  return { ...data, review, notesUrl: withProjectNavigation(`/notes?id=${review.noteId}&projectReview=${review.id}`, {
    returnTo: data.returnTo, range: data.range, periodLabel: 'Selected period',
  }) }
}

test('the selected period and object survive writing, reloading, confirming and returning from a review', async ({ page, request }) => {
  const { milestone, returnTo } = await seed(request)
  const { offset } = await (await request.get('/api/settings/start-of-day-offset')).json()
  const expectedStart = Date.parse('2026-09-07T00:00:00+08:00') + offset * 3_600_000
  const expectedEnd = Date.parse('2026-09-14T00:00:00+08:00') + offset * 3_600_000
  await page.goto(returnTo)
  const reviews = page.getByTestId('project-object-workspace').getByTestId('project-reviews')
  await expect(reviews).toContainText('Using the current viewing period')
  await expect(reviews.getByText(/Review period · Sep 7, 2026/)).toBeVisible()
  await expect(reviews.getByLabel('Review start date', { exact: true })).toBeHidden()
  await expect(reviews.getByLabel('Review end date', { exact: true })).toBeHidden()
  const analysisCoverage = reviews.getByRole('button', { name: 'Analysis coverage', exact: true, includeHidden: true })
  await expect(analysisCoverage).toHaveCount(1)
  await expect(analysisCoverage).toBeHidden()
  await reviews.locator('summary').filter({ hasText: 'Change review period' }).click()
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('2026-09-07')
  await expect(reviews.getByLabel('Review end date', { exact: true })).toHaveValue('2026-09-13')
  await reviews.locator('summary').filter({ hasText: 'Change review period' }).click()
  const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project-reviews' && response.request().method() === 'POST')
  await reviews.getByRole('button', { name: 'New periodic review', exact: true }).click()
  const created = await createResponse
  expect(created.ok(), await created.text()).toBe(true)
  const review = await created.json()
  expect(review).toMatchObject({ targetId: milestone.id, periodStart: expectedStart, periodEnd: expectedEnd, status: 'draft' })
  expect(review.notePreview).toBeNull() // Template questions are not fabricated conclusions.
  await expect(page).toHaveURL(/\/notes\?id=/)
  const context = page.getByTestId('project-review-context')
  await expect(context).toContainText(`Review · ${milestone.name}`)
  expect(new URL(page.url()).searchParams.get('projectReturn')).toBe(returnTo)
  expect(new URL(page.url()).searchParams.get('projectStart')).toBe(String(expectedStart))
  const title = unique('Reusable recovery lesson')
  const reflection = 'The documented recovery path worked. Rehearse it after the next infrastructure change.'
  await page.getByPlaceholder('Untitled note').fill(title)
  await editor(page).fill(reflection)
  await context.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(context).toContainText('Latest changes saved.')
  expect((await (await request.get(`/api/project-reviews/${review.id}`)).json()).status).toBe('draft')
  await page.reload()
  await expect(context).toContainText(milestone.name)
  await expect(editor(page)).toContainText(reflection)
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context.getByText('Version 1 confirmed', { exact: true }).first()).toBeVisible()
  const confirmed = await (await request.get(`/api/project-reviews/${review.id}`)).json()
  const note = await (await request.get(`/api/notes/${review.noteId}`)).json()
  expect(confirmed.versions).toHaveLength(1)
  expect(confirmed.versions[0]).toMatchObject({ title, noteRevision: note.revision, contentHtml: note.contentHtml })
  expect(confirmed).toMatchObject({ confirmedTitle: title, confirmedPreview: reflection, periodStart: expectedStart, periodEnd: expectedEnd })
  expect((await (await request.get(`/api/milestones/${milestone.id}`)).json()).status).toBe(milestone.status)
  await context.getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect.poll(() => currentPath(page)).toBe(returnTo)
  await expect(page.getByTestId('project-object-workspace')).toHaveAttribute('data-project-object', milestone.id)
  const card = page.getByTestId('project-review-card')
  await expect(card.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(card).toContainText('Confirmed reflection')
  await expect(card).toContainText(reflection)
  await expect(reviews.getByLabel('Review start date', { exact: true })).toBeHidden()
  await reviews.locator('summary').filter({ hasText: 'Change review period' }).click()
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('2026-09-07')
})

test('a separately chosen review period stays visible and does not replace the overview return period', async ({ page, request }) => {
  const { milestone, returnTo } = await seed(request)
  const { offset } = await (await request.get('/api/settings/start-of-day-offset')).json()
  await page.goto(returnTo)
  const reviews = page.getByTestId('project-reviews')
  await expect(reviews.getByText(/Review period · Sep 7, 2026/)).toBeVisible()
  await reviews.locator('summary').filter({ hasText: 'Change review period' }).click()
  await reviews.getByLabel('Review start date', { exact: true }).fill('2026-09-15')
  await expect(reviews.getByRole('alert')).toContainText('The review end date must be on or after the start date.')
  await expect(reviews.getByRole('button', { name: 'New periodic review', exact: true })).toBeDisabled()
  await expect(reviews.getByRole('button', { name: 'Use an existing note', exact: true })).toBeDisabled()
  await expect(reviews.getByRole('button', { name: 'Draft with AI', exact: true })).toBeDisabled()
  await reviews.getByLabel('Review start date', { exact: true }).fill('2026-09-09')
  await reviews.getByLabel('Review end date', { exact: true }).fill('2026-09-10')
  await expect(reviews.getByRole('alert')).toHaveCount(0)
  await expect(reviews).toContainText('Custom review period')
  const allTimeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/overview' && new URL(response.url()).searchParams.get('start') === '0')
  await selectProjectOption(page, 'Effort period', 'All time')
  const allTime = await (await allTimeResponse).json()
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('2026-09-09')
  await expect(reviews.getByLabel('Review end date', { exact: true })).toHaveValue('2026-09-10')
  await expect(reviews).toContainText('Custom review period')
  const refreshedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/overview' && new URL(response.url()).searchParams.get('start') === '0')
  await page.getByRole('button', { name: 'Refresh projects', exact: true }).click()
  const refreshed = await (await refreshedResponse).json()
  expect(refreshed.statistics.end).toBeGreaterThan(allTime.statistics.end)
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('2026-09-09')
  await expect(reviews).toContainText('Custom review period')
  await reviews.getByRole('button', { name: 'Use viewing period', exact: true }).click()
  await expect(reviews).toContainText('Using the current viewing period')
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('')
  await selectProjectOption(page, 'Effort period', 'Custom period')
  await expect(reviews.getByText(/Review period · Sep 7, 2026/)).toBeVisible()
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('2026-09-07')
  await reviews.getByLabel('Review start date', { exact: true }).fill('2026-09-09')
  await reviews.getByLabel('Review end date', { exact: true }).fill('2026-09-10')
  const selectedOverviewPath = currentPath(page)
  await reviews.getByRole('button', { name: 'New periodic review', exact: true }).click()
  await expect(page).toHaveURL(/projectReview=/)
  const reviewId = new URL(page.url()).searchParams.get('projectReview')!
  const review = await (await request.get(`/api/project-reviews/${reviewId}`)).json()
  expect(review.periodStart).toBe(Date.parse('2026-09-09T00:00:00+08:00') + offset * 3_600_000)
  expect(review.periodEnd).toBe(Date.parse('2026-09-11T00:00:00+08:00') + offset * 3_600_000)
  const context = page.getByTestId('project-review-context')
  await expect(context).toContainText('Sep 9, 2026')
  await context.getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect.poll(() => currentPath(page)).toBe(selectedOverviewPath)
  await reviews.locator('summary').filter({ hasText: 'Change review period' }).click()
  await expect(reviews.getByLabel('Review start date', { exact: true })).toHaveValue('2026-09-07')
  await expect(page.getByTestId('project-review-card')).toContainText('Sep 9, 2026')
})

test('a selected object cannot start a review before the first overview reporting period has loaded', async ({ page, request }) => {
  const { area, milestone, returnTo } = await seed(request)
  const { offset } = await (await request.get('/api/settings/start-of-day-offset')).json()
  let release!: () => void
  let intercepted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { intercepted = resolve })
  await page.route('**/api/projects/overview*', async route => {
    if (new URL(route.request().url()).searchParams.get('areaId') === area.id) {
      intercepted()
      await gate
    }
    await route.fallback()
  })
  try {
    await page.goto(returnTo)
    await requested
    // A selected URL may render the shell, but it cannot expose editors with
    // an unbounded placeholder scope while the overview request is pending.
    await expect(page.getByTestId('project-context-panel')).toHaveCount(0)
    await expect(page.getByTestId('project-reviews')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New periodic review', exact: true })).toHaveCount(0)
    expect((await (await request.get(`/api/project-reviews?targetType=milestone&targetId=${milestone.id}`)).json())).toHaveLength(0)
  } finally { release() }
  const reviews = page.getByTestId('project-reviews')
  await expect(reviews.getByText(/Review period · Sep 7, 2026/)).toBeVisible()
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project-reviews' && response.request().method() === 'POST')
  await reviews.getByRole('button', { name: 'New periodic review', exact: true }).click()
  const review = await (await createdResponse).json()
  expect(review).toMatchObject({ targetId: milestone.id,
    periodStart: Date.parse('2026-09-07T00:00:00+08:00') + offset * 3_600_000,
    periodEnd: Date.parse('2026-09-14T00:00:00+08:00') + offset * 3_600_000,
  })
})

test('confirmation waits for an in-flight Note save and includes text typed while it was saving', async ({ page, request }) => {
  const { review, notesUrl } = await seedReview(request)
  const confirmations: any[] = []
  let releaseSave!: () => void
  let saves = 0
  const gate = new Promise<void>(resolve => { releaseSave = resolve })
  await page.route(`**/api/notes/${review.noteId}`, async route => {
    if (route.request().method() === 'PUT' && ++saves === 1) await gate
    await route.fallback()
  })
  page.on('request', req => {
    if (new URL(req.url()).pathname === `/api/project-reviews/${review.id}/confirm`) confirmations.push(req.postDataJSON())
  })
  try {
    await page.goto(notesUrl)
    const context = page.getByTestId('project-review-context')
    await expect(context.getByRole('button', { name: 'Save & confirm review', exact: true })).toBeVisible()
    await editor(page).fill('The first observation is being saved.')
    await expect.poll(() => saves).toBe(1)
    await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
    await expect(context).toContainText('Saving latest changes…')
    const latest = 'The second observation was typed during the first save and must be part of this confirmation.'
    await editor(page).fill(latest)
    expect(confirmations).toHaveLength(0)
    releaseSave()
    await expect(context.getByText('Version 1 confirmed', { exact: true }).first()).toBeVisible()
    const saved = await (await request.get(`/api/notes/${review.noteId}`)).json()
    const confirmed = await (await request.get(`/api/project-reviews/${review.id}`)).json()
    expect(saves).toBe(2)
    expect(confirmations).toEqual([{ expectedNoteRevision: saved.revision, acknowledgeStaleEvidence: false }])
    expect(confirmed.versions).toHaveLength(1)
    expect(confirmed.versions[0]).toMatchObject({ noteRevision: saved.revision, contentHtml: saved.contentHtml })
    expect(confirmed.versions[0].contentHtml).toContain(latest)
  } finally { releaseSave() }
})

test('a failed Note save blocks confirmation and return while keeping the draft available for retry', async ({ page, request }) => {
  const { review, milestone, notesUrl } = await seedReview(request)
  let failSave = true
  let confirmations = 0
  await page.route(`**/api/notes/${review.noteId}`, async route => {
    if (failSave && route.request().method() === 'PUT') await route.fulfill({ status: 500, json: { error: 'Controlled save failure' } })
    else await route.fallback()
  })
  page.on('request', req => { if (new URL(req.url()).pathname === `/api/project-reviews/${review.id}/confirm`) confirmations++ })
  await page.goto(notesUrl)
  const context = page.getByTestId('project-review-context')
  await expect(context.getByRole('button', { name: 'Save & confirm review', exact: true })).toBeVisible()
  const reflection = 'This local reflection must survive a failed save.'
  await editor(page).fill(reflection)
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context).toContainText('The latest changes are not saved.')
  await context.getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect(context).toContainText('The latest changes are not saved.')
  expect(new URL(page.url()).pathname).toBe('/notes')
  await expect(editor(page)).toContainText(reflection)
  expect(confirmations).toBe(0)
  expect((await (await request.get(`/api/project-reviews/${review.id}`)).json()).status).toBe('draft')
  failSave = false
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context.getByText('Version 1 confirmed', { exact: true }).first()).toBeVisible()
  expect((await (await request.get(`/api/project-reviews/${review.id}`)).json()).versions[0].contentHtml).toContain(reflection)
})

test('a real Note revision conflict must be resolved before confirmation, and reload keeps the review context', async ({ page, request }) => {
  const { review, milestone, notesUrl, returnTo } = await seedReview(request)
  let confirmations = 0
  const saveStatuses: number[] = []
  page.on('request', req => { if (new URL(req.url()).pathname === `/api/project-reviews/${review.id}/confirm`) confirmations++ })
  page.on('response', response => { if (new URL(response.url()).pathname === `/api/notes/${review.noteId}` && response.request().method() === 'PUT') saveStatuses.push(response.status()) })
  await page.goto(notesUrl)
  const context = page.getByTestId('project-review-context')
  await expect(context.getByRole('button', { name: 'Save & confirm review', exact: true })).toBeVisible()
  const note = await (await request.get(`/api/notes/${review.noteId}`)).json()
  const remoteText = 'The remotely saved reflection must be read before confirming.'
  const remote = await request.put(`/api/notes/${review.noteId}`, { data: { expectedRevision: note.revision, contentHtml: `<p>${remoteText}</p>` } })
  expect(remote.ok(), await remote.text()).toBe(true)
  const localText = 'My competing draft remains visible until I choose a resolution.'
  await editor(page).fill(localText)
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context).toContainText('The latest changes are not saved.')
  expect(saveStatuses).toContain(409)
  await context.getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect(context).toContainText('The latest changes are not saved.')
  await expect(editor(page)).toContainText(localText)
  expect(confirmations).toBe(0)
  await page.getByRole('button', { name: 'Reload server version', exact: true }).click()
  await expect(editor(page)).toContainText(remoteText)
  await expect(context).toContainText(milestone.name)
  expect(new URL(page.url()).searchParams.get('projectReview')).toBe(review.id)
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context.getByText('Version 1 confirmed', { exact: true }).first()).toBeVisible()
  const confirmed = await (await request.get(`/api/project-reviews/${review.id}`)).json()
  expect(confirmed.versions).toHaveLength(1)
  expect(confirmed.versions[0].contentHtml).toContain(remoteText)
  expect(confirmed.versions[0].contentHtml).not.toContain(localText)
  await context.getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect.poll(() => currentPath(page)).toBe(returnTo)
})

test('ordinary Notes and untouched project-linked Notes keep their zero-write navigation behavior', async ({ page, request }) => {
  const { returnTo, range } = await seed(request)
  const note = await (await request.post('/api/notes', { data: { title: unique('An ordinary Note'), contentHtml: '<p>Existing text.</p>' } })).json()
  let noteWrites = 0
  let reviewReads = 0
  page.on('request', req => {
    if (new URL(req.url()).pathname === `/api/notes/${note.id}` && req.method() === 'PUT') noteWrites++
    if (new URL(req.url()).pathname.startsWith('/api/project-reviews') && req.method() === 'GET') reviewReads++
  })
  await page.goto(`/notes?id=${note.id}`)
  await expect(editor(page)).toContainText('Existing text.')
  await expect(page.getByTestId('project-review-context')).toHaveCount(0)
  await page.reload()
  await expect(editor(page)).toContainText('Existing text.')
  expect(noteWrites).toBe(0)
  expect(reviewReads).toBe(0)
  await page.goto(withProjectNavigation(`/notes?id=${note.id}`, { returnTo, range, periodLabel: 'Selected period' }))
  const context = page.getByTestId('project-review-context')
  await expect(context).toContainText('Selected period')
  await expect(context.getByRole('button', { name: 'Save & confirm review', exact: true })).toHaveCount(0)
  await context.getByRole('button', { name: 'Return to project', exact: true }).click()
  await expect.poll(() => currentPath(page)).toBe(returnTo)
  expect(noteWrites).toBe(0)
  expect((await (await request.get(`/api/notes/${note.id}`)).json()).revision).toBe(note.revision)
})

test('a stale-evidence response offers the captured sources and requires an explicit acknowledgement to retry', async ({ page, request }) => {
  const { review, milestone, range, notesUrl } = await seedReview(request)
  const insightId = unique('controlled-evidence-response')
  const sourceText = 'A captured source used to form this reflection.'
  // A controlled insight response exercises recovery without calling a model.
  // Note persistence and the final review confirmation still use the real API.
  const evidence = {
    version: 1, fingerprint: 'controlled-snapshot', scope: { targetType: 'milestone', targetId: milestone.id, periodStart: range.start, periodEnd: range.end },
    window: { ...range, asOf: range.end, timezone: 'Asia/Shanghai' }, target: milestone, metrics: {},
    sources: [{ id: 'captured-source', kind: 'target', entityId: milestone.id, title: milestone.name, content: sourceText, createdAt: milestone.createdAt, updatedAt: milestone.updatedAt, revision: milestone.revision, fingerprint: 'captured-target', role: 'primary' }],
    coverage: { totalSources: 1, totalCharacters: sourceText.length, includedSources: 1, includedCharacters: sourceText.length, complete: true, warnings: [] },
  }
  await page.route(`**/api/project-reviews/${review.id}`, async route => {
    const current = await (await request.get(`/api/project-reviews/${review.id}`)).json()
    await route.fulfill({ json: { ...current, insightDraftId: insightId } })
  })
  await page.route(`**/api/project-insights/${insightId}`, route => route.fulfill({ json: { evidence } }))
  const confirmations: any[] = []
  await page.route(`**/api/project-reviews/${review.id}/confirm`, async route => {
    const input = route.request().postDataJSON()
    confirmations.push(input)
    if (!input.acknowledgeStaleEvidence) await route.fulfill({ status: 409, json: { error: 'STALE_REVIEW_EVIDENCE' } })
    else await route.fallback()
  })
  await page.goto(notesUrl)
  const context = page.getByTestId('project-review-context')
  await expect(context.getByRole('button', { name: 'Save & confirm review', exact: true })).toBeVisible()
  await editor(page).fill('My reflection uses the captured source, with its limits understood.')
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context).toContainText('Sources changed. Review the captured evidence')
  expect((await (await request.get(`/api/project-reviews/${review.id}`)).json()).status).toBe('draft')
  await context.getByRole('button', { name: 'Review evidence & history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Review evidence & history', exact: true })
  await history.locator('summary').filter({ hasText: 'Evidence & sources (1/1 included)' }).click()
  await history.locator('summary').filter({ hasText: milestone.name }).click()
  await expect(history.getByText(sourceText, { exact: true })).toBeVisible()
  const acknowledgement = history.getByRole('checkbox', { name: 'Reviewed · use the captured evidence', exact: true })
  await expect(acknowledgement).not.toBeChecked()
  await acknowledgement.check()
  await history.getByRole('button', { name: 'Close', exact: true }).click()
  await context.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(context.getByText('Version 1 confirmed', { exact: true }).first()).toBeVisible()
  expect(confirmations.map(input => input.acknowledgeStaleEvidence)).toEqual([false, true])
  expect((await (await request.get(`/api/project-reviews/${review.id}`)).json()).versions).toHaveLength(1)
})
