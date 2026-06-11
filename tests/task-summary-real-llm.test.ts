import { test, expect, type APIRequestContext } from '@playwright/test'

async function createTask(request: APIRequestContext, title: string) {
  const res = await request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function appendLog(request: APIRequestContext, taskId: string, content: string) {
  const res = await request.post(`/api/tasks/${taskId}/logs`, {
    data: { content: `<p>${content}</p>`, type: 'log' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function testSummary(request: APIRequestContext, taskId: string) {
  const res = await request.post('/api/task-context/test-summary', {
    data: { taskId },
    timeout: 120000,
  })
  if (!res.ok()) throw new Error(await res.text())
  return res.json()
}

test.describe('Task summary real LLM next step timeline', () => {
  test.setTimeout(180000)

  let originalSettings: any

  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/settings/llm')
    expect(res.ok()).toBeTruthy()
    originalSettings = await res.json()
    expect(originalSettings.baseUrl, 'Real LLM baseUrl must be configured').toBeTruthy()
    expect(originalSettings.model, 'Real LLM model must be configured').toBeTruthy()

    const saveRes = await request.put('/api/settings/llm', {
      data: {
        ...originalSettings,
        taskSummaryPrompt: '',
        taskSummaryMaxTokens: Math.max(originalSettings.taskSummaryMaxTokens ?? 1200, 1200),
      },
    })
    expect(saveRes.ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    if (!originalSettings) return
    await request.put('/api/settings/llm', { data: originalSettings })
  })

  test('clears nextStep when a later entry solves the earlier next step', async ({ request }) => {
    const task = await createTask(request, `LLM next-step solved ${Date.now()}`)
    await appendLog(request, task.id, '初步定位登录超时来自 session refresh。下一步：解决登录超时问题。')
    await appendLog(request, task.id, '已解决登录超时问题并验证通过，目前没有新的下一步计划。')

    const summary = await testSummary(request, task.id)

    expect(summary.latestProgress).toContain('登录')
    expect(summary.nextStep).toBe('')
  })

  test('keeps nextStep when later entries do unrelated work without solving it', async ({ request }) => {
    const task = await createTask(request, `LLM next-step pending ${Date.now()}`)
    await appendLog(request, task.id, '复现了导出失败问题。下一步：解决导出失败问题。')
    await appendLog(request, task.id, '完成了按钮样式调整；导出失败问题还没处理，也没有新的下一步计划。')

    const summary = await testSummary(request, task.id)

    expect(summary.latestProgress).toMatch(/导出|样式/)
    expect(summary.nextStep).toMatch(/导出失败|解决导出/)
  })
})
