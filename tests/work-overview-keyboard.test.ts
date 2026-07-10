import { test, expect, type Page } from '@playwright/test'

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

function uniqueDayOffset(): number {
  return 100 + Math.floor(Math.random() * 1000)
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function cleanupStaleTasks(page: Page) {
  const res = await page.request.get('/api/tasks')
  if (!res.ok()) return
  const tasks = await res.json()
  for (const task of tasks) {
    await page.request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } }).catch(() => {})
  }
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

test.describe('Work overview keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await cleanupStaleTasks(page)
  })

  test('j/k moves cursor and i plans the focused row into the Focus editor', async ({ page }) => {
    const today = workdayDate(5, 0)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    const taskA = await createTask(page, `OverviewKbA-${Date.now()}`)
    const taskB = await createTask(page, `OverviewKbB-${Date.now()}`)

    try {
      await page.request.post(`/api/tasks/${taskA.id}/logs`, {
        data: { content: '<p>下一步：implement jk shortcuts</p>', type: 'log' },
      })
      await page.request.post(`/api/tasks/${taskB.id}/logs`, {
        data: { content: '<p>下一步：review keyboard test coverage</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [taskA.id, taskB.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, today, { type: 'doc', content: [{ type: 'paragraph' }] })

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      await expect(board).toContainText('Work overview')

      const list = page.getByTestId('overall-next-steps-list')
      await expect(list).toBeVisible()
      await list.focus()

      const rows = board.locator('[data-next-step-action-id]')
      await expect(rows).toHaveCount(2)
      const cursor = board.locator('[data-next-step-cursor="true"]')
      await expect(cursor).toHaveCount(1)
      await expect(cursor).toHaveAttribute('data-next-step-action-id', await rows.nth(0).getAttribute('data-next-step-action-id') ?? '')

      await page.keyboard.press('j')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', await rows.nth(1).getAttribute('data-next-step-action-id') ?? '')

      await page.keyboard.press('k')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', await rows.nth(0).getAttribute('data-next-step-action-id') ?? '')

      const firstNameCell = rows.nth(0).locator('[title]').first()
      const firstName = await firstNameCell.getAttribute('title')
      const expectedNextStep = firstName === taskA.title ? 'implement jk shortcuts' : 'review keyboard test coverage'

      await page.keyboard.press('i')
      const editor = page.locator('.day-script-editor.ProseMirror').first()
      await expect(editor).toBeVisible()
      await expect(editor).toContainText('Next step')
      await expect(editor).toContainText(expectedNextStep)
    } finally {
      await page.request.put(`/api/tasks/${taskA.id}`, { data: { status: 'DONE' } })
      await page.request.put(`/api/tasks/${taskB.id}`, { data: { status: 'DONE' } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('clamps cursor at bounds when pressing j/k on a single-item board', async ({ page }) => {
    const date = uniqueScriptDate(uniqueDayOffset() + 45)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    const task = await createTask(page, `OverviewKbClamp-${Date.now()}`)

    try {
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：clamp behavior check</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })

      await page.goto(`/today?date=${date}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      const list = page.getByTestId('overall-next-steps-list')
      await expect(list).toBeVisible()
      await list.focus()

      const rows = board.locator('[data-next-step-action-id]')
      await expect(rows).toHaveCount(1)
      const cursor = board.locator('[data-next-step-cursor="true"]')
      await expect(cursor).toHaveCount(1)
      const onlyRowId = await rows.nth(0).getAttribute('data-next-step-action-id') ?? ''

      await page.keyboard.press('k')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', onlyRowId)

      await page.keyboard.press('j')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', onlyRowId)
    } finally {
      await page.request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('gg jumps to top, G jumps to bottom, ctrl+u/d pages and x hides signal', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 80)
    const yesterday = dateOffset(today, -1)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    const tasks: any[] = []
    try {
      for (let i = 0; i < 8; i++) {
        const task = await createTask(page, `OverviewKbVim-${Date.now()}-${i}`)
        tasks.push(task)
        await page.request.post(`/api/tasks/${task.id}/logs`, {
          data: { content: `<p>下一步：vim step ${i}</p>`, type: 'log' },
        })
      }
      await page.request.post('/api/day-scripts/yesterday', { data: { document: { type: 'doc', content: [{ type: 'paragraph' }] } } }).catch(() => {})
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: tasks.map((t) => t.id) } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '09:00-09:30 @' },
              { type: 'text', text: `@${tasks[0].title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${tasks[0].id}`, taskId: tasks[0].id } }] },
              { type: 'text', text: ': carry over signal' },
            ],
          },
        ],
      })

      await saveDayScript(page, today, { type: 'doc', content: [{ type: 'paragraph' }] })

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      const list = page.getByTestId('overall-next-steps-list')
      await expect(list).toBeVisible()
      await list.focus()

      const rows = board.locator('[data-next-step-action-id]')
      await expect(rows).toHaveCount(tasks.length)
      const cursor = board.locator('[data-next-step-cursor="true"]')
      const lastRowId = await rows.last().getAttribute('data-next-step-action-id') ?? ''
      const firstRowId = await rows.nth(0).getAttribute('data-next-step-action-id') ?? ''

      await page.keyboard.press('G')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', lastRowId)

      await page.keyboard.press('g')
      await page.keyboard.press('g')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', firstRowId)

      const beforeScroll = await list.evaluate((el) => el.scrollTop)
      await page.keyboard.press('Control+d')
      const afterScrollDown = await list.evaluate((el) => el.scrollTop)
      expect(afterScrollDown).toBeGreaterThan(beforeScroll)

      await page.keyboard.press('Control+u')
      const afterScrollUp = await list.evaluate((el) => el.scrollTop)
      expect(afterScrollUp).toBeLessThan(afterScrollDown)

      await page.keyboard.press('G')
      await expect(cursor).toHaveAttribute('data-next-step-action-id', lastRowId)

      const carryRow = board.locator('[data-next-step-source="carry_over"]').filter({ hasText: tasks[0].title })
      if (await carryRow.count()) {
        const idx = await carryRow.first().getAttribute('data-next-step-action-id') ?? ''
        await page.keyboard.press('g')
        await page.keyboard.press('g')
        await expect(cursor).toHaveAttribute('data-next-step-action-id', firstRowId)
        let guard = 0
        while ((await cursor.getAttribute('data-next-step-action-id')) !== idx && guard < 30) {
          await page.keyboard.press('j')
          guard += 1
        }

        await page.keyboard.press('x')
        await expect(board.locator('[data-next-step-source="carry_over"]').filter({ hasText: tasks[0].title })).toHaveCount(0)
      }
    } finally {
      for (const task of tasks) {
        await page.request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
      }
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('q closes the maximized overview panel', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 130)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    const task = await createTask(page, `OverviewKbQ-${Date.now()}`)
    try {
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：close maximized via q</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, today, { type: 'doc', content: [{ type: 'paragraph' }] })

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      await board.getByRole('button', { name: 'Maximize overall next steps' }).click()
      await expect(page.getByTestId('overall-next-steps-maximized')).toBeVisible()

      const maximized = page.getByTestId('overall-next-steps-maximized')
      await expect(maximized).toBeVisible()
      const list = maximized.getByTestId('overall-next-steps-list')
      await expect(list).toBeVisible()
      await list.focus()
      await page.keyboard.press('q')
      await expect(page.getByTestId('overall-next-steps-maximized')).toHaveCount(0)
    } finally {
      await page.request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('o and Enter open the task at the cursor', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 200)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    const task = await createTask(page, `OverviewKbOpen-${Date.now()}`)
    try {
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：open via o or enter</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, today, { type: 'doc', content: [{ type: 'paragraph' }] })

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      const list = page.getByTestId('overall-next-steps-list')
      await expect(list).toBeVisible()
      await list.focus()

      await page.keyboard.press('o')
      const taskDetail = page.locator('h1.text-xl.font-bold', { hasText: task.title }).first()
      await expect(taskDetail).toBeVisible()

      const innerList = page.getByTestId('overall-next-steps-list')
      await innerList.focus()
      const editor = page.locator('.day-script-editor.ProseMirror').first()
      await expect(editor).toBeVisible()
    } finally {
      await page.request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })

  test('+Plan button remains and i still plans after hiding the only explicit signal', async ({ page }) => {
    const today = uniqueScriptDate(uniqueDayOffset() + 220)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    const task = await createTask(page, `OverviewKbHidden-${Date.now()}`)
    try {
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：plan after hidden signal</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, today, { type: 'doc', content: [{ type: 'paragraph' }] })

      await page.goto(`/today?date=${today}&lang=en`)
      await page.waitForLoadState('load')
      const board = page.getByTestId('overall-next-steps-board')
      await expect(board).toBeVisible()
      const list = page.getByTestId('overall-next-steps-list')
      await expect(list).toBeVisible()
      await list.focus()

      const rows = board.locator('[data-next-step-action-id]')
      await expect(rows).toHaveCount(1)
      const row = rows.nth(0)

      await row.getByRole('button', { name: 'Explicit' }).click()
      await row.getByRole('button', { name: 'Hide signal' }).click()

      await expect(row.getByRole('button', { name: 'Explicit' })).toHaveCount(0)
      await expect(row.getByRole('button', { name: 'Plan' })).toBeVisible()

      await list.focus()
      await page.keyboard.press('i')
      const editor = page.locator('.day-script-editor.ProseMirror').first()
      await expect(editor).toBeVisible()
      await expect(editor).toContainText('Next step')
      await expect(editor).toContainText(task.title)
      await expect(editor).not.toContainText('plan after hidden signal')
    } finally {
      await page.request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })
})
