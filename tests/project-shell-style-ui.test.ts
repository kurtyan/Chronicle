import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })
const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

test('sidebar shortcuts follow the visible order, including Projects fifth and Settings sixth', async ({ page }) => {
  await page.goto('/?lang=en')
  const navigation = page.locator('aside nav')
  const items = [
    ['Board', '/'], ['Today', '/today'], ['Notes', '/notes'], ['Report', '/report'],
    ['Areas & Milestones', '/projects'], ['Settings', '/settings'],
  ]
  for (const index of [4, 5, 0, 1, 2, 3]) {
    const [label, path] = items[index]
    const item = navigation.getByRole('button', { name: label, exact: true })
    await expect(item).toHaveAttribute('aria-keyshortcuts', new RegExp(`(?:Meta|Control)\\+${index + 1}$`))
    await page.keyboard.press(`ControlOrMeta+${index + 1}`)
    await expect.poll(() => new URL(page.url()).pathname).toBe(path)
    await expect(item).toHaveAttribute('aria-current', 'page')
  }
})

test('English Notes uses typed tags with keyboard selection and preserves inherited references', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('Systems') } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('Acceptance') } })).json()
  const note = await (await request.post('/api/notes', { data: { title: unique('Learning'), contentHtml: '<p>Saved learning from delivery.</p>' } })).json()
  const references = await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references: [{ targetType: 'milestone', targetId: milestone.id, role: 'growth' }] } })
  expect(references.ok()).toBe(true)
  const writes: string[] = []
  page.on('request', req => { if (req.method() === 'PUT' && req.url().includes(`/api/notes/${note.id}`)) writes.push(req.url()) })
  await page.goto(`/notes?id=${note.id}&lang=en`)
  const search = page.getByRole('combobox', { name: 'Search notes or enter a # tag', exact: true })
  await search.fill(`#${area.name}`)
  // Area text also matches its child milestone's parent name; both are valid suggestions.
  await expect(page.getByTestId('notes-tag-options').getByRole('option')).toHaveCount(2)
  await expect(page.locator('[data-notes-tag-search]')).not.toContainText(/[\u3400-\u9fff]/)
  await search.press('Enter')
  await expect(page.getByTestId('notes-filter-token')).toContainText(area.name)
  await expect(page.locator(`[data-note-id="${note.id}"]`)).toBeVisible()
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('Saved learning from delivery.')
  await search.press('Backspace')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(0)
  expect(writes).toEqual([])
})

test('English project search names areas and milestones and opens the linked result', async ({ page, request }) => {
  const query = unique('ShellSearch')
  const area = await (await request.post('/api/areas', { data: { name: `${query} Area` } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: `${query} Milestone` } })).json()
  await page.goto('/?lang=en')
  await page.keyboard.press('ControlOrMeta+Shift+f')
  const search = page.getByRole('dialog')
  await search.getByPlaceholder('Search...').fill(query)
  await expect(search.getByText('Areas (1)', { exact: true })).toBeVisible()
  await expect(search.getByText('Milestones (1)', { exact: true })).toBeVisible()
  await expect(search).toContainText('Tasks, logs, notes, areas, and milestones')
  await search.getByRole('button').filter({ hasText: milestone.name }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/milestones/${milestone.id}`)
})

test('English Report grouping has a compact button control and localizes isolated project failures', async ({ page }) => {
  await page.goto('/report?lang=en')
  const distribution = page.getByRole('region', { name: 'Area and milestone time' })
  const group = distribution.getByRole('group', { name: 'Group time by' })
  await expect(group.getByRole('button', { name: 'Milestones', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await group.getByRole('button', { name: 'Areas', exact: true }).click()
  await expect(group.getByRole('button', { name: 'Areas', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(distribution.locator('select')).toHaveCount(0)
  await page.route('**/api/projects/statistics?*', async route => {
    const response = await route.fetch()
    const statistics = await response.json()
    await route.fulfill({ json: { ...statistics, byMilestone: null } })
  })
  await page.reload()
  const error = page.getByTestId('project-feature-error')
  await expect(error).toContainText('Area and milestone time is temporarily unavailable.')
  await expect(error.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+1')
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
})

test('an immediate Cmd+5 navigation retains an unsaved Focus edit on return', async ({ page, request }) => {
  const date = '2099-07-19'
  const text = unique('Focus-before-project-navigation')
  await page.goto(`/today?date=${date}&lang=en`)
  const focus = page.locator('.day-script-editor.ProseMirror')
  await expect(focus).toBeVisible()
  await focus.fill(text)
  await focus.press('ControlOrMeta+5')
  await expect(page.getByTestId('projects-page')).toBeVisible()
  await page.goBack()
  await expect(focus).toContainText(text)
  await expect.poll(async () => JSON.stringify((await (await request.get(`/api/day-scripts/${date}`)).json()).document)).toContain(text)
})

for (const status of [500, 409]) test(`Focus stays editable when navigation saving returns ${status}`, async ({ page, request }) => {
  const date = status === 500 ? '2099-07-20' : '2099-07-21'
  const text = unique(`Focus-preserved-${status}`)
  let writes = 0
  await page.route(`**/api/day-scripts/${date}`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    writes += 1
    await route.fulfill({ status, json: { error: 'Injected save failure' } })
  })
  await page.goto(`/today?date=${date}&lang=en`)
  const focus = page.locator('.day-script-editor.ProseMirror')
  await focus.fill(text)
  if (status === 500) await focus.press('ControlOrMeta+5')
  else await page.locator('aside nav').getByRole('button', { name: 'Areas & Milestones', exact: true }).click()
  await expect.poll(() => writes).toBe(1)
  await expect(page.getByText(status === 409 ? 'Save conflict. Reload this date before saving again.' : 'Request failed with status code 500', { exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/today')
  await expect(focus).toContainText(text)
  expect(JSON.stringify((await (await request.get(`/api/day-scripts/${date}`)).json()).document)).not.toContain(text)
  // A later successful request can leave normally without losing the retained draft.
  await page.unroute(`**/api/day-scripts/${date}`)
  await focus.press('ControlOrMeta+5')
  await expect(page.getByTestId('projects-page')).toBeVisible()
  expect(JSON.stringify((await (await request.get(`/api/day-scripts/${date}`)).json()).document)).toContain(text)
})

test('navigation waits for an in-flight save, saves later edits and uses the last requested destination', async ({ page, request }) => {
  const date = '2099-07-22'
  const first = unique('Focus-first-snapshot')
  const latest = `${first} with the later edit`
  const writes: Array<{ expectedRevision: number; document: object }> = []
  const submissions: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/day-scripts/${date}`, async route => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON())
      if (writes.length === 1) await gate
    }
    await route.continue()
  })
  page.on('request', req => { if (req.url().includes('/submit-progress')) submissions.push(req.url()) })
  try {
    await page.goto(`/today?date=${date}&lang=en`)
    const focus = page.locator('.day-script-editor.ProseMirror')
    await focus.fill(first)
    await focus.press('ControlOrMeta+s')
    await expect.poll(() => writes.length).toBe(1)
    await focus.fill(latest)
    await focus.press('ControlOrMeta+5')
    await focus.press('ControlOrMeta+6')
    expect(new URL(page.url()).pathname).toBe('/today')
    expect(writes).toHaveLength(1)
    release()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings')
    expect(writes).toHaveLength(2)
    expect(writes[1].expectedRevision).toBe(writes[0].expectedRevision + 1)
    expect(JSON.stringify(writes[1].document)).toContain(latest)
    expect(JSON.stringify((await (await request.get(`/api/day-scripts/${date}`)).json()).document)).toContain(latest)
    expect(submissions).toEqual([])
  } finally { release() }
})

test('navigation from an untouched Focus does not write the day script', async ({ page, request }) => {
  const date = '2099-07-23'
  const writes: string[] = []
  page.on('request', req => { if (req.method() === 'PUT' && new URL(req.url()).pathname === `/api/day-scripts/${date}`) writes.push(req.url()) })
  await page.goto(`/today?date=${date}&lang=en`)
  await expect(page.locator('.day-script-editor.ProseMirror')).toBeVisible()
  const before = await (await request.get(`/api/day-scripts/${date}`)).json()
  await page.keyboard.press('ControlOrMeta+5')
  await expect(page.getByTestId('projects-page')).toBeVisible()
  const after = await (await request.get(`/api/day-scripts/${date}`)).json()
  expect(writes).toEqual([])
  expect(after.revision).toBe(before.revision)
  expect(after.document).toEqual(before.document)
})
