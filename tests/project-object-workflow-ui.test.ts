import { test, expect } from './helpers/projectFixtures'
import { selectProjectOption } from './helpers/projectSelect'
import { withProjectNavigation } from '../web/src/lib/projectNavigation'

test.use({ locale: 'en-US' })
const unique = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
async function seed(request: import('@playwright/test').APIRequestContext) {
  const area = await (await request.post('/api/areas', { data: { name: unique('Platform'), focus: 'Make delivery predictable' } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('Reliable release'), goal: 'Ship a verified release', completionCriteria: 'The release passed a real user journey', latestProgress: 'Baseline is working', nextStep: 'Validate the rollout with recorded evidence' } })).json()
  return { area, milestone }
}

test('Progress edits stay inline, survive closing and reload, and save only progress fields', async ({ page, request }) => {
  const { milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  const editor = page.getByTestId('project-inline-editor')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(editor.getByLabel('Name', { exact: true })).toHaveCount(0)
  const text = unique('Keep this assessment')
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).fill(text)
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).press('Escape')
  await expect(editor).toHaveCount(0)
  expect((await (await request.get(`/api/milestones/${milestone.id}`)).json()).latestProgress).toBe('Baseline is working')
  await page.reload()
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(text)
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/milestones/${milestone.id}`)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  expect(Object.keys(response.request().postDataJSON()).sort()).toEqual(['blockers', 'expectedRevision', 'latestProgress', 'nextStep'])
  await expect(page.getByTestId('project-object-progress')).toContainText(text)
})

test('A failed progress save retains the draft and a concurrent change requires explicit review', async ({ page, request }) => {
  const { milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  const editor = page.getByTestId('project-inline-editor')
  const text = unique('My assessment')
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).fill(text)
  await page.route(`**/api/milestones/${milestone.id}*`, route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }) : route.fallback())
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('alert')).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(text)
  await page.unroute(`**/api/milestones/${milestone.id}*`)
  const updated = await request.patch(`/api/milestones/${milestone.id}`, { data: { expectedRevision: milestone.revision, latestProgress: 'A newer assessment from elsewhere' } })
  expect(updated.ok()).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('chronicle:projects-changed')))
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(editor).toContainText('A newer assessment from elsewhere')
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(text)
  await editor.getByRole('button', { name: 'I reviewed the update; keep my draft', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect((await (await request.get(`/api/milestones/${milestone.id}`)).json()).latestProgress).toBe(text)
})

test('Scheduling contains only dates and never rewrites progress or goal', async ({ page, request }) => {
  const { milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  await page.getByRole('button', { name: 'Adjust schedule', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Adjust schedule', exact: true })
  await expect(dialog.locator('input')).toHaveCount(2)
  await expect(dialog.locator('textarea')).toHaveCount(0)
  await dialog.getByLabel('Start date (optional)', { exact: true }).fill('2026-10-01')
  await dialog.getByLabel('Target date (optional)', { exact: true }).fill('2026-10-10')
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/milestones/${milestone.id}`)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const response = await saved
  expect(Object.keys(response.request().postDataJSON()).sort()).toEqual(['expectedRevision', 'startDate', 'targetDate'])
  const current = await (await request.get(`/api/milestones/${milestone.id}`)).json()
  expect(current.goal).toBe(milestone.goal)
  expect(current.latestProgress).toBe(milestone.latestProgress)
})

test('Completing a milestone checks the outcome and offers a review without completing its task or stopping timing', async ({ page, request }) => {
  const { milestone } = await seed(request)
  const task = await (await request.post('/api/tasks', { data: { title: unique('Open work'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id } })).json()
  await request.post(`/api/tasks/${task.id}/takeover`)
  const beforeSession = await (await request.get('/api/sessions/current')).json()
  const beforeTask = await (await request.get(`/api/tasks/${task.id}`)).json()
  await page.goto(`/projects/milestones/${milestone.id}`)
  await page.getByRole('button', { name: 'Complete milestone', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review milestone completion', exact: true })
  await expect(dialog).toContainText(milestone.completionCriteria)
  await expect(dialog).toContainText(task.title)
  await expect(dialog.getByRole('button', { name: 'Complete and save', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Complete and save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Write a review', exact: true })).toBeVisible()
  expect((await (await request.get(`/api/tasks/${task.id}`)).json()).status).toBe(beforeTask.status)
  expect((await (await request.get('/api/sessions/current')).json()).id).toBe(beforeSession.id)
  expect((await (await request.get(`/api/milestones/${milestone.id}`)).json()).status).toBe('completed')
  await request.post('/api/afk')
})

test('Planning a next step creates an explicit inherited draft with source context and no Task or session write', async ({ page, request }) => {
  const { milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  const writes: string[] = []
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/(tasks|sessions|afk)(\/|$)/.test(new URL(request.url()).pathname)) writes.push(request.url()) })
  await page.getByRole('button', { name: 'Plan next step as a task', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(milestone.nextStep)
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText(milestone.nextStep)
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText(milestone.name)
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('chronicle:task_draft') || 'null'))
  expect(draft.primaryMilestoneId).toBe(milestone.id)
  expect(writes).toEqual([])
  const returnPath = new URL(page.url()).searchParams.get('projectReturn')!
  expect(new URL(returnPath, page.url()).pathname).toBe(`/projects/milestones/${milestone.id}`)
  expect(new URL(returnPath, page.url()).searchParams.get('projectReturn')).toBe('/projects')
})

test('Expanded objects inherit the exact period for statistics and reviews', async ({ page, request }) => {
  const { milestone } = await seed(request)
  const range = { start: 1_780_000_000_000, end: 1_781_000_000_000, asOf: 1_781_000_000_000 }
  const path = withProjectNavigation(`/projects/milestones/${milestone.id}`, { returnTo: '/projects?view=gantt', range, periodLabel: 'Planning window' })
  const loaded = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/milestones/${milestone.id}`)
  await page.goto(path)
  const params = new URL((await loaded).url()).searchParams
  expect(Number(params.get('start'))).toBe(range.start)
  expect(Number(params.get('end'))).toBe(range.end)
  await expect(page.getByTestId('project-object-effort')).toContainText('Planning window')
  await expect(page.getByRole('button', { name: 'Statistics period', exact: true })).toContainText('Planning window')
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/project-reviews')
  await page.locator('[data-project-review-create]').click()
  const response = await created
  expect(response.ok()).toBe(true)
  expect(response.request().postDataJSON()).toMatchObject({ targetType: 'milestone', targetId: milestone.id, periodStart: range.start, periodEnd: range.end })
  await expect(page.getByTestId('project-review-context')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('projectReturn')).toBe(path)
  await page.getByTestId('project-review-context').getByRole('button', { name: `Return to ${milestone.name}`, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
})

test('Changing period keeps the open progress draft while hiding statistics from the previous period', async ({ page, request }) => {
  const { milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  const effort = page.getByTestId('project-object-effort')
  await expect(effort).toHaveAttribute('aria-busy', 'false')
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  const editor = page.getByTestId('project-inline-editor')
  const text = unique('Keep while comparing periods')
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).fill(text)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/milestones/${milestone.id}*`, async route => {
    if (route.request().method() === 'GET' && new URL(route.request().url()).searchParams.get('start') === '0') await held
    await route.fallback()
  })
  await selectProjectOption(page, 'Statistics period', 'All time')
  await expect(effort).toHaveAttribute('aria-busy', 'true')
  await expect(effort.getByTestId('project-activity-panel')).toHaveCount(0)
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(text)
  release()
  await expect(effort).toHaveAttribute('aria-busy', 'false')
  await expect(effort.getByTestId('project-activity-panel')).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(text)
  await editor.getByRole('button', { name: 'Discard draft', exact: true }).click()
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(milestone.latestProgress)
})

test('A save in flight cannot erase a newer draft opened after switching objects', async ({ page, request }) => {
  const { area, milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  const editor = page.getByTestId('project-inline-editor')
  const submitted = unique('Submitted assessment')
  const later = unique('Later assessment')
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).fill(submitted)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/milestones/${milestone.id}*`, async route => {
    if (route.request().method() === 'PATCH') await held
    await route.fallback()
  })
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/milestones/${milestone.id}`)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: `${area.name} / Milestone`, exact: true }).click()
  await expect(page.getByRole('heading', { name: area.name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: new RegExp(milestone.name) }).click()
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).fill(later)
  release()
  expect((await saved).ok()).toBe(true)
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(later)
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: 'Keep & close', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(later)
  expect((await (await request.get(`/api/milestones/${milestone.id}`)).json()).latestProgress).toBe(submitted)
})

test('Explicit discard stays discarded in this session when browser storage rejects removal', async ({ page, request }) => {
  const { milestone } = await seed(request)
  await page.goto(`/projects/milestones/${milestone.id}`)
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  const editor = page.getByTestId('project-inline-editor')
  await editor.getByRole('textbox', { name: 'Latest progress', exact: true }).fill(unique('Discard this draft'))
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function(key: string) {
      if (key.startsWith('chronicle:project-editor:')) throw new DOMException('Storage unavailable', 'SecurityError')
      return remove.call(this, key)
    }
  })
  await editor.getByRole('button', { name: 'Discard draft', exact: true }).click()
  await page.getByRole('button', { name: 'Update progress', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue(milestone.latestProgress)
})

test('Area AI progress inherits the viewing period and retry keeps the older draft scope after a period change', async ({ page, request }) => {
  const { area } = await seed(request)
  const range = { start: 1_780_000_000_000, end: 1_781_000_000_000, asOf: 1_781_000_000_000 }
  const path = withProjectNavigation(`/projects/areas/${area.id}`, { returnTo: '/projects?view=gantt', range, periodLabel: 'Pilot window' })
  const originalSettings = await (await request.get('/api/settings/llm')).json()
  const generatedIds: string[] = []
  try {
    const configured = await request.put('/api/settings/llm', { data: { baseUrl: 'http://127.0.0.1:1/v1', model: 'project-object-unavailable-provider', apiKey: '', timeoutMs: 1000 } })
    expect(configured.ok()).toBe(true)
    await page.goto(path)
    await page.getByRole('button', { name: 'Draft progress with AI', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Area summary · AI drafts', exact: true })
    await expect(dialog.getByTestId('area-summary-generation-scope')).toContainText('Pilot window')
    const generated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/project-insights')
    await dialog.getByRole('button', { name: 'Draft progress & next steps', exact: true }).click()
    const generatedResponse = await generated
    expect(generatedResponse.ok()).toBe(true)
    expect(generatedResponse.request().postDataJSON()).toMatchObject({ targetType: 'area', targetId: area.id, periodStart: range.start, periodEnd: range.end })
    const first = await generatedResponse.json()
    generatedIds.push(first.id)
    expect(first.evidence.scope).toMatchObject({ periodStart: range.start, periodEnd: range.end })
    await expect.poll(async () => (await (await request.get(`/api/project-insights/${first.id}`)).json()).status).toBe('error')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await selectProjectOption(page, 'Statistics period', 'All time')
    await page.getByRole('button', { name: 'Draft progress with AI', exact: true }).click()
    await expect(dialog.getByTestId('area-summary-generation-scope')).toContainText('All time')
    const priorCard = dialog.locator(`[data-summary-draft="${first.id}"]`)
    await expect(priorCard.getByTestId('area-summary-draft-scope')).toContainText('2026')
    const priorScope = await priorCard.getByTestId('area-summary-draft-scope').innerText()
    const retried = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/project-insights/${first.id}/retry`)
    await priorCard.getByRole('button', { name: 'Retry generation', exact: true }).click()
    const retriedResponse = await retried
    expect(retriedResponse.ok()).toBe(true)
    expect(retriedResponse.request().postDataJSON()).not.toHaveProperty('periodStart')
    expect(retriedResponse.request().postDataJSON()).not.toHaveProperty('periodEnd')
    const second = await retriedResponse.json()
    generatedIds.push(second.id)
    expect(second.id).not.toBe(first.id)
    expect(second.evidence.scope).toEqual(first.evidence.scope)
    await expect(dialog.locator(`[data-summary-draft="${second.id}"]`).getByTestId('area-summary-draft-scope')).toHaveText(priorScope)
  } finally {
    for (const id of generatedIds) await request.post(`/api/project-insights/${id}/cancel`)
    await request.put('/api/settings/llm', { data: originalSettings })
  }
})

test('Escape exits Task selection first in both inspector and expanded workspace and returns focus to Select tasks', async ({ page, request }) => {
  const { milestone } = await seed(request)
  const task = await (await request.post('/api/tasks', { data: { title: unique('Select this work'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id } })).json()
  for (const path of [`/projects?selected=milestone:${milestone.id}`, `/projects/milestones/${milestone.id}`]) {
    await page.goto(path)
    const tasks = page.getByTestId('project-object-tasks')
    await tasks.getByRole('button', { name: 'Select tasks', exact: true }).click()
    const row = tasks.getByRole('checkbox', { name: `Select ${task.title}`, exact: true })
    await row.focus()
    await page.keyboard.press('Space')
    await expect(row).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(tasks.getByRole('checkbox')).toHaveCount(0)
    await expect(tasks.getByRole('button', { name: 'Select tasks', exact: true })).toBeFocused()
    await expect(page.getByRole('heading', { name: milestone.name, exact: true })).toBeVisible()
    if (path.includes('?')) await expect(page.getByTestId('project-context-panel')).toBeVisible()
    expect((await (await request.get(`/api/tasks/${task.id}`)).json()).status).toBe(task.status)
  }
})

test('Note reference tags return to the original Note after period changes, related objects and reload without writing its content', async ({ page, request }) => {
  const { area, milestone } = await seed(request)
  const note = await (await request.post('/api/notes', { data: { title: unique('Original reference note'), contentHtml: '<p>Keep this source note unchanged while inspecting its projects.</p>' } })).json()
  const linked = await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: note.projectRevision, references: [{ targetType: 'area', targetId: area.id, role: 'related' }, { targetType: 'milestone', targetId: milestone.id, role: 'outcome' }] } })
  expect(linked.ok()).toBe(true)
  const notePath = `/notes?id=${note.id}`
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/notes/${note.id}`) writes.push(request.postData() || '') })
  await page.goto(notePath)
  await page.getByTestId('project-relations').getByRole('button', { name: area.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: area.name, exact: true })).toBeVisible()
  await selectProjectOption(page, 'Statistics period', 'All time')
  await page.reload()
  await page.getByTestId('project-detail-page').getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(new URL(notePath, page.url()).href)
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('Keep this source note unchanged')
  await page.getByTestId('project-relations').getByRole('button', { name: `${area.name} › ${milestone.name}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: milestone.name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: `${area.name} / Milestone`, exact: true }).click()
  await expect(page.getByRole('heading', { name: area.name, exact: true })).toBeVisible()
  await page.reload()
  await page.getByTestId('project-detail-page').getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(new URL(notePath, page.url()).href)
  const after = await (await request.get(`/api/notes/${note.id}`)).json()
  expect(after.revision).toBe(note.revision)
  expect(after.contentHtml).toBe(note.contentHtml)
  expect(writes).toEqual([])
})

test('A Task milestone tag returns to its original Board task without updating the task or timing', async ({ page, request }) => {
  const { area, milestone } = await seed(request)
  const task = await (await request.post('/api/tasks', { data: { title: unique('Original task context'), body: '<p>Read this task without changing it.</p>', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id } })).json()
  const taskPath = '/'
  const writes: string[] = []
  page.on('request', request => { if (request.method() !== 'GET' && /^\/api\/(tasks|sessions|afk)(\/|$)/.test(new URL(request.url()).pathname)) writes.push(request.url()) })
  await page.goto(taskPath)
  await page.getByRole('heading', { name: task.title, level: 4, exact: true }).click()
  await page.getByTestId('project-relations').getByRole('button', { name: `${area.name} › ${milestone.name}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: milestone.name, exact: true })).toBeVisible()
  await page.reload()
  await page.getByTestId('project-detail-page').getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(new URL(taskPath, page.url()).href)
  await expect(page.getByRole('heading', { name: task.title, level: 1, exact: true })).toBeVisible()
  const after = await (await request.get(`/api/tasks/${task.id}`)).json()
  expect(after.status).toBe(task.status)
  expect(after.body).toBe(task.body)
  expect(writes).toEqual([])
})

test('Project detail rejects external and unrelated reference return destinations', async ({ page, request }) => {
  const { milestone } = await seed(request)
  for (const unsafe of ['https://example.com/notes', '//example.com/notes', '/settings']) {
    await page.goto(`/projects/milestones/${milestone.id}?projectSourceReturn=${encodeURIComponent(unsafe)}`)
    await expect(page.getByRole('heading', { name: milestone.name, exact: true })).toBeVisible()
    await page.getByTestId('project-detail-page').getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(new URL('/projects', page.url()).href)
  }
})
