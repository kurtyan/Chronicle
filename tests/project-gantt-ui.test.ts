import { test, expect } from './helpers/projectFixtures'

const unique = (value: string) => `${value}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const relative = (offset: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime() }
const dateValue = (value: number) => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

test('Gantt uses explicit schedules, distinguishes undated, target-only and open-ended milestones, and opens inherited Notes', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('时间规划方向'), latestProgress: '已厘清本期交付边界', nextStep: '验证一条完整使用路径' } })).json()
  const milestones: any[] = []
  for (const fields of [
    { name: unique('双端排期'), startDate: relative(-3), targetDate: relative(7) },
    { name: unique('待排期目标') },
    { name: unique('持续观察'), kind: 'ongoing', startDate: relative(-5) },
    { name: unique('目标节点'), targetDate: relative(12) },
  ]) milestones.push(await (await request.post('/api/milestones', { data: { areaId: area.id, ...fields } })).json())
  const note = await (await request.post('/api/notes', { data: { title: unique('排期依据'), contentHtml: '<p>排期来自手工计划，不等于投入。</p>' } })).json()
  await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references: [{ targetType: 'area', targetId: area.id }, { targetType: 'milestone', targetId: milestones[0].id, role: 'outcome' }] } })
  await page.goto('/projects')
  const chart = page.getByTestId('project-gantt')
  await expect(chart).toBeVisible()
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  await expect(chart.getByTestId('gantt-axis')).toHaveCount(1)
  await expect(chart.getByTestId('gantt-area-lane')).toHaveCount(1)
  await expect(chart.getByTestId('gantt-track')).toHaveCount(1)
  await expect(chart.getByText('已厘清本期交付边界', { exact: true })).toBeVisible()
  await expect(chart.getByText('验证一条完整使用路径', { exact: true })).toHaveCount(0)
  await expect(chart.getByRole('button', { name: '编辑摘要', exact: true })).toHaveCount(0)
  await expect(chart.getByTestId('gantt-milestone-row')).toHaveCount(3)
  await chart.getByRole('button', { name: /^待排期\s+1$/ }).click()
  await expect(chart.getByTestId('gantt-milestone-row')).toHaveCount(4)
  const undated = chart.getByTestId('gantt-milestone-row').filter({ hasText: milestones[1].name })
  await expect(undated.getByRole('button', { name: '待排期 · 设置日期', exact: true })).toBeVisible()
  const ongoing = chart.getByTestId('gantt-milestone-row').filter({ hasText: milestones[2].name })
  await expect(ongoing.getByRole('button', { name: /持续跟踪，查看关联笔记/ })).toBeVisible()
  await expect(ongoing).not.toContainText('%')
  const targetOnly = chart.getByTestId('gantt-milestone-row').filter({ hasText: milestones[3].name })
  await expect(targetOnly.getByRole('button', { name: /开始待定，查看关联笔记/ })).toBeVisible()

  await chart.getByRole('button', { name: area.name, exact: true }).click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByText('验证一条完整使用路径', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '编辑摘要', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '编辑摘要', exact: true }).click()
  const summaryEditor = page.getByRole('dialog', { name: new RegExp(`编辑方向摘要.*${area.name}`) })
  await summaryEditor.getByRole('textbox', { name: '方向下一步计划', exact: true }).fill('验证一条完整使用路径，并记录结果')
  await summaryEditor.getByRole('button', { name: '保存摘要', exact: true }).click()
  await expect(summaryEditor).toHaveCount(0)
  await expect(panel).toContainText('验证一条完整使用路径，并记录结果')
  await expect(panel).toContainText('共 1 篇')
  await expect(panel.getByRole('button', { name: note.title, exact: false })).toHaveCount(1)
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await chart.getByRole('button', { name: new RegExp(`${milestones[0].name}，.*查看关联笔记`) }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: note.title, exact: false })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '在 Notes 中查看', exact: true }).click()
  await expect(page.getByTestId('notes-filter-token')).toContainText(milestones[0].name)
  await expect(page.locator(`[data-note-id="${note.id}"]`)).toBeVisible()
})

test('Gantt schedule edit persists across reload, rejects reversed dates, and leaves status and effort unchanged', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('排期编辑') } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('未排期') } })).json()
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  await page.getByTestId('project-gantt').getByRole('button', { name: /^待排期\s+1$/ }).click()
  const row = page.getByTestId('gantt-milestone-row').filter({ hasText: milestone.name })
  await row.getByRole('button', { name: '待排期 · 设置日期', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('计划开始日期（可选）', { exact: true }).fill(dateValue(relative(5)))
  await dialog.getByLabel('目标日期（可选）', { exact: true }).fill(dateValue(relative(2)))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('开始日期不能晚于')
  await dialog.getByLabel('目标日期（可选）', { exact: true }).fill(dateValue(relative(12)))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row.getByRole('button', { name: /查看关联笔记/ })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('gantt-milestone-row').filter({ hasText: milestone.name }).getByRole('button', { name: /查看关联笔记/ })).toBeVisible()
  const saved = await (await request.get(`/api/milestones/${milestone.id}`)).json()
  expect(saved.startDate).toBe(relative(5))
  expect(saved.targetDate).toBe(relative(12))
  expect(saved.status).toBe(milestone.status)
  expect(saved.totalMs).toBe(0)
})

test('Gantt can navigate outside the current window and collapse a direction lane without losing its summary', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('远期方向'), latestProgress: '方向保持可见' } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('远期目标'), startDate: relative(240), targetDate: relative(270) } })).json()
  const targetOnly = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('仅有远期目标日期'), targetDate: relative(260) } })).json()
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  const row = page.getByTestId('gantt-milestone-row').filter({ hasText: milestone.name })
  const pointRow = page.getByTestId('gantt-milestone-row').filter({ hasText: targetOnly.name })
  await expect(row).toHaveCount(0)
  await expect(pointRow).toHaveCount(0)
  await page.getByTestId('project-gantt').getByRole('button', { name: /^视窗外\s+2$/ }).click()
  await expect(pointRow.getByRole('button', { name: /排期在当前视窗外/ })).toBeVisible()
  await expect(pointRow.getByRole('button', { name: /开始待定，查看关联笔记/ })).toHaveCount(0)
  await row.getByRole('button', { name: /排期在当前视窗外/ }).click()
  await expect(row.getByRole('button', { name: /查看关联笔记/ })).toBeVisible()
  await page.getByRole('button', { name: '按月', exact: true }).click()
  await expect(page.getByTestId('gantt-axis')).toContainText('月')
  await page.getByRole('button', { name: `折叠方向 ${area.name}`, exact: true }).click()
  await expect(page.getByTestId('gantt-milestone-row')).toHaveCount(0)
  await expect(page.getByTestId('gantt-area-lane')).toHaveCount(1)
  await expect(page.getByText('方向保持可见', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: `展开方向 ${area.name}`, exact: true }).click()
  await expect(row).toBeVisible()
})

test('Gantt shows all direction lanes against one axis, reuses free tracks and stacks overlapping milestones', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  const prefix = unique('统一泳道')
  const areas: any[] = []
  for (const name of ['系统演进', '职业成长', '暂未排期']) {
    areas.push(await (await request.post('/api/areas', { data: { name: `${prefix}-${name}`, latestProgress: `${name}的最新进展`, nextStep: `${name}的下一步` } })).json())
  }
  const milestones: any[] = []
  for (const [name, startOffset, endOffset] of [
    ['第一阶段', -10, -5], ['并行验证', -8, 12], ['第二阶段', 15, 18], ['第三阶段', 36, 40],
  ] as const) {
    milestones.push(await (await request.post('/api/milestones', { data: { areaId: areas[0].id, name: unique(name), startDate: relative(startOffset), targetDate: relative(endOffset) } })).json())
  }
  const otherMilestone = await (await request.post('/api/milestones', { data: { areaId: areas[1].id, name: unique('独立方向排期'), startDate: relative(-10), targetDate: relative(-5) } })).json()
  await page.goto('/projects')
  await page.getByRole('textbox', { name: '搜索里程碑', exact: true }).fill(prefix)
  const chart = page.getByTestId('project-gantt')
  const lanes = chart.getByTestId('gantt-area-lane')
  await expect(lanes).toHaveCount(3)
  await expect(chart.getByTestId('gantt-axis')).toHaveCount(1)
  await expect(chart.getByTestId('gantt-track')).toHaveCount(3)
  await expect(chart.getByTestId('gantt-milestone-row')).toHaveCount(5)
  const firstLane = lanes.filter({ has: page.getByRole('button', { name: areas[0].name, exact: true }) })
  const secondLane = lanes.filter({ has: page.getByRole('button', { name: areas[1].name, exact: true }) })
  const emptyLane = lanes.filter({ has: page.getByRole('button', { name: areas[2].name, exact: true }) })
  await expect(firstLane).toHaveAttribute('data-area-id', areas[0].id)
  await expect(firstLane.getByTestId('gantt-track')).toHaveCount(1)
  await expect(firstLane.getByTestId('gantt-milestone-row')).toHaveCount(4)
  await expect(secondLane.getByTestId('gantt-milestone-row')).toHaveCount(1)
  await expect(emptyLane.getByTestId('gantt-milestone-row')).toHaveCount(0)
  await expect(emptyLane.getByText('暂未排期的最新进展', { exact: true })).toBeVisible()
  await expect(emptyLane.getByText('暂未排期的下一步', { exact: true })).toHaveCount(0)

  const rows = milestones.map(m => firstLane.getByTestId('gantt-milestone-row').filter({ hasText: m.name }))
  for (const row of rows) await expect(row).toHaveAttribute('data-track-index', /^\d+$/)
  const trackIndices = await Promise.all(rows.map(row => row.getAttribute('data-track-index')))
  expect(trackIndices[1]).not.toBe(trackIndices[0])
  expect(trackIndices[2]).toBe(trackIndices[0])
  expect(trackIndices[3]).toBe(trackIndices[0])
  await expect(secondLane.getByTestId('gantt-milestone-row').filter({ hasText: otherMilestone.name })).toHaveAttribute('data-track-index', '0')

  // Check the rendered WebKit geometry as well as the allocation metadata.
  const boxes = await Promise.all(rows.map(row => row.boundingBox()))
  for (const box of boxes) expect(box).not.toBeNull()
  expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(1)
  expect(Math.abs(boxes[0]!.y - boxes[3]!.y)).toBeLessThan(1)
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeGreaterThanOrEqual(32)
  const axisBox = await chart.getByTestId('gantt-axis').boundingBox()
  expect(axisBox).not.toBeNull()
  for (const lane of [firstLane, secondLane, emptyLane]) {
    const trackBox = await lane.getByTestId('gantt-track').boundingBox()
    expect(trackBox).not.toBeNull()
    expect(Math.abs(trackBox!.x - axisBox!.x)).toBeLessThan(1)
    expect(Math.abs(trackBox!.width - axisBox!.width)).toBeLessThan(1)
  }
  // Overview density is a product requirement, not only an allocation detail.
  // Measure both cells because either one can expand the shared grid row.
  for (const [lane, maxHeight] of [[firstLane, 112], [secondLane, 88], [emptyLane, 88]] as const) {
    for (const cell of [lane.getByTestId('gantt-track'), lane.getByTestId('gantt-area-label')]) {
      const box = await cell.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeLessThanOrEqual(maxHeight)
    }
  }
})

test('Gantt keeps inclusive date boundaries, target-only points and ongoing milestones from occupying the same track', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('泳道日期边界') } })).json()
  const milestones: any[] = []
  for (const fields of [
    { name: unique('包含结束日'), startDate: relative(-3), targetDate: relative(4) },
    { name: unique('同日开始'), startDate: relative(4), targetDate: relative(8) },
    { name: unique('同日目标点'), targetDate: relative(4) },
    { name: unique('持续型无结束'), kind: 'ongoing', startDate: relative(10) },
    { name: unique('持续中并行排期'), startDate: relative(32), targetDate: relative(36) },
  ]) milestones.push(await (await request.post('/api/milestones', { data: { areaId: area.id, ...fields } })).json())
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  const lane = page.getByTestId('gantt-area-lane')
  await expect(lane).toHaveCount(1)
  const rows = milestones.map(m => lane.getByTestId('gantt-milestone-row').filter({ hasText: m.name }))
  for (const row of rows) await expect(row).toHaveAttribute('data-track-index', /^\d+$/)
  const indices = await Promise.all(rows.map(row => row.getAttribute('data-track-index')))
  expect(indices[0]).not.toBe(indices[1])
  expect(indices[0]).not.toBe(indices[2])
  expect(indices[1]).not.toBe(indices[2])
  expect(indices[3]).not.toBe(indices[4])
  await expect(rows[2].getByRole('button', { name: /开始待定，查看关联笔记/ })).toBeVisible()
  await expect(rows[3].getByRole('button', { name: /持续跟踪，查看关联笔记/ })).toBeVisible()
})

test('Gantt recomputes track allocation when schedule editing creates an overlap and retains it after reload', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('修改泳道排期') } })).json()
  const first = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('早期工作'), startDate: relative(-10), targetDate: relative(-5) } })).json()
  const later = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('后来工作'), startDate: relative(15), targetDate: relative(18) } })).json()
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  const firstRow = page.getByTestId('gantt-milestone-row').filter({ hasText: first.name })
  const laterRow = page.getByTestId('gantt-milestone-row').filter({ hasText: later.name })
  await expect(firstRow).toHaveAttribute('data-track-index', '0')
  await expect(laterRow).toHaveAttribute('data-track-index', '0')
  await expect(laterRow.getByRole('button', { name: /调整.*计划日期/ })).toHaveCount(0)
  await laterRow.getByRole('button', { name: /查看关联笔记/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '调整排期', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('计划开始日期（可选）', { exact: true }).fill(dateValue(relative(-8)))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(laterRow).toHaveAttribute('data-track-index', '1')
  await page.reload()
  await expect(firstRow).toHaveAttribute('data-track-index', '0')
  await expect(laterRow).toHaveAttribute('data-track-index', '1')
  const saved = await (await request.get(`/api/milestones/${later.id}`)).json()
  expect(saved.startDate).toBe(relative(-8))
  expect(saved.targetDate).toBe(relative(18))
  expect(saved.status).toBe(later.status)
})

test('Gantt keeps long titles in exact short date bars without adding tracks or increasing lane height', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const area = await (await request.post('/api/areas', { data: {
    name: unique('紧凑排期'),
    latestProgress: '一行进展保持概览可读。'.repeat(16),
    nextStep: '完整下一步应当在方向面板里阅读。'.repeat(16),
  } })).json()
  const milestones: any[] = []
  for (const [name, offset] of [
    [unique('验证一个名称非常长但只有一天的里程碑，完整标题应当在预览中阅读。'.repeat(4)), 1],
    [unique('两天后另一项具有同样很长的名称但不与前项重叠的里程碑。'.repeat(4)), 3],
  ] as const) milestones.push(await (await request.post('/api/milestones', { data: { areaId: area.id, name, startDate: relative(offset), targetDate: relative(offset) } })).json())
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  const chart = page.getByTestId('project-gantt')
  const lane = chart.getByTestId('gantt-area-lane')
  await expect(lane).toHaveCount(1)
  const axisBox = await chart.getByTestId('gantt-axis').boundingBox()
  expect(axisBox).not.toBeNull()
  const rows = milestones.map(m => lane.locator(`[data-testid="gantt-milestone-row"][data-milestone-id="${m.id}"]`))
  for (let i = 0; i < rows.length; i++) {
    await expect(rows[i]).toHaveAttribute('data-track-index', '0')
    const mark = await rows[i].getByTestId('gantt-time-mark').boundingBox()
    expect(mark).not.toBeNull()
    // One calendar day on the ten-week axis must remain one day wide, even
    // when its title needs much more room. A wide hit target must not fake it.
    expect(Math.abs(mark!.width - axisBox!.width / 70)).toBeLessThan(2)
    const bar = rows[i].getByRole('button', { name: /查看关联笔记/ })
    await bar.hover()
    await expect(page.getByTestId('milestone-peek')).toContainText(milestones[i].name)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('milestone-peek')).toHaveCount(0)
  }
  const boxes = await Promise.all(rows.map(row => row.boundingBox()))
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(1)
  for (const cell of [lane.getByTestId('gantt-track'), lane.getByTestId('gantt-area-label')]) {
    const box = await cell.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeLessThanOrEqual(88)
  }
  await expect(chart.getByText(area.nextStep, { exact: true })).toHaveCount(0)
  await lane.getByRole('button', { name: area.name, exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(area.nextStep)
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await chart.getByRole('button', { name: '按月', exact: true }).click()
  await expect(chart.getByTestId('gantt-axis')).toContainText('月')
  for (let i = 0; i < rows.length; i++) {
    const mark = await rows[i].getByTestId('gantt-time-mark').boundingBox()
    const hitTarget = await rows[i].getByRole('button', { name: /查看关联笔记/ }).boundingBox()
    expect(mark).not.toBeNull()
    expect(hitTarget).not.toBeNull()
    expect(mark!.width).toBeGreaterThan(0)
    expect(mark!.width).toBeLessThan(10)
    expect(hitTarget!.width).toBeGreaterThanOrEqual(mark!.width)
    // Click the visual mark's actual screen position, so a neighbouring
    // milestone's enlarged transparent target cannot silently capture it.
    await page.mouse.click(mark!.x + mark!.width / 2, mark!.y + mark!.height / 2)
    const panel = page.getByRole('dialog')
    await expect(panel.getByRole('heading', { name: milestones[i].name, exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
  }
})

test('Gantt reveals milestone details on hover or focus, dismisses with Escape, and opens Notes without changing them', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const area = await (await request.post('/api/areas', { data: { name: unique('渐进展开方向') } })).json()
  const milestone = await (await request.post('/api/milestones', { data: {
    areaId: area.id, name: unique('通过预览阅读的里程碑'), startDate: relative(-2), targetDate: relative(9),
    latestProgress: '核心路径已验证，边界案例仍在检查。', nextStep: '根据检查结果安排下一步。',
  } })).json()
  const note = await (await request.post('/api/notes', { data: { title: unique('里程碑关联的原始笔记'), contentHtml: '<p>这段判断应保持原样，不因浏览概览或笔记而重写。</p>' } })).json()
  const linked = await request.put('/api/project-references', { data: { sourceType: 'note', sourceId: note.id, expectedRevision: 1, references: [{ targetType: 'milestone', targetId: milestone.id, role: 'outcome' }] } })
  expect(linked.ok(), await linked.text()).toBe(true)
  const before = await (await request.get(`/api/notes/${note.id}`)).json()
  const writes: string[] = []
  page.on('request', req => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) && new URL(req.url()).pathname.startsWith('/api/')) writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
  })
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  const row = page.getByTestId('gantt-milestone-row').filter({ hasText: milestone.name })
  const bar = row.getByRole('button', { name: /查看关联笔记/ })
  const peek = page.getByTestId('milestone-peek')
  await expect(row).not.toContainText(milestone.latestProgress)
  await expect(peek).toHaveCount(0)
  await bar.hover()
  await expect(peek).toHaveAttribute('role', 'tooltip')
  await expect(peek).toContainText(milestone.name)
  await expect(peek).toContainText(new Date(milestone.startDate).toLocaleDateString('zh-CN'))
  await expect(peek).toContainText(new Date(milestone.targetDate).toLocaleDateString('zh-CN'))
  await expect(peek).toContainText('0 分钟')
  await expect(peek).toContainText(milestone.latestProgress)
  await expect(peek.getByRole('button')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(peek).toHaveCount(0)
  await page.mouse.move(0, 0)
  await bar.focus()
  await expect(peek).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(peek).toHaveCount(0)
  await expect(bar).toBeFocused()

  await bar.press('Enter')
  const panel = page.getByRole('dialog')
  await expect(peek).toHaveCount(0)
  await expect(panel.getByTestId('project-linked-notes').getByRole('button', { name: note.title, exact: false })).toBeVisible()
  await panel.getByRole('button', { name: note.title, exact: false }).click()
  await expect(page).toHaveURL(new RegExp(`/notes\\?id=${note.id}`))
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('这段判断应保持原样，不因浏览概览或笔记而重写。')
  await page.goto('/projects')
  await expect(page.getByTestId('project-gantt')).toBeVisible()
  const after = await (await request.get(`/api/notes/${note.id}`)).json()
  expect(after.contentHtml).toBe(before.contentHtml)
  expect(after.revision).toBe(before.revision)
  expect(writes).toEqual([])
})

test('Gantt shows cumulative effort once and explains a status filter with no matching milestones', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('累计统计与筛选方向'), latestProgress: '已有计划，等待开始验证。' } })).json()
  const milestone = await (await request.post('/api/milestones', { data: { areaId: area.id, name: unique('尚未开始的计划'), status: 'planned', startDate: relative(1), targetDate: relative(7) } })).json()
  await page.goto('/projects')
  await page.getByRole('combobox', { name: '方向筛选', exact: true }).selectOption(area.id)
  const chart = page.getByTestId('project-gantt')
  const row = chart.getByTestId('gantt-milestone-row').filter({ hasText: milestone.name })
  await expect(row).toBeVisible()
  const allPeriod = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/projects/overview' && url.searchParams.get('start') === '0'
  })
  await page.getByRole('combobox', { name: '统计期间', exact: true }).selectOption('all')
  expect((await allPeriod).ok()).toBe(true)
  await row.getByRole('button', { name: /查看关联笔记/ }).click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByText('累计投入', { exact: true })).toHaveCount(1)
  await expect(panel.getByText('0 分钟', { exact: true })).toHaveCount(1)
  await panel.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByRole('button', { name: '筛选', exact: true }).click()
  await page.getByRole('combobox', { name: '里程碑状态筛选', exact: true }).selectOption('completed')
  await expect(row).toHaveCount(0)
  await expect(chart.getByTestId('gantt-area-lane')).toHaveCount(1)
  await expect(chart.getByRole('button', { name: area.name, exact: true })).toBeVisible()
  await expect(chart.getByText('当前没有匹配的里程碑', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(chart.getByText('当前没有匹配的里程碑', { exact: true })).toHaveCount(0)
})
