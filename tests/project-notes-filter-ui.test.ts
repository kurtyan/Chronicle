import { test, expect } from './helpers/projectFixtures'

test.use({ locale: 'zh-CN' })

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

async function fixture(request: any) {
  const area = await (await request.post('/api/areas', { data: { name: unique('系统演进') } })).json()
  const growth = await (await request.post('/api/areas', { data: { name: unique('职业成长') } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('交付验收') } })).json()
  const both = await (await request.post('/api/notes', { data: { title: unique('共同复盘'), contentHtml: '<p>可追溯的判断证据</p>' } })).json()
  const direct = await (await request.post('/api/notes', { data: { title: unique('单一方向'), contentHtml: '<p>只有系统方向</p>' } })).json()
  const unrelated = await (await request.post('/api/notes', { data: { title: unique('无引用笔记') } })).json()
  for (const [note, references] of [[both, [{ targetType: 'milestone', targetId: milestone.id, role: 'review' }, { targetType: 'area', targetId: area.id, role: 'related' }, { targetType: 'area', targetId: growth.id, role: 'growth' }]], [direct, [{ targetType: 'area', targetId: area.id, role: 'related' }]]] as const) {
    const result = await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references } })
    expect(result.ok(), await result.text()).toBe(true)
  }
  return { area, growth, milestone, both, direct, unrelated }
}

test('Notes typed project tags combine with AND and full text, without duplicate inherited Notes or writes', async ({ page, request }) => {
  const data = await fixture(request)
  const writes: string[] = []
  page.on('request', req => { if (req.method() === 'PUT' && /\/api\/notes\//.test(req.url())) writes.push(req.url()) })
  await page.goto(`/notes?id=${data.both.id}`)
  const input = page.getByRole('combobox', { name: '搜索 Notes 或输入 # 标签', exact: true })
  await expect(page.getByRole('combobox', { name: '按方向或里程碑筛选', exact: true })).toHaveCount(0)
  await input.fill(`#${data.area.name}`)
  await page.getByTestId('notes-tag-options').getByText(`#${data.area.name}`, { exact: true }).click()
  await expect(page.locator(`[data-note-id="${data.both.id}"]`)).toHaveCount(1)
  await expect(page.locator(`[data-note-id="${data.direct.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-note-id="${data.unrelated.id}"]`)).toHaveCount(0)
  await input.fill(`#${data.growth.name}`)
  await expect(page.getByTestId('notes-tag-options').getByRole('option')).toHaveCount(1)
  await input.press('Enter')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(2)
  await expect(page.getByText('匹配全部 2 个标签', { exact: true })).toBeVisible()
  await expect(page.locator(`[data-note-id="${data.both.id}"]`)).toHaveCount(1)
  await expect(page.locator(`[data-note-id="${data.direct.id}"]`)).toHaveCount(0)
  await input.fill('判断证据')
  await expect(page.locator(`[data-note-id="${data.both.id}"]`)).toBeVisible()
  await input.fill('完全无匹配的普通文字')
  await expect(page.locator('[data-note-id]')).toHaveCount(0)
  await input.fill('')
  await input.press('Backspace')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(1)
  await expect(page.locator(`[data-note-id="${data.direct.id}"]`)).toBeVisible()
  await page.getByRole('button', { name: `移除筛选 ${data.area.name}`, exact: true }).click()
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(0)
  await expect(page.locator(`[data-note-id="${data.unrelated.id}"]`)).toBeVisible()
  expect(writes).toEqual([])
})

test('Notes tag chooser respects Chinese composition, keyboard choice, Escape and unmatched typed text', async ({ page, request }) => {
  const data = await fixture(request)
  await page.goto('/notes')
  const input = page.getByRole('combobox', { name: '搜索 Notes 或输入 # 标签', exact: true })
  await input.fill(`#${data.growth.name}`)
  await expect(page.getByTestId('notes-tag-options').getByRole('option')).toHaveCount(1)
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(0)
  await expect(input).toHaveValue(`#${data.growth.name}`)
  await input.dispatchEvent('compositionend')
  await input.press('ArrowUp')
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(1)
  await input.fill('判断证据 #不存在的标签')
  await expect(page.getByText('没有匹配的方向或里程碑', { exact: true })).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue('判断证据 #不存在的标签')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(1)
  await input.press('Escape')
  await expect(page.getByTestId('notes-tag-options')).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('判断证据 #不存在的标签')
  await input.fill('#')
  await expect(page.getByTestId('notes-tag-options')).toBeVisible()
})

test('Notes tag URL and cross-page return retain filters while edits keep authoritative revisions', async ({ page, request }) => {
  const data = await fixture(request)
  await page.goto(`/notes?id=${data.both.id}&projectFilter=area:${data.area.id}`)
  await expect(page.getByTestId('notes-filter-token')).toContainText(data.area.name)
  const input = page.getByRole('combobox', { name: '搜索 Notes 或输入 # 标签', exact: true })
  const body = page.locator('.ProseMirror[contenteditable="true"]')
  await expect(body).toContainText('可追溯的判断证据')
  const draft = unique('筛选中继续保存的中文感悟')
  await body.fill(draft)
  await input.fill(`#${data.growth.name}`)
  await expect(page.getByTestId('notes-tag-options').getByRole('option')).toHaveCount(1)
  await input.press('Enter')
  await expect(body).toContainText(draft)
  await expect.poll(async () => (await (await request.get(`/api/notes/${data.both.id}`)).json()).contentHtml).toContain(draft)
  await page.getByTestId('project-relations').getByRole('button', { name: data.area.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: data.area.name, exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(2)
  await expect(body).toContainText(draft)
  await page.reload()
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(2)
  await expect(body).toContainText(draft)
  await page.goto('/projects')
  await page.goto('/notes')
  await expect(page.getByTestId('notes-filter-token')).toHaveCount(2)
  const finalText = `${draft}，第二次编辑也正常保存。`
  await body.fill(finalText)
  await expect.poll(async () => (await (await request.get(`/api/notes/${data.both.id}`)).json()).contentHtml).toContain(finalText)
  await expect(page.getByText('Save conflict', { exact: true })).toHaveCount(0)
})

test('Notes search ignores an older response that arrives after a later query', async ({ page, request }) => {
  const suffix = unique('竞态')
  const first = await (await request.post('/api/notes', { data: { title: `先前结果${suffix}` } })).json()
  const second = await (await request.post('/api/notes', { data: { title: `后来结果${suffix}` } })).json()
  let release!: () => void
  let started = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/notes?**', async route => {
    if (new URL(route.request().url()).searchParams.get('query') === `先前结果${suffix}`) { started = true; await gate }
    await route.continue()
  })
  try {
    await page.goto(`/notes?id=${second.id}`)
    const input = page.getByRole('combobox', { name: '搜索 Notes 或输入 # 标签', exact: true })
    await input.fill(`先前结果${suffix}`)
    await expect.poll(() => started).toBe(true)
    await input.fill(`后来结果${suffix}`)
    await expect(page.locator(`[data-note-id="${second.id}"]`)).toBeVisible()
    await expect(page.locator(`[data-note-id="${first.id}"]`)).toHaveCount(0)
    const oldResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('query') === `先前结果${suffix}`)
    release()
    await oldResponse
    await expect(page.locator(`[data-note-id="${second.id}"]`)).toBeVisible()
    await expect(page.locator(`[data-note-id="${first.id}"]`)).toHaveCount(0)
  } finally { release() }
})

for (const resumeEditing of [false, true]) {
  test(`Escape before the Notes list loads ${resumeEditing ? 'does not steal focus after editing resumes' : 'focuses its Note when the response arrives'}`, async ({ page, request }) => {
    const note = await (await request.post('/api/notes', { data: { title: unique('延迟列表焦点'), contentHtml: '<p>编辑器先于列表准备好。</p>' } })).json()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/notes?**', async route => { await gate; await route.continue() })
    try {
      await page.goto(`/notes?id=${note.id}`)
      const editor = page.locator('.ProseMirror[contenteditable="true"]')
      await editor.click()
      await expect(editor).toBeFocused()
      await expect(page.locator(`[data-note-id="${note.id}"]`)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('region', { name: 'Notes list', exact: true })).toBeFocused()
      if (resumeEditing) {
        await editor.click()
        await expect(editor).toBeFocused()
      }
      release()
      const item = page.locator(`[data-note-id="${note.id}"]`)
      await expect(item).toBeVisible()
      await expect(resumeEditing ? editor : item).toBeFocused()
    } finally { release() }
  })
}
