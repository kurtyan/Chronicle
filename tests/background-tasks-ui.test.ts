import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 6, dayOffset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function uniqueDayOffset(): number {
  return 100 + Math.floor(Math.random() * 1000)
}

async function saveEmptyDayScript(page: Page, date: string) {
  const currentRes = await page.request.get(`/api/day-scripts/${date}`)
  expect(currentRes.ok()).toBeTruthy()
  const current = await currentRes.json()
  const saveRes = await page.request.put(`/api/day-scripts/${date}`, {
    data: {
      expectedRevision: current.revision ?? 0,
      document: { type: 'doc', content: [{ type: 'paragraph' }] },
    },
  })
  expect(saveRes.ok()).toBeTruthy()
}

async function dismissBackgroundTasks(page: Page) {
  const res = await page.request.get('/api/background-tasks?includeDismissed=true&limit=200')
  expect(res.ok()).toBeTruthy()
  const tasks = await res.json()
  for (const task of tasks) {
    await page.request.post(`/api/background-tasks/${task.id}/dismiss`).catch(() => {})
  }
}

async function startMockLlm(responses: string[], delayMs = 0) {
  const calls: any[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      calls.push(body ? JSON.parse(body) : {})
      const content = responses[Math.min(calls.length - 1, responses.length - 1)] ?? responses[responses.length - 1] ?? ''
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
  if (!address || typeof address === 'string') throw new Error('Mock LLM server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

test.describe('Background Tasks UI', () => {
  test.beforeEach(async ({ page }) => {
    await dismissBackgroundTasks(page)
  })

  test('sidebar button shows only running count, toggles the panel, and keeps filter height stable', async ({ page }) => {
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const mock = await startMockLlm(['# Done\n\n- Finished.'])
    const date = uniqueScriptDate(uniqueDayOffset())
    await saveEmptyDayScript(page, date)

    try {
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: mock.baseUrl, model: 'mock-model' },
      })

      const started = await page.request.post(`/api/day-scripts/${date}/daily-summary/background`)
      expect(started.ok()).toBeTruthy()
      const startedTask = await started.json()
      await expect.poll(async () => {
        const res = await page.request.get('/api/background-tasks?includeDismissed=true&limit=20')
        const tasks = await res.json()
        return tasks.find((task: any) => task.id === startedTask.id)?.status
      }).toBe('success')

      await page.goto('/today?lang=en')
      await page.waitForSelector('[data-background-tasks-trigger="true"]')

      const trigger = page.locator('[data-background-tasks-trigger="true"]')
      await expect(trigger.locator('span')).toHaveCount(0)

      const panel = page.locator('[data-background-tasks-panel="true"]')
      await trigger.click()
      await expect(panel).toBeVisible()
      const openedHeight = (await panel.boundingBox())?.height

      await page.getByRole('button', { name: 'Running' }).click()
      const runningHeight = (await panel.boundingBox())?.height
      await page.getByRole('button', { name: 'Success' }).click()
      const successHeight = (await panel.boundingBox())?.height
      expect(runningHeight).toBe(openedHeight)
      expect(successHeight).toBe(openedHeight)

      await trigger.click()
      await expect(panel).toHaveCount(0)
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('opening Daily Summary reads existing state and does not start background generation', async ({ page }) => {
    const date = uniqueScriptDate(uniqueDayOffset())
    await saveEmptyDayScript(page, date)
    let backgroundGenerateCalls = 0
    await page.route('**/api/day-scripts/*/daily-summary/background', async (route) => {
      backgroundGenerateCalls += 1
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected regenerate' }) })
    })

    await page.goto(`/today?date=${date}&lang=en`)
    await page.waitForLoadState('load')
    await page.getByLabel('Generate Daily Summary with LLM').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('No daily summary has been generated for this date.')
    await expect(dialog.getByRole('button', { name: 'Generate' })).toBeVisible()
    expect(backgroundGenerateCalls).toBe(0)
  })

  test('Daily Summary markdown rendering preserves session activity soft line breaks', async ({ page }) => {
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const summaryMarkdown = [
      '# Daily Summary',
      '',
      '## Session Activity',
      '05:00 work block',
      '06:00 work block',
      '07:00 no work recorded',
    ].join('\n')
    const mock = await startMockLlm([summaryMarkdown])
    const date = uniqueScriptDate(uniqueDayOffset())
    await saveEmptyDayScript(page, date)

    try {
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: mock.baseUrl, model: 'mock-model' },
      })

      const started = await page.request.post(`/api/day-scripts/${date}/daily-summary/background`)
      expect(started.ok()).toBeTruthy()
      const startedTask = await started.json()
      await expect.poll(async () => {
        const res = await page.request.get('/api/background-tasks?includeDismissed=true&limit=20')
        const tasks = await res.json()
        return tasks.find((task: any) => task.id === startedTask.id)?.status
      }).toBe('success')

      await page.goto(`/today?date=${date}&lang=en`)
      await page.waitForLoadState('load')
      await page.getByLabel('Generate Daily Summary with LLM').click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('heading', { name: 'Session Activity' })).toBeVisible()
      const activityParagraph = dialog.locator('p', { hasText: '05:00 work block' }).first()
      await expect(activityParagraph).toBeVisible()
      const metrics = await activityParagraph.evaluate((element) => ({
        text: (element as HTMLElement).innerText,
        whiteSpace: window.getComputedStyle(element).whiteSpace,
      }))
      expect(metrics.whiteSpace).toBe('pre-wrap')
      expect(metrics.text).toBe('05:00 work block\n06:00 work block\n07:00 no work recorded')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })

  test('clicking a successful meeting extraction task opens the confirmation dialog directly', async ({ page }) => {
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    const mock = await startMockLlm([JSON.stringify({
      title: 'Background extraction review',
      startedAt: '10:00',
      endedAt: '10:15',
      participants: ['Alice'],
      tags: ['review'],
      content: '<p>Reviewed the extracted meeting result.</p>',
      warnings: [],
    })])
    const draftHash = `ui-${Date.now()}`

    try {
      await page.request.put('/api/settings/llm', {
        data: { ...originalSettings, baseUrl: mock.baseUrl, model: 'mock-model' },
      })

      const started = await page.request.post('/api/meetings/extract/background', {
        data: {
          rawContent: '<p>10:00-10:15 Alice reviewed background task extraction.</p>',
          mode: 'record',
          draftHash,
        },
      })
      expect(started.ok()).toBeTruthy()
      const startedTask = await started.json()
      await expect.poll(async () => {
        const res = await page.request.get('/api/background-tasks?includeDismissed=true&limit=20')
        const tasks = await res.json()
        return tasks.find((task: any) => task.id === startedTask.id)?.status
      }).toBe('success')

      await page.goto('/today?lang=en')
      await page.waitForSelector('[data-background-tasks-trigger="true"]')
      await page.locator('[data-background-tasks-trigger="true"]').click()
      await page.getByRole('button', { name: 'Success' }).click()
      await page.getByRole('button', { name: 'Meeting extraction' }).first().click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Review extracted fields before finishing.')
      await expect(dialog.locator('input.field-input').first()).toHaveValue('Background extraction review')
      await expect(dialog.getByRole('button', { name: 'Save Meeting' })).toBeVisible()
      await expect(dialog).not.toContainText('Open Confirm View')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })
})
