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
  test('Settings exposes independent Periodic Review token and prompt controls', async ({ page }) => {
    await page.goto('/settings?lang=en')
    await page.getByRole('button', { name: 'Provider', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: 'Area Progress Max Tokens', exact: true })).toBeVisible()
    await expect(page.getByRole('spinbutton', { name: 'Periodic Review Max Tokens', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Area Progress Drafting', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Area Progress Drafting', exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('Area progress drafting prompt')).toHaveValue(/Area's latest progress/)
    await expect(page.getByRole('heading', { name: 'Call Logs', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Periodic Review', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Periodic Review', exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('Periodic review prompt')).toHaveValue(/exact supplied source id/)
    await expect(page.getByRole('button', { name: 'Restore Default', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Call Logs', exact: true })).toBeVisible()
  })

  test('max token inputs allow clearing before entering a replacement value', async ({ page, request }) => {
    const originalSettings = await (await request.get('/api/settings/llm')).json()

    try {
      await page.goto('/settings?lang=en')
      await page.getByRole('button', { name: 'Provider', exact: true }).click()
      const periodicReviewTokens = page.getByRole('spinbutton', {
        name: 'Periodic Review Max Tokens',
        exact: true,
      })

      await expect(periodicReviewTokens).toHaveValue(String(originalSettings.projectInsightMaxTokens))
      await periodicReviewTokens.fill('')
      await expect(periodicReviewTokens).toHaveValue('')
      await periodicReviewTokens.fill('16384')
      await expect(periodicReviewTokens).toHaveValue('16384')
      await page.getByRole('button', { name: 'Save Provider', exact: true }).click()
      await expect(page.getByText('LLM settings saved', { exact: true })).toBeVisible()

      await expect.poll(async () => {
        const saved = await (await request.get('/api/settings/llm')).json()
        return saved.projectInsightMaxTokens
      }).toBe(16384)
    } finally {
      await request.put('/api/settings/llm', { data: originalSettings })
    }
  })

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
          areaProgressMaxTokens: 800,
          projectInsightMaxTokens: 700,
          areaProgressPrompt: 'Custom area progress prompt in {{language}}',
          projectInsightPrompt: 'Custom review prompt in {{language}}',
        },
      })
      expect(save.ok()).toBeTruthy()

      const connection = await request.post('/api/settings/llm/test-connection')
      expect(connection.ok()).toBeTruthy()
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0].max_tokens).toBe(700)
      const saved = await (await request.get('/api/settings/llm')).json()
      expect(saved.projectInsightMaxTokens).toBe(700)
      expect(saved.areaProgressMaxTokens).toBe(800)
      expect(saved.areaProgressPrompt).toBe('Custom area progress prompt in {{language}}')
      expect(saved.projectInsightPrompt).toBe('Custom review prompt in {{language}}')
      expect(saved.defaultAreaProgressPrompt).toContain("Area's latest progress")
      expect(saved.defaultProjectInsightPrompt).toContain('exact supplied source id')
    } finally {
      await request.put('/api/settings/llm', { data: originalSettings })
      await mock.close()
    }
  })
})
