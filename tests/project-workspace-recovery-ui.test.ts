import { test, expect } from './helpers/projectFixtures'
import { selectProjectOption } from './helpers/projectSelect'

test.use({ locale: 'en-US', viewport: { width: 1728, height: 1117 } })

test('A filtered list restores its loaded scroll position and closing details focuses the current view of the object', async ({ page, request }) => {
  const prefix = `Recovery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const post = async (path: string, data: Record<string, unknown>) => {
    const response = await request.post(path, { data })
    expect(response.ok()).toBe(true)
    return response.json()
  }
  const longArea = await post('/api/areas', { name: `${prefix} long list` })
  const narrowArea = await post('/api/areas', { name: `${prefix} narrow list` })
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const milestones = []
  for (let index = 0; index < 35; index++) {
    milestones.push(await post('/api/milestones', {
      areaId: longArea.id,
      name: `${prefix} milestone ${String(index).padStart(2, '0')}`,
      ...(index === 0 ? { startDate: today.getTime() - 86_400_000, targetDate: today.getTime() + 7 * 86_400_000 } : {}),
    }))
  }
  await post('/api/milestones', { areaId: narrowArea.id, name: `${prefix} narrow milestone` })

  await page.goto(`/projects?view=list&period=all&q=${prefix}&lang=en`)
  const list = page.getByTestId('project-effort-list')
  await expect(list.getByTestId('milestone-card')).toHaveCount(36)
  await list.evaluate(element => { element.scrollTop = 900 })
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(800)
  const originalTop = await list.evaluate(element => element.scrollTop)

  await selectProjectOption(page, 'Filter by area', narrowArea.name)
  await expect(list.getByTestId('milestone-card')).toHaveCount(1)
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)

  // Keep the short, previously loaded rows visible while the long scope loads.
  // A premature restore would clamp the long scope's saved position to zero.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let intercepted!: () => void
  const requested = new Promise<void>(resolve => { intercepted = resolve })
  await page.route('**/api/projects/overview*', async route => {
    const params = new URL(route.request().url()).searchParams
    if (!params.get('areaId') && params.get('query') === prefix) {
      intercepted()
      await held
    }
    await route.fallback()
  })
  try {
    await selectProjectOption(page, 'Filter by area', 'All areas')
    await requested
    await expect(list.getByTestId('milestone-card')).toHaveCount(1)
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
  } finally {
    release()
  }
  await expect(list.getByTestId('milestone-card')).toHaveCount(36)
  await expect.poll(async () => Math.abs(await list.evaluate(element => element.scrollTop) - originalTop)).toBeLessThanOrEqual(1)

  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  const selected = milestones[0]
  await page.getByTestId('project-gantt').locator(`button[data-project-object="milestone:${selected.id}"]`).click()
  const panel = page.getByTestId('project-context-panel')
  await expect(panel.getByRole('heading', { name: selected.name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Effort & outcomes', exact: true }).click()
  const currentRow = list.locator(`button[data-project-object="milestone:${selected.id}"]`)
  await expect(currentRow).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('heading', { name: selected.name, exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(currentRow).toBeFocused()
  expect(new URL(page.url()).searchParams.has('selected')).toBe(false)
})
