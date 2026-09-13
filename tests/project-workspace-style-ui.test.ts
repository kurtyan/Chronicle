import { test, expect } from './helpers/projectFixtures'

test.use({ locale: 'en-US', viewport: { width: 1728, height: 1117 } })
const unique = (name: string) => `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
const date = (offset: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime() }

async function seed(request: import('@playwright/test').APIRequestContext) {
  const area = await (await request.post('/api/areas', { data: { name: unique('Platform engineering'), latestProgress: 'Validated the migration path with a small pilot.', nextStep: 'Measure the next release against the baseline.' } })).json()
  const milestones = []
  for (const [name, start, end] of [['Migration pilot', -7, 12], ['Reliability baseline', -4, 18]] as const) {
    milestones.push(await (await request.post('/api/milestones', { data: { name: unique(name), areaId: area.id, status: 'active', startDate: date(start), targetDate: date(end), latestProgress: 'Initial validation is complete.', nextStep: 'Review the evidence with the team.' } })).json())
  }
  const note = await (await request.post('/api/notes', { data: { title: unique('Pilot findings'), contentHtml: '<p>The pilot meets the agreed acceptance criteria.</p>' } })).json()
  await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references: [{ targetType: 'milestone', targetId: milestones[0].id, role: 'outcome' }] } })
  return { area, milestones, note }
}

test('English system uses a full desktop workspace while overlap lanes remain compact', async ({ page, request }) => {
  const { area, milestones, note } = await seed(request)
  await page.goto('/projects') // No lang override: verify the actual system-language default.
  await expect(page.getByRole('heading', { name: 'Areas & Milestones', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search milestones', exact: true }).fill(area.name)
  const chart = page.getByTestId('project-gantt')
  await expect(chart.getByTestId('gantt-area-lane')).toHaveCount(1)
  await expect(chart.getByTestId('gantt-milestone-row')).toHaveCount(2)
  for (const size of [{ width: 1728, height: 1117 }, { width: 2056, height: 1329 }]) {
    await page.setViewportSize(size)
    const box = await chart.boundingBox()
    expect(box!.width).toBeGreaterThan(size.width - 125)
    expect(box!.y + box!.height).toBeGreaterThan(size.height - 85)
    const track = await chart.getByTestId('gantt-track').boundingBox()
    expect(track!.height).toBeLessThanOrEqual(112)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(await page.getByTestId('projects-page').innerText()).not.toMatch(/[\u4e00-\u9fff]/)
  expect(await page.getByTestId('projects-page').innerText()).not.toContain('project.')
  await expect(chart.getByText('Weeks', { exact: true })).toBeVisible()
  const bar = chart.locator(`[data-milestone-id="${milestones[0].id}"]`).getByRole('button')
  await bar.hover()
  const peek = page.getByTestId('milestone-peek')
  await expect(peek).toBeVisible()
  expect(await peek.innerText()).not.toMatch(/[\u4e00-\u9fff]/)
  await bar.click()
  const panel = page.getByTestId('project-context-panel')
  await expect(panel.getByTestId('project-object-notes').getByRole('button', { name: new RegExp(note.title) })).toBeVisible()
  expect(await panel.innerText()).not.toMatch(/[\u4e00-\u9fff]/)
  await panel.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(bar).toBeFocused()
})

test('Project search and nested searchable form selectors work entirely from the keyboard', async ({ page, request }) => {
  const { area } = await seed(request)
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true }))
  await page.goto('/projects')
  await expect(page.getByTestId('project-gantt')).toBeVisible()
  await page.keyboard.press('Meta+f')
  await expect(page.getByRole('textbox', { name: 'Search milestones', exact: true })).toBeFocused()
  await page.keyboard.press('Meta+n')
  const editor = page.getByRole('dialog', { name: 'New milestone', exact: true })
  await expect(editor).toBeVisible()
  expect(await editor.innerText()).not.toMatch(/[\u4e00-\u9fff]/)
  await expect(editor.locator('select')).toHaveCount(0)
  await expect(editor.getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveCount(0)
  await expect(editor.locator('input[type="date"]')).toHaveCount(0)
  const areaTrigger = editor.getByRole('button', { name: 'Area', exact: true })
  await areaTrigger.focus()
  await page.keyboard.press('Enter')
  const popup = page.locator('[data-project-select-popup]')
  await expect(popup.getByRole('combobox')).toBeFocused()
  await popup.getByRole('combobox').fill(area.name)
  await expect(popup.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(popup).toHaveCount(0)
  await expect(areaTrigger).toBeFocused()
  await expect(areaTrigger).toContainText(area.name)
  await page.keyboard.press('Enter')
  await popup.getByRole('combobox').fill('no such area in the catalog')
  await expect(popup.getByRole('option')).toHaveCount(0)
  expect(await popup.innerText()).not.toMatch(/[\u4e00-\u9fff]/)
  await page.keyboard.press('Escape')
  await expect(editor).toBeVisible()
  await expect(areaTrigger).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
})
