import { test, expect } from '@playwright/test'
import http from 'node:http'

async function startMockLlm() {
  const calls: any[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      calls.push(body ? JSON.parse(body) : {})
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${calls.length}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{"pong":true}' },
        }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock LLM server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

test.describe('LLM settings', () => {
  test('connection test uses the smallest configured feature token budget', async ({ request }) => {
    const originalSettings = await (await request.get('/api/settings/llm')).json()
    const mock = await startMockLlm()

    try {
      const save = await request.put('/api/settings/llm', {
        data: {
          ...originalSettings,
          baseUrl: mock.baseUrl,
          model: 'mock-model',
          meetingExtractionMaxTokens: 2400,
          taskSummaryMaxTokens: 900,
          dailySummaryMaxTokens: 1600,
        },
      })
      expect(save.ok()).toBeTruthy()

      const connection = await request.post('/api/settings/llm/test-connection')
      expect(connection.ok()).toBeTruthy()
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0].max_tokens).toBe(900)
    } finally {
      await request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })
})
