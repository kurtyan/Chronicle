import { test, expect } from './helpers/projectFixtures'
import { selectProjectOption } from './helpers/projectSelect'
import type { APIRequestContext } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'
const Database = createRequire(path.resolve('server/package.json'))('better-sqlite3')

test.use({ locale: 'en-US', viewport: { width: 1728, height: 1117 } })
const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const midnight = (offset: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime() }
async function post(request: APIRequestContext, url: string, data: unknown) {
  const response = await request.post(url, { data }); expect(response.ok(), await response.text()).toBe(true); return response.json()
}
async function seed(request: APIRequestContext) {
  const area = await post(request, '/api/areas', { name: unique('Continuous workspace') })
  const milestones = []
  for (const name of ['Migration evidence', 'Recovery validation']) milestones.push(await post(request, '/api/milestones', {
    areaId: area.id, name: unique(name), startDate: midnight(-150), targetDate: midnight(200), latestProgress: `${name} has initial findings.`, nextStep: 'Validate one remaining assumption.',
  }))
  const note = await post(request, '/api/notes', { title: unique('Decision evidence'), contentHtml: '<p>Keep the decision grounded in the pilot results.</p>' })
  await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references: [{ targetType: 'milestone', targetId: milestones[0].id, role: 'outcome' }] } })
  return { area, milestones, note }
}

test('compare objects without dismissing the inspector, switch representations, and return from a note to the same month and schedule', async ({ page, request }) => {
  const { area, milestones, note } = await seed(request)
  await page.goto('/projects?lang=en')
  await selectProjectOption(page, 'Filter by area', area.name)
  await selectProjectOption(page, 'Effort period', 'This month')
  await page.getByRole('button', { name: 'Months', exact: true }).click()
  await page.getByRole('button', { name: 'Next time window', exact: true }).click()
  const timeline = page.getByTestId('project-gantt')
  const first = timeline.locator(`button[data-project-object="milestone:${milestones[0].id}"]`)
  const second = timeline.locator(`button[data-project-object="milestone:${milestones[1].id}"]`)
  await first.click()
  const panel = page.getByTestId('project-context-panel')
  await expect(panel.getByRole('heading', { name: milestones[0].name, exact: true })).toBeVisible()
  await second.click() // A persistent inspector must allow this with no preceding Close.
  await expect(panel.getByRole('heading', { name: milestones[1].name, exact: true })).toBeVisible()
  await expect(panel).toHaveCount(1)
  await first.click()
  const original = new URL(page.url())
  const originalAnchor = original.searchParams.get('anchor')
  await page.getByRole('button', { name: 'Effort & outcomes', exact: true }).click()
  await expect(panel.getByRole('heading', { name: milestones[0].name, exact: true })).toBeVisible()
  const list = page.getByTestId('project-effort-list')
  await list.locator(`button[data-project-object="milestone:${milestones[1].id}"]`).click()
  await expect(panel.getByRole('heading', { name: milestones[1].name, exact: true })).toBeVisible()
  await list.locator(`button[data-project-object="milestone:${milestones[0].id}"]`).click()
  const noteWrites: string[] = []
  page.on('request', req => { if (req.method() === 'PUT' && new URL(req.url()).pathname === `/api/notes/${note.id}`) noteWrites.push(req.postData() || '') })
  await panel.getByTestId('project-object-notes').getByRole('button', { name: new RegExp(note.title) }).click()
  await expect(page.getByTestId('project-review-context')).toBeVisible()
  await page.reload() // Context is a durable URL, not an in-memory breadcrumb.
  await page.getByTestId('project-review-context').getByRole('button', { name: 'Return to project', exact: true }).click()
  await expect(panel.getByRole('heading', { name: milestones[0].name, exact: true })).toBeVisible()
  const returned = new URL(page.url())
  expect(returned.searchParams.get('area')).toBe(area.id)
  expect(returned.searchParams.get('period')).toBe('month')
  expect(returned.searchParams.get('selected')).toBe(`milestone:${milestones[0].id}`)
  expect(returned.searchParams.get('anchor')).toBe(originalAnchor)
  expect(returned.searchParams.get('scale')).toBe('month')
  expect(returned.searchParams.get('view')).toBe('list')
  expect(noteWrites).toHaveLength(0)
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('expanded workspace and a Task detour preserve the chosen object and exact reporting range', async ({ page, request }) => {
  const { area, milestones } = await seed(request)
  const task = await post(request, '/api/tasks', { title: unique('Inspect rollout evidence'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestones[0].id })
  await page.goto(`/projects?area=${area.id}&period=custom&start=2026-08-01&end=2026-08-31&selected=milestone:${milestones[0].id}&lang=en`)
  const panel = page.getByTestId('project-context-panel')
  await expect(panel.getByRole('heading', { name: milestones[0].name, exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Expand workspace', exact: true }).click()
  const expandedUrl = page.url()
  await expect(page.getByTestId('project-detail-page')).toBeVisible()
  await page.getByTestId('project-object-tasks').getByRole('button', { name: new RegExp(task.title) }).click()
  await expect(page.getByTestId('project-return-context')).toBeVisible()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  const detourUrl = page.url()
  const taskWrites: string[] = []
  page.on('request', event => { if (event.method() !== 'GET' && /\/api\/(tasks|work-sessions|session)/.test(event.url())) taskWrites.push(`${event.method()} ${event.url()}`) })
  await page.reload()
  await expect(page).toHaveURL(url => {
    const before = new URL(detourUrl)
    before.searchParams.delete('lang')
    const after = new URL(url)
    after.searchParams.delete('lang')
    return after.href === before.href
  })
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
  await expect(page.getByRole('heading', { name: task.title, exact: true, level: 1 })).toBeVisible()
  expect(taskWrites).toEqual([])
  await page.getByTestId('project-return-context').getByRole('button', { name: 'Back to project workspace', exact: true }).click()
  await expect(page).toHaveURL(expandedUrl)
  const full = page.getByTestId('project-detail-page')
  await expect(full.getByRole('heading', { name: milestones[0].name, exact: true })).toBeVisible()
  await full.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(panel.getByRole('heading', { name: milestones[0].name, exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('start')).toBe('2026-08-01')
  expect(new URL(page.url()).searchParams.get('end')).toBe('2026-08-31')
  expect((await (await request.get(`/api/tasks/${task.id}`)).json()).status).toBe(task.status)
})

test('recorded effort stays discoverable for short, unscheduled and off-screen milestones', async ({ page, request }) => {
  const area = await post(request, '/api/areas', { name: unique('Effort discovery') })
  const milestones = []
  for (const [label, schedule] of [['No schedule', {}], ['Past target', { targetDate: midnight(-400) }], ['Short target', { startDate: midnight(0), targetDate: midnight(1) }]] as const) {
    const milestone = await post(request, '/api/milestones', { areaId: area.id, name: unique(label), ...schedule })
    const task = await post(request, '/api/tasks', { title: unique('Recorded work'), type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
    const directory = process.env.CHRONICLE_TEST_DATA_DIR
    if (!directory) throw new Error('An isolated test database is required')
    const db = new Database(path.join(directory, 'tasks.db'))
    try { db.prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(unique('effort-session'), task.id, Date.now() - 7_200_000, Date.now() - 3_600_000) } finally { db.close() }
    milestones.push(milestone)
  }
  await page.goto(`/projects?area=${area.id}&period=all&view=gantt&lang=en`)
  const shelf = page.getByTestId('gantt-unscheduled')
  await expect(shelf).toContainText('1h')
  await page.getByRole('button', { name: 'Effort & outcomes', exact: true }).click()
  const list = page.getByTestId('project-effort-list')
  await expect(list.getByTestId('milestone-card')).toHaveCount(3)
  for (const milestone of milestones) {
    const row = list.locator(`button[data-project-object="milestone:${milestone.id}"]`)
    await expect(row).toContainText(milestone.name)
    await expect(row).toContainText('1.0 h')
    await row.click()
    await expect(page.getByTestId('project-context-panel').getByTestId('project-object-effort')).toContainText('1.0 h')
  }
})
