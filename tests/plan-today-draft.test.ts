import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 4, dayOffset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function dateOffset(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(year, month - 1, day + offset)
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-')
}

function workdayDate(offset = 5, dayDelta = 0): string {
  const date = new Date(Date.now() - offset * 3600_000)
  date.setDate(date.getDate() + dayDelta)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function saveDayScript(page: Page, date: string, document: Record<string, any>) {
  const currentRes = await page.request.get(`/api/day-scripts/${date}`)
  expect(currentRes.ok()).toBeTruthy()
  const current = await currentRes.json()
  const saveRes = await page.request.put(`/api/day-scripts/${date}`, {
    data: {
      expectedRevision: current.revision ?? 0,
      document,
    },
  })
  expect(saveRes.ok()).toBeTruthy()
  return saveRes.json()
}

function docText(node: any): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(docText).join('\n')
}

function countNodes(node: any, predicate: (node: any) => boolean): number {
  if (!node) return 0
  return (predicate(node) ? 1 : 0) + (node.content ?? []).reduce((sum: number, child: any) => sum + countNodes(child, predicate), 0)
}

function hasEmptyTextNode(node: any): boolean {
  if (!node) return false
  if (node.type === 'text' && node.text === '') return true
  return (node.content ?? []).some(hasEmptyTextNode)
}

function uniqueDayOffset(): number {
  return 100 + Math.floor(Math.random() * 1000)
}

function findTaskLink(node: any, taskId: string): any | null {
  if (!node) return null
  if (node.type === 'text' && node.marks?.some((mark: any) => mark.type === 'link' && mark.attrs?.taskId === taskId)) return node
  for (const child of node.content ?? []) {
    const found = findTaskLink(child, taskId)
    if (found) return found
  }
  return null
}

function countTaskLinks(node: any, taskId: string): number {
  if (!node) return 0
  const current = node.type === 'text' && node.marks?.some((mark: any) => mark.type === 'link' && mark.attrs?.taskId === taskId) ? 1 : 0
  return current + (node.content ?? []).reduce((sum: number, child: any) => sum + countTaskLinks(child, taskId), 0)
}

function focusParagraph(prefix: string, task: any, suffix: string, attrs?: Record<string, any>) {
  return {
    type: 'paragraph',
    ...(attrs ? { attrs } : {}),
    content: [
      ...(prefix ? [{ type: 'text', text: prefix }] : []),
      {
        type: 'text',
        text: `@${task.title}`,
        marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }],
      },
      ...(suffix ? [{ type: 'text', text: suffix }] : []),
    ],
  }
}

async function startMockLlm(summaries: string[], delayMs = 0) {
  const calls: any[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      calls.push(parsed)
      const content = summaries[Math.min(calls.length - 1, summaries.length - 1)] ?? 'mock summary'
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: `mock-${calls.length}`,
          object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        }))
      }, delayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock LLM server did not bind to a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

test.describe('Plan Today draft', () => {
  test('applying a generated plan draft keeps Today page stable', async ({ page }) => {
    const date = uniqueScriptDate(uniqueDayOffset() + 9)
    const task = await createTask(page, `PlanPreviewMention-${Date.now()}`)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    await saveDayScript(page, date, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '09:00-09:20 existing focus' }] }],
    })
    await page.route(`**/api/day-scripts/${date}/plan-today-draft`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          date,
          document: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: { source: 'task_next_step' },
                content: [
                  { type: 'text', text: '10:00-10:30 ' },
                  { type: 'text', text: `@${task.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }] },
                  { type: 'text', text: ' generated plan' },
                ],
              },
              { type: 'paragraph', content: [{ type: 'text', text: 'Follow up without refreshing the page' }] },
            ],
          },
          sources: { taskCount: 1, recommendedTaskCount: 0, carriedBlockCount: 0 },
        }),
      })
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    await page.getByLabel('Plan Today with LLM task context').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('generated plan')
    await expect(page).not.toHaveURL(new RegExp(`task=${task.id}`))
    await dialog.getByRole('button', { name: 'Apply' }).click()

    await expect(dialog).toHaveCount(0)
    const editor = page.locator('.day-script-editor.ProseMirror').first()
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('existing focus')
    await expect(editor).toContainText('generated plan')
    await expect.poll(() => errors.filter((message) => !message.includes('NO_COLOR')).join('\n')).toBe('')
  })

  test('empty generated plan draft does not crash the Today page', async ({ page }) => {
    const date = uniqueScriptDate(uniqueDayOffset() + 10)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.route(`**/api/day-scripts/${date}/plan-today-draft`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          date,
          document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
          sources: { taskCount: 0, recommendedTaskCount: 0, carriedBlockCount: 0 },
        }),
      })
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    await page.getByLabel('Plan Today with LLM task context').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect.poll(() => errors.join('\n')).toBe('')
  })

  test('includes task next steps and recent unfinished focus blocks', async ({ page }) => {
    const baseDay = uniqueDayOffset()
    const today = uniqueScriptDate(baseDay + 1)
    const yesterday = uniqueScriptDate(baseDay)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      const task = await createTask(page, `PlanToday-${Date.now()}`)
      const carriedTask = await createTask(page, `Carried-${Date.now()}`)
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：整理发布检查清单</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          focusParagraph('', carriedTask, ' 昨日未完成事项'),
          { type: 'paragraph', content: [{ type: 'text', text: '还需要补验证记录' }] },
        ],
      })

      const draftRes = await page.request.post(`/api/day-scripts/${today}/plan-today-draft`)
      expect(draftRes.ok()).toBeTruthy()
      const draft = await draftRes.json()
      const text = docText(draft.document)

      expect(text).toContain('整理发布检查清单')
      expect(text).toContain('昨日未完成事项')
      expect(text).toContain('还需要补验证记录')
      expect(hasEmptyTextNode(draft.document)).toBe(false)
      expect(findTaskLink(draft.document, carriedTask.id)).toBeTruthy()
      expect(draft.document.content.find((node: any) => docText(node).includes('昨日未完成事项'))?.attrs).toMatchObject({
        source: 'carry_over',
      })

      const saved = await saveDayScript(page, today, draft.document)
      const carriedBlock = saved.script.blocks.find((block: any) => block.headerText.includes('昨日未完成事项'))
      expect(carriedBlock?.taskIds).toContain(carriedTask.id)
      expect(carriedBlock?.source).toBe('carry_over')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('dedupes plan draft by work item when carry-over and explicit next step describe the same task', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 33)
    const yesterday = dateOffset(today, -1)
    const task = await createTask(page, `PlanDedupe-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          focusParagraph('09:00-09:30 ', task, ' finish duplicate action'),
          { type: 'paragraph', content: [{ type: 'text', text: 'carry context should stay with the carried item' }] },
        ],
      })
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：finish duplicate action</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      const draftRes = await page.request.post(`/api/day-scripts/${today}/plan-today-draft`)
      expect(draftRes.ok()).toBeTruthy()
      const draft = await draftRes.json()
      const draftText = docText(draft.document)

      expect(countTaskLinks(draft.document, task.id)).toBe(1)
      expect(draftText).toContain('finish duplicate action')
      expect(draftText).toContain('carry context should stay with the carried item')
      expect(draft.sources.carriedBlockCount).toBe(1)
      expect(draftText).not.toContain(`Next step @${task.title}`)
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('Work Overview groups duplicate sources for the same task into one item', async ({ page }) => {
    const today = workdayDate(5, 0)
    const yesterday = dateOffset(today, -1)
    const task = await createTask(page, `OverviewDedupe-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          focusParagraph('09:00-09:30 ', task, ' review duplicate overview action'),
        ],
      })
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：review duplicate overview action</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      await expect(board).toContainText('Work overview')
      await expect(board.locator(`[title="${task.title}"]`)).toHaveCount(1)
      await expect(board).toContainText('Carry-over')
      await expect(board).toContainText('Explicit')
      await expect(board).toContainText('2 signals')

      const card = board.locator('[data-next-step-source="carry_over"]').filter({ hasText: task.title })
      await card.getByRole('button', { name: 'Carry-over' }).click()
      await card.getByRole('button', { name: 'Hide signal' }).click()

      const remainingCard = board.locator('[data-next-step-source="explicit"]').filter({ hasText: task.title })
      await expect(remainingCard).toBeVisible()
      await expect(remainingCard).toContainText('Explicit')
      await expect(remainingCard).not.toContainText('Carry-over')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('Work Overview keeps item order stable when hiding a signal', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 38)
    const yesterday = dateOffset(today, -1)
    const carriedTask = await createTask(page, `OverviewStableCarry-${Date.now()}`)
    const suggestedTask = await createTask(page, `OverviewStableSuggested-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          focusParagraph('09:00-09:30 ', carriedTask, ' stable carry action'),
        ],
      })
      await page.request.post(`/api/tasks/${carriedTask.id}/logs`, {
        data: { content: '<p>下一步：stable explicit action</p>', type: 'log' },
      })
      await page.waitForTimeout(10)
      await page.request.post(`/api/tasks/${suggestedTask.id}/logs`, {
        data: { content: '<p>下一步：newer suggested action</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [carriedTask.id, suggestedTask.id] } })
      expect(summarize.ok()).toBeTruthy()

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      const cards = board.locator('[data-next-step-action-id]')
      const titleOrder = async () => cards.evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector('span[title]')?.getAttribute('title') ?? '')
      )
      await expect.poll(async () => {
        const titles = await titleOrder()
        return titles.includes(carriedTask.title) && titles.includes(suggestedTask.title)
      }).toBeTruthy()
      let titles = await titleOrder()
      expect(titles.indexOf(carriedTask.title)).toBeLessThan(titles.indexOf(suggestedTask.title))
      await expect(cards.filter({ hasText: carriedTask.title })).toContainText('Planned / carried')
      await expect(cards.filter({ hasText: suggestedTask.title })).toContainText('Suggested')

      const carryCard = cards.filter({ hasText: carriedTask.title })
      await carryCard.getByRole('button', { name: 'Carry-over' }).click()
      await carryCard.getByRole('button', { name: 'Hide signal' }).click()

      await expect(carryCard).toContainText('Suggested')
      await expect(carryCard).toContainText('Explicit')
      await expect(carryCard).not.toContainText('Carry-over')
      titles = await titleOrder()
      expect(titles.indexOf(carriedTask.title)).toBeLessThan(titles.indexOf(suggestedTask.title))
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('Work Overview ignores the Board task status filter', async ({ page }) => {
    const task = await createTask(page, `OverviewFilterIsolation-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：keep overview visible after done filter</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await page.goto('/?lang=en')
      await page.waitForLoadState('load')
      await page.getByRole('button', { name: '<' }).click()
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByRole('button', { name: 'Done' })).toHaveClass(/bg-primary/)

      await page.getByTitle('Today').click()
      await expect(page).toHaveURL(/\/today/)
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      await expect(board.locator(`[title="${task.title}"]`)).toBeVisible()
      await expect(board).toContainText('keep overview visible after done filter')
      await expect(board).toContainText('Explicit')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('hidden Work Overview signals are filtered from Plan Today across carry-over days', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 44)
    const yesterday = dateOffset(today, -1)
    const tomorrow = dateOffset(today, 1)
    const carryTask = await createTask(page, `HiddenCarry-${Date.now()}`)
    const explicitTask = await createTask(page, `HiddenExplicit-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          focusParagraph('09:00-09:30 ', carryTask, ' hidden carry action'),
        ],
      })
      await page.request.post(`/api/tasks/${explicitTask.id}/logs`, {
        data: { content: '<p>下一步：hidden explicit action</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [explicitTask.id] } })
      expect(summarize.ok()).toBeTruthy()

      const carryRes = await page.request.get(`/api/day-scripts/${today}/carry-over-blocks`)
      expect(carryRes.ok()).toBeTruthy()
      const carryBlocks = await carryRes.json()
      const carryBlock = carryBlocks.find((block: any) => block.headerText.includes('hidden carry action'))
      expect(carryBlock).toBeTruthy()

      const hideCarry = await page.request.post('/api/work-overview/hidden-signals', {
        data: {
          taskId: carryTask.id,
          sourceType: 'carry_over',
          signalKey: `${carryBlock.originScriptDate ?? ''}:${carryBlock.originBlockId ?? carryBlock.id}`,
        },
      })
      expect(hideCarry.ok()).toBeTruthy()
      const hideExplicit = await page.request.post('/api/work-overview/hidden-signals', {
        data: {
          taskId: explicitTask.id,
          sourceType: 'explicit',
          signalKey: 'hidden explicit action',
        },
      })
      expect(hideExplicit.ok()).toBeTruthy()

      const rawCarryAfterHide = await page.request.get(`/api/day-scripts/${today}/carry-over-blocks`)
      expect(rawCarryAfterHide.ok()).toBeTruthy()
      expect(docText({ content: (await rawCarryAfterHide.json()).map((block: any) => ({ content: [{ type: 'text', text: block.headerText }] })) })).toContain('hidden carry action')

      const todayDraftRes = await page.request.post(`/api/day-scripts/${today}/plan-today-draft`)
      expect(todayDraftRes.ok()).toBeTruthy()
      const todayDraft = await todayDraftRes.json()
      const todayText = docText(todayDraft.document)
      expect(todayText).not.toContain('hidden carry action')
      expect(todayText).not.toContain('hidden explicit action')
      expect(countTaskLinks(todayDraft.document, carryTask.id)).toBe(0)
      expect(countTaskLinks(todayDraft.document, explicitTask.id)).toBe(0)

      const tomorrowDraftRes = await page.request.post(`/api/day-scripts/${tomorrow}/plan-today-draft`)
      expect(tomorrowDraftRes.ok()).toBeTruthy()
      const tomorrowDraft = await tomorrowDraftRes.json()
      const tomorrowText = docText(tomorrowDraft.document)
      expect(tomorrowText).not.toContain('hidden carry action')
      expect(tomorrowText).not.toContain('hidden explicit action')
      expect(countTaskLinks(tomorrowDraft.document, carryTask.id)).toBe(0)
      expect(countTaskLinks(tomorrowDraft.document, explicitTask.id)).toBe(0)
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('carry-over uses a 7 day lineage window and filters stale, completed, and done tasks', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 50)
    const sevenDaysAgo = dateOffset(today, -7)
    const twoDaysAgo = dateOffset(today, -2)
    const yesterday = dateOffset(today, -1)
    const eightDaysAgo = dateOffset(today, -8)

    const lineageTask = await createTask(page, `CarryLineage-${Date.now()}`)
    const oldTask = await createTask(page, `CarryOld-${Date.now()}`)
    const completedTask = await createTask(page, `CarryCompleted-${Date.now()}`)
    const doneTask = await createTask(page, `CarryDone-${Date.now()}`)

    await saveDayScript(page, sevenDaysAgo, {
      type: 'doc',
      content: [
        focusParagraph('09:00-09:30 ', lineageTask, ' original carry action'),
      ],
    })
    const originalBlock = (await (await page.request.get(`/api/day-scripts/${sevenDaysAgo}`)).json()).blocks[0]

    await saveDayScript(page, eightDaysAgo, {
      type: 'doc',
      content: [
        focusParagraph('10:00-10:30 ', oldTask, ' too old carry action'),
      ],
    })

    await saveDayScript(page, twoDaysAgo, {
      type: 'doc',
      content: [
        focusParagraph('11:00-11:30 ', completedTask, ' resolved carry action'),
        focusParagraph('13:00-13:30 ', doneTask, ' done task carry action'),
      ],
    })
    const twoDaysAgoBlocks = (await (await page.request.get(`/api/day-scripts/${twoDaysAgo}`)).json()).blocks
    const completedOrigin = twoDaysAgoBlocks.find((block: any) => block.taskIds.includes(completedTask.id))
    expect(completedOrigin).toBeTruthy()
    await saveDayScript(page, yesterday, {
      type: 'doc',
      content: [
        focusParagraph('09:00-09:30 Carry over ', lineageTask, ': latest carry action', {
          source: 'carry_over',
          originScriptDate: sevenDaysAgo,
          originBlockId: originalBlock.id,
          originSource: 'manual',
        }),
        focusParagraph('11:00-11:30 Carry over ', completedTask, ': resolved carry action ✅', {
          source: 'carry_over',
          originScriptDate: twoDaysAgo,
          originBlockId: completedOrigin.id,
          originSource: 'manual',
        }),
      ],
    })
    const doneUpdate = await page.request.put(`/api/tasks/${doneTask.id}`, {
      data: { status: 'DONE' },
    })
    expect(doneUpdate.ok()).toBeTruthy()

    const carryRes = await page.request.get(`/api/day-scripts/${today}/carry-over-blocks`)
    expect(carryRes.ok()).toBeTruthy()
    const carryBlocks = await carryRes.json()
    const carryText = carryBlocks.map((block: any) => block.headerText).join('\n')
    expect(carryText).toContain('latest carry action')
    expect(carryText).not.toContain('original carry action')
    expect(carryText).not.toContain('too old carry action')
    expect(carryText).not.toContain('resolved carry action')
    expect(carryText).not.toContain('done task carry action')
    expect(carryBlocks.find((block: any) => block.headerText.includes('latest carry action'))).toMatchObject({
      source: 'carry_over',
      originScriptDate: sevenDaysAgo,
      originBlockId: originalBlock.id,
      originSource: 'manual',
    })

    const draftRes = await page.request.post(`/api/day-scripts/${today}/plan-today-draft`)
    expect(draftRes.ok()).toBeTruthy()
    const draft = await draftRes.json()
    const draftText = docText(draft.document)
    expect(draftText).toContain('latest carry action')
    expect(draftText).not.toContain('too old carry action')
      expect(draftText).not.toContain('resolved carry action')
      expect(draftText).not.toContain('done task carry action')
      expect(draft.sources.carriedBlockCount).toBe(1)
      expect(draft.sources.taskCount).toBe(countNodes(draft.document, (node) => node.attrs?.source === 'task_next_step' || node.attrs?.source === 'task_recommended_next_step'))
      expect(draft.sources.recommendedTaskCount).toBe(countNodes(draft.document, (node) => node.attrs?.source === 'task_recommended_next_step'))
      expect(draft.sources.carriedBlockCount).toBe(countNodes(draft.document, (node) => node.attrs?.source === 'carry_over'))
      expect((draft.document.content ?? []).filter((node: any) => node.type === 'horizontalRule')).toHaveLength(0)
  })

  test('excludes stale or failed task summaries from plan counts', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 80)
    const failedTask = await createTask(page, `PlanFailedSummary-${Date.now()}`)
    const freshTask = await createTask(page, `PlanFreshSummary-${Date.now()}`)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()

    try {
      await page.request.post(`/api/tasks/${failedTask.id}/logs`, {
        data: { content: '<p>下一步：do not show failed</p>', type: 'log' },
      })
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: 'http://127.0.0.1:1/v1', model: 'unreachable-model' },
      })
      const failedSummary = await page.request.post('/api/task-context/summarize', { data: { taskIds: [failedTask.id] } })
      expect(failedSummary.ok()).toBeTruthy()

      await page.request.post(`/api/tasks/${freshTask.id}/logs`, {
        data: { content: '<p>下一步：show fresh next step</p>', type: 'log' },
      })
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: '', model: '' },
      })
      const freshSummary = await page.request.post('/api/task-context/summarize', { data: { taskIds: [freshTask.id] } })
      expect(freshSummary.ok()).toBeTruthy()

      const draftRes = await page.request.post(`/api/day-scripts/${today}/plan-today-draft`)
      expect(draftRes.ok()).toBeTruthy()
      const draft = await draftRes.json()
      const draftText = docText(draft.document)
      expect(draftText).not.toContain('do not show failed')
      expect(draftText).toContain('show fresh next step')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('daily summary test mode does not write record cache and uses daily settings', async ({ page }) => {
    const date = uniqueScriptDate(uniqueDayOffset() + 2)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const originalOffset = await (await page.request.get('/api/settings/start-of-day-offset')).json()
    const mock = await startMockLlm(['test summary', 'record summary'])

    try {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 7 } })
      await page.request.put('/api/settings/llm', {
        data: {
          ...originalSettings,
          baseUrl: mock.baseUrl,
          model: 'mock-model',
          meetingExtractionMaxTokens: 111,
          dailySummaryMaxTokens: 1234,
          dailySummaryPrompt: 'Return a concise markdown summary.',
        },
      })

      const testRes = await page.request.post(`/api/day-scripts/${date}/daily-summary`, { data: { refresh: true, mode: 'test' } })
      expect(testRes.ok()).toBeTruthy()
      const testSummary = await testRes.json()
      expect(testSummary.summaryMarkdown).toBe('test summary')
      expect(testSummary.cached).toBe(false)

      const recordRes = await page.request.post(`/api/day-scripts/${date}/daily-summary`, { data: {} })
      expect(recordRes.ok()).toBeTruthy()
      const recordSummary = await recordRes.json()
      expect(recordSummary.summaryMarkdown).toBe('record summary')
      expect(recordSummary.cached).toBe(false)
      expect(mock.calls).toHaveLength(2)
      expect(mock.calls[0].max_tokens).toBe(1234)

      const userContent = mock.calls[0].messages.find((message: any) => message.role === 'user')?.content ?? ''
      const workdayMatch = userContent.match(/Workday: (.+?) to (.+)/)
      expect(workdayMatch).toBeTruthy()
      const start = Date.parse(workdayMatch![1])
      expect(new Date(start).getHours()).toBe(7)

      const cachedRes = await page.request.post(`/api/day-scripts/${date}/daily-summary`, { data: {} })
      expect(cachedRes.ok()).toBeTruthy()
      const cachedSummary = await cachedRes.json()
      expect(cachedSummary.summaryMarkdown).toBe('record summary')
      expect(cachedSummary.cached).toBe(true)
      expect(mock.calls).toHaveLength(2)
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset.offset } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('daily summary background task persists, deduplicates, and writes cache', async ({ page }) => {
    const date = uniqueScriptDate(uniqueDayOffset() + 3)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const mock = await startMockLlm(['background summary'], 200)

    try {
      await page.request.put('/api/settings/llm', {
        data: {
          ...originalSettings,
          baseUrl: mock.baseUrl,
          model: 'mock-model',
          dailySummaryPrompt: 'Return a concise markdown summary.',
        },
      })

      const first = await page.request.post(`/api/day-scripts/${date}/daily-summary/background`)
      expect(first.ok()).toBeTruthy()
      const firstTask = await first.json()
      expect(firstTask.status).toBe('running')
      expect(firstTask.sourceKey).toBe(`daily_summary:${date}`)

      const second = await page.request.post(`/api/day-scripts/${date}/daily-summary/background`)
      expect(second.ok()).toBeTruthy()
      const secondTask = await second.json()
      expect(secondTask.id).toBe(firstTask.id)

      await expect.poll(async () => {
        const res = await page.request.get('/api/background-tasks?includeDismissed=true&limit=20')
        const tasks = await res.json()
        return tasks.find((task: any) => task.id === firstTask.id)?.status
      }).toBe('success')

      const cacheRes = await page.request.get(`/api/day-scripts/${date}/daily-summary-cache`)
      expect(cacheRes.ok()).toBeTruthy()
      const cache = await cacheRes.json()
      expect(cache.summaryMarkdown).toBe('background summary')
      expect(cache.cached).toBe(true)
      expect(mock.calls).toHaveLength(1)
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('daily summary sends only today non-focus logs as facts and separates historical context', async ({ page }) => {
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const originalOffset = await (await page.request.get('/api/settings/start-of-day-offset')).json()
    const mock = await startMockLlm(['summary one', 'summary two'])

    try {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 5 } })
      await page.request.put('/api/settings/llm', {
        data: {
          ...originalSettings,
          baseUrl: mock.baseUrl,
          model: 'mock-model',
          dailySummaryPrompt: 'Return a concise markdown summary.',
        },
      })

      const today = workdayDate(5)
      const task = await createTask(page, `DailySummaryFacts-${Date.now()}`)
      await saveDayScript(page, today, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{
              type: 'text',
              text: `10:00-10:30 @${task.title} ✅`,
              marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }],
            }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'focus-only progress should stay in focus blocks' }] },
        ],
      })
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>manual today note outside focus</p>', type: 'log' },
      })

      const todaySummary = await page.request.post(`/api/day-scripts/${today}/daily-summary`, { data: { refresh: true, mode: 'test' } })
      expect(todaySummary.ok()).toBeTruthy()
      const todayInput = mock.calls
        .flatMap((call) => call.messages ?? [])
        .find((message: any) => message.role === 'user' && String(message.content).includes('Related Task Details:'))
        ?.content ?? ''
      const todayTaskDetails = todayInput.slice(todayInput.indexOf('Related Task Details:'))
      expect(todayInput).toContain('focus-only progress should stay in focus blocks')
      expect(todayTaskDetails).toContain('"todayLogs"')
      expect(todayTaskDetails).toContain('manual today note outside focus')
      expect(todayTaskDetails).not.toContain('Day Script progress')

      const tomorrow = workdayDate(5, 1)
      const historicalTask = await createTask(page, `DailySummaryContext-${Date.now()}`)
      await page.request.post(`/api/tasks/${historicalTask.id}/logs`, {
        data: { content: '<p>historical setup before this workday</p>', type: 'log' },
      })
      await saveDayScript(page, tomorrow, {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: `09:00-09:30 @${historicalTask.title}`,
            marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(historicalTask.id)}`, taskId: historicalTask.id } }],
          }],
        }],
      })

      const tomorrowSummary = await page.request.post(`/api/day-scripts/${tomorrow}/daily-summary`, { data: { refresh: true, mode: 'test' } })
      expect(tomorrowSummary.ok()).toBeTruthy()
      const tomorrowInput = mock.calls
        .flatMap((call) => call.messages ?? [])
        .filter((message: any) => message.role === 'user' && String(message.content).includes('Related Task Details:'))
      const latestTomorrowInput = tomorrowInput[tomorrowInput.length - 1]?.content ?? ''
      const tomorrowDetails = JSON.parse(latestTomorrowInput.slice(latestTomorrowInput.indexOf('[\n')))
      const detail = tomorrowDetails.find((item: any) => item.id === historicalTask.id)
      expect(detail.todayLogs).toEqual([])
      expect(detail.recentContextBeforeToday.map((entry: any) => entry.content).join('\n')).toContain('historical setup before this workday')
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset.offset } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('background task API rejects invalid status filters', async ({ page }) => {
    const res = await page.request.get('/api/background-tasks?status=bogus')
    expect(res.status()).toBe(400)
  })

  test('meeting extraction background task hides raw content in list but exposes it in detail', async ({ page }) => {
    const rawContent = '<p>10:00-10:15 secret roadmap meeting with Alice</p>'
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const mock = await startMockLlm([JSON.stringify({
      title: 'Roadmap meeting',
      startedAt: '10:00',
      endedAt: '10:15',
      content: '<p>Discussed roadmap.</p>',
      participants: ['Alice'],
      tags: ['roadmap'],
      warnings: [],
    })], 100)

    try {
      await page.request.put('/api/settings/llm', {
        data: {
          ...originalSettings,
          baseUrl: mock.baseUrl,
          model: 'mock-model',
        },
      })

      const started = await page.request.post('/api/meetings/extract/background', {
        data: { rawContent, mode: 'record', draftHash: `privacy-${Date.now()}` },
      })
      expect(started.ok()).toBeTruthy()
      const startedTask = await started.json()

      const runningList = await (await page.request.get('/api/background-tasks?includeDismissed=true')).json()
      const runningListTask = runningList.find((task: any) => task.id === startedTask.id)
      expect(JSON.stringify(runningListTask)).not.toContain(rawContent)

      await expect.poll(async () => {
        const res = await page.request.get('/api/background-tasks?includeDismissed=true')
        const tasks = await res.json()
        return tasks.find((task: any) => task.id === startedTask.id)?.status
      }).toBe('success')

      const list = await (await page.request.get('/api/background-tasks?includeDismissed=true')).json()
      const listTask = list.find((task: any) => task.id === startedTask.id)
      expect(JSON.stringify(listTask)).not.toContain(rawContent)

      const detail = await (await page.request.get(`/api/background-tasks/${startedTask.id}`)).json()
      expect(JSON.stringify(detail)).toContain(rawContent)
      expect(detail.result.rawContent).toBe(rawContent)
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })
})
