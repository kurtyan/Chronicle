import { test, expect } from './helpers/projectFixtures'

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

test('English milestone completion and review confirmation preserve the task and review history', async ({ page, context, request }) => {
  test.setTimeout(90_000)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'en-US' })
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-US', 'en'] })
  })
  await page.setViewportSize({ width: 1728, height: 1117 })
  const area = await (await request.post('/api/areas', { data: { name: unique('Platform reliability') } })).json()
  const milestone = await (await request.post('/api/milestones', { data: {
    areaId: area.id,
    name: unique('Validate recovery procedure'),
    goal: 'Recover service using the documented procedure.',
    completionCriteria: 'The recovery exercise succeeds and its evidence is reviewed.',
  } })).json()
  const task = await (await request.post('/api/tasks', { data: {
    title: unique('Document follow-up findings'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id,
  } })).json()

  // No ?lang override: the app must pick up the host language itself.
  await page.goto(`/projects/milestones/${milestone.id}`)
  await expect(page.getByRole('heading', { name: milestone.name, exact: true })).toBeVisible()
  await expect(page.getByTestId('project-detail-page')).not.toContainText(/[\u4e00-\u9fff]/)
  const detailBounds = await page.getByTestId('project-detail-page').boundingBox()
  expect(detailBounds?.width).toBeGreaterThan(1200)
  await page.getByRole('button', { name: 'Complete milestone', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Review milestone completion', exact: true })
  await expect(edit).toContainText(milestone.completionCriteria)
  await expect(edit).toContainText('Open tasks: 1. Task statuses will stay as they are.')
  await edit.getByRole('checkbox', { name: 'I have checked the outcome and confirm completion. I can add a review later.', exact: true }).check()
  await edit.getByRole('button', { name: 'Complete and save', exact: true }).click()
  await expect(edit).toHaveCount(0)
  const completed = await (await request.get(`/api/milestones/${milestone.id}`)).json()
  expect(completed.status).toBe('completed')
  expect(completed.reviewStatus).toBe('pending')
  expect((await (await request.get(`/api/tasks/${task.id}`)).json()).status).toBe(task.status)

  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project-reviews' && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'New completion review', exact: true }).click()
  const created = await createdResponse
  expect(created.ok(), await created.text()).toBe(true)
  const review = await created.json()
  await expect(page).toHaveURL(/\/notes\?id=/)
  const note = await (await request.get(`/api/notes/${review.noteId}`)).json()
  expect(note.title).toBe(`${milestone.name} · Completion review`)
  expect(note.contentHtml).not.toMatch(/[\u4e00-\u9fff]/)
  expect(note.tags).toEqual(['Review'])
  const body = page.locator('.ProseMirror[contenteditable="true"]')
  await expect(body).toContainText('Outcome and completion criteria')
  await expect(body).toContainText('Lessons and reusable insights')
  const reflection = 'The recovery exercise succeeded. Validate the procedure again after the next infrastructure change.'
  await body.fill(reflection)
  await expect.poll(async () => (await (await request.get(`/api/notes/${review.noteId}`)).json()).contentHtml).toContain(reflection)

  const reviewContext = page.getByTestId('project-review-context')
  await expect(reviewContext).toContainText(milestone.name)
  await reviewContext.getByRole('button', { name: 'Save & confirm review', exact: true }).click()
  await expect(reviewContext.getByText('Version 1 confirmed', { exact: true }).first()).toBeVisible()
  await reviewContext.getByRole('button', { name: 'Review evidence & history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Review evidence & history', exact: true })
  await expect(history.locator('summary').filter({ hasText: /^Version 1/ })).toBeVisible()
  await expect(history).toContainText(reflection)
  await history.getByRole('button', { name: 'Close', exact: true }).click()
  await reviewContext.getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect(page.getByText('Completion review · Confirmed', { exact: true })).toBeVisible()
  const confirmed = await (await request.get(`/api/project-reviews/${review.id}`)).json()
  expect(confirmed.status).toBe('confirmed')
  expect(confirmed.versions).toHaveLength(1)
  expect(confirmed.versions[0].contentHtml).toContain(reflection)
  expect(confirmed.versions[0].noteId).toBe(review.noteId)
  expect(confirmed.confirmedPreview).toContain(reflection)
  expect((await (await request.get(`/api/tasks/${task.id}`)).json()).status).toBe(task.status)
  await page.reload()
  await expect(page.getByText('Completion review · Confirmed', { exact: true })).toBeVisible()
})
