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

async function startMockLlm(summaries: string[]) {
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
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${calls.length}`,
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      }))
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
  test('includes task next steps and yesterday unfinished focus blocks', async ({ page }) => {
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
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '09:00-10:00 ' },
              {
                type: 'text',
                text: `@${carriedTask.title}`,
                marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(carriedTask.id)}`, taskId: carriedTask.id } }],
              },
              { type: 'text', text: ' 昨日未完成事项' },
            ],
          },
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
      expect(findTaskLink(draft.document, carriedTask.id)).toBeTruthy()

      const saved = await saveDayScript(page, today, draft.document)
      const carriedBlock = saved.script.blocks.find((block: any) => block.headerText.includes('昨日未完成事项'))
      expect(carriedBlock?.taskIds).toContain(carriedTask.id)
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
})
