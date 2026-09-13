import { test, expect, inProcess } from './helpers/projectFixtures'

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'zh-CN' }))
})

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

test('Area summary saves handwritten progress and next steps, retaining readable history', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('方向摘要') } })).json()
  await page.goto(`/projects/areas/${area.id}`)
  const summary = page.getByTestId('project-object-progress')
  await summary.getByRole('button', { name: '更新进展', exact: true }).click()
  const editor = summary.getByTestId('project-inline-editor')
  await editor.getByRole('textbox', { name: '最新成果 / 进展', exact: true }).fill('第一版：已厘清边界和判断依据。')
  await editor.getByRole('textbox', { name: '下一步', exact: true }).fill('第一版：通过新的案例检验。')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(summary).toContainText('第一版：已厘清边界和判断依据。')
  const first = await (await request.get(`/api/areas/${area.id}`)).json()
  expect(first.summarySource).toBe('manual')
  expect(first.summaryUpdatedAt).toBeGreaterThan(0)

  await summary.getByRole('button', { name: '更新进展', exact: true }).click()
  await editor.getByRole('textbox', { name: '最新成果 / 进展', exact: true }).fill('第二版：新案例已验证原判断。')
  await editor.getByRole('button', { name: '保留并关闭', exact: true }).click()
  expect((await (await request.get(`/api/areas/${area.id}`)).json()).latestProgress).toBe(first.latestProgress)
  await summary.getByRole('button', { name: '更新进展', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: '最新成果 / 进展', exact: true })).toHaveValue('第二版：新案例已验证原判断。')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await summary.getByRole('button', { name: '摘要历史', exact: true }).click()
  const history = page.getByRole('dialog')
  await expect(history).toContainText('第一版：已厘清边界和判断依据。')
  await expect(history).toContainText('第二版：新案例已验证原判断。')
  await expect(history.locator('article')).toHaveCount(2)
  await history.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await expect(summary).toContainText('第二版：新案例已验证原判断。')
})

test('Area summary SSE conflicts preserve unsaved text until the user reviews the newer version', async ({ page, request }) => {
  test.skip(inProcess, 'Real SSE required for the concurrent editor lifecycle')
  const area = await (await request.post('/api/areas', { data: { name: unique('并发方向摘要'), latestProgress: '打开前的进展' } })).json()
  await page.goto(`/projects/areas/${area.id}`)
  await expect(page.getByTitle('connected', { exact: true })).toBeVisible()
  const summary = page.getByTestId('project-object-progress')
  await summary.getByRole('button', { name: '更新进展', exact: true }).click()
  const editor = summary.getByTestId('project-inline-editor')
  const progress = editor.getByRole('textbox', { name: '最新成果 / 进展', exact: true })
  await progress.fill('我正在编写但还没有保存的判断')
  const remote = await request.patch(`/api/areas/${area.id}`, { data: { expectedRevision: area.revision, latestProgress: '另一个窗口已经保存的新进展', nextStep: '远端下一步' } })
  expect(remote.ok(), await remote.text()).toBe(true)
  await expect(editor).toContainText('这个对象已有新修改。草稿已保留；请核对当前内容后再决定是否保存。')
  await expect(editor).toContainText('另一个窗口已经保存的新进展')
  await expect(progress).toHaveValue('我正在编写但还没有保存的判断')
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: '已核对新内容，继续保存我的草稿', exact: true }).click()
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect((await (await request.get(`/api/areas/${area.id}`)).json()).latestProgress).toBe('我正在编写但还没有保存的判断')
  await summary.getByRole('button', { name: '摘要历史', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('另一个窗口已经保存的新进展')
})

test('Area LLM summary remains a draft until edited and adopted, and retry reuses its source Note', async ({ page, request }) => {
  const area = await (await request.post('/api/areas', { data: { name: unique('LLM摘要方向'), latestProgress: '已有的人工摘要', nextStep: '已有计划' } })).json()
  const detail = await (await request.get(`/api/areas/${area.id}`)).json()
  const now = Date.now()
  const draft = {
    id: unique('mock-insight'), targetType: 'area', targetId: area.id, status: 'success',
    evidence: {
      version: 1, fingerprint: 'mock-evidence', scope: { targetType: 'area', targetId: area.id },
      window: { start: now - 86400000, end: now, asOf: now, timezone: 'Asia/Shanghai' }, target: area, metrics: {},
      sources: [{ id: 'source-1', kind: 'target', entityId: area.id, title: area.name, content: '已核对一个案例。', createdAt: now, updatedAt: now, revision: area.revision, fingerprint: 'source-fingerprint', role: 'primary' }],
      coverage: { totalSources: 2, totalCharacters: 100, includedSources: 1, includedCharacters: 50, complete: false, warnings: ['部分历史没有被本次分析覆盖。'] },
    },
    content: {
      observations: [{ text: '模型观察：已核对一个案例。', citations: [{ sourceId: 'source-1', quote: '已核对一个案例。' }] }],
      interpretations: [], evidenceGaps: ['第二个案例尚无记录。'], reflectionQuestions: [],
      suggestedChecks: [{ text: '模型建议：再检验一个案例。', citations: [{ sourceId: 'source-1', quote: '已核对一个案例。' }] }],
    },
    model: 'fixture-only', promptVersion: 'fixture-only', budget: { inputCharacters: 96000, maxCalls: 6, maxOutputTokens: 4000 },
    backgroundTaskId: null, error: null, stale: true, staleReason: '生成之后有新记录，请核对。',
    createdAt: now, updatedAt: now, completedAt: now, acceptedNoteId: null as string | null, acceptedAt: null as number | null, previousDraftId: null,
  }
  let created = false
  let sourceNote: any = null
  let noteCreations = 0
  const applied: any[] = []
  let currentDetail = detail
  await page.route(url => url.pathname === `/api/areas/${area.id}`, async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: currentDetail })
    else await route.fallback()
  })
  await page.route('**/api/project-insights**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/project-insights') {
      if (route.request().method() === 'POST') { created = true; await route.fulfill({ status: 202, json: draft }) }
      else await route.fulfill({ json: created ? [draft] : [] })
    } else if (path === `/api/project-insights/${draft.id}`) await route.fulfill({ json: draft })
    else if (path === `/api/project-insights/${draft.id}/accept`) {
      if (!sourceNote) {
        sourceNote = await (await request.post('/api/notes', { data: { title: `${area.name} · 来源草稿`, contentHtml: '<p>模型观察：已核对一个案例。</p><p>来源证据保留。</p>' } })).json()
        noteCreations += 1; draft.acceptedNoteId = sourceNote.id; draft.acceptedAt = now
      }
      await route.fulfill({ json: { draft, note: sourceNote } })
    } else await route.fallback()
  })
  await page.route(`**/api/areas/${area.id}/summary-from-insight`, async route => {
    const input = route.request().postDataJSON()
    applied.push(input)
    if (applied.length === 1) { await route.fulfill({ status: 503, json: { message: '模拟暂时失败，请重试。' } }); return }
    currentDetail = { ...detail, latestProgress: input.latestProgress, nextStep: input.nextStep, revision: detail.revision + 1, summaryUpdatedAt: now, summarySource: 'insight', summarySourceNoteId: sourceNote.id, summarySourceInsightId: draft.id, summarySourceNoteRevision: sourceNote.revision }
    await route.fulfill({ json: currentDetail })
  })

  await page.goto(`/projects/areas/${area.id}`)
  const summary = page.getByTestId('project-object-progress')
  await summary.getByRole('button', { name: '用 AI 起草进展', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '生成进展与下一步草稿', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '审阅并编辑摘要', exact: true }).click()
  const editor = page.getByRole('dialog')
  await expect(editor).toContainText('生成之后有新记录，请核对。')
  await expect(editor).toContainText('部分历史没有被本次分析覆盖。')
  await expect(editor.getByRole('textbox', { name: '方向最新进展', exact: true })).toHaveValue('模型观察：已核对一个案例。')
  await expect(summary).toContainText('已有的人工摘要')
  expect(noteCreations).toBe(0)
  await editor.getByRole('textbox', { name: '方向最新进展', exact: true }).fill('我核对后的进展：一个案例通过，结论仍待验证。')
  await editor.getByRole('textbox', { name: '方向下一步计划', exact: true }).fill('下一步：补齐第二个案例的记录。')
  await editor.getByRole('button', { name: '采用为方向摘要', exact: true }).click()
  await expect(editor).toContainText('模拟暂时失败，请重试。')
  await expect(editor.getByRole('textbox', { name: '方向最新进展', exact: true })).toHaveValue('我核对后的进展：一个案例通过，结论仍待验证。')
  expect(noteCreations).toBe(1)
  await editor.getByRole('button', { name: '采用为方向摘要', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(summary).toContainText('我核对后的进展：一个案例通过，结论仍待验证。')
  await expect(summary).toContainText('下一步：补齐第二个案例的记录。')
  expect(noteCreations).toBe(1)
  expect(applied).toHaveLength(2)
  expect(applied[1]).toMatchObject({ insightDraftId: draft.id, expectedRevision: area.revision, expectedNoteRevision: sourceNote.revision, latestProgress: '我核对后的进展：一个案例通过，结论仍待验证。', nextStep: '下一步：补齐第二个案例的记录。' })
  await summary.getByRole('button', { name: /查看来源 Note · 采用时版本/ }).click()
  await expect(page).toHaveURL(new RegExp(`/notes\\?id=${sourceNote.id}`))
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText('来源证据保留。')
})
