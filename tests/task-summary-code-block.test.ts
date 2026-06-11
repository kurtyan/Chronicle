import { test, expect } from '@playwright/test'

test.describe('Task summary code block stripping', () => {
  let originalSettings: any

  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/settings/llm')
    expect(res.ok()).toBeTruthy()
    originalSettings = await res.json()

    // Clear LLM config to force fallback summary path,
    // so we can test the text processing logic without needing a real LLM.
    const saveRes = await request.put('/api/settings/llm', {
      data: {
        ...originalSettings,
        baseUrl: '',
        model: '',
        taskSummaryPrompt: '',
      },
    })
    expect(saveRes.ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    if (!originalSettings) return
    await request.put('/api/settings/llm', { data: originalSettings })
  })

  test('strips <pre><code> blocks but preserves inline <code> in task summary', async ({ request }) => {
    // Create a task
    const createRes = await request.post('/api/tasks', {
      data: { title: `Code block strip test ${Date.now()}`, type: 'TODO', priority: 'MEDIUM' },
    })
    expect(createRes.ok()).toBeTruthy()
    const task = await createRes.json()

    // Append a log entry with:
    //   1. A <pre><code> block (multi-line code) — should be stripped
    //   2. An inline <code> — should be preserved
    //   3. A next-step phrase — should be picked up by fallback regex
    const logRes = await request.post(`/api/tasks/${task.id}/logs`, {
      data: {
        content: [
          '<p>完成了用户登录模块的重构，上线了 <code>refreshSession()</code> 接口</p>',
          '<pre><code>async function refreshSession() {',
          '  const token = await api.post(\'/refresh\')',
          '  return token',
          '}',
          '</code></pre>',
          '<p>下一步：添加单元测试覆盖</p>',
        ].join('\n'),
        type: 'log',
      },
    })
    expect(logRes.ok()).toBeTruthy()

    // Call test-summary (falls back to deterministic fallback logic)
    const summaryRes = await request.post('/api/task-context/test-summary', {
      data: { taskId: task.id },
    })
    expect(summaryRes.ok()).toBeTruthy()
    const summary = await summaryRes.json()

    // 1. Should contain the meaningful work description (from outside code block)
    expect(summary.latestProgress).toContain('用户登录')

    // 2. Inline code <code> should be preserved in the text
    expect(summary.latestProgress).toContain('refreshSession')

    // 3. Code block implementation details <pre><code> should NOT appear
    expect(summary.latestProgress).not.toContain('async function')
    expect(summary.latestProgress).not.toContain('api.post')

    // 4. Next-step extracted from outside code block
    expect(summary.nextStep).toContain('单元测试')
  })

  test('single log entry with ONLY a code block produces clean fallback summary', async ({ request }) => {
    const createRes = await request.post('/api/tasks', {
      data: { title: `Code block only test ${Date.now()}`, type: 'TODO', priority: 'MEDIUM' },
    })
    expect(createRes.ok()).toBeTruthy()
    const task = await createRes.json()

    // Append a log that is ONLY a code block — no meaningful text
    const logRes = await request.post(`/api/tasks/${task.id}/logs`, {
      data: {
        content: [
          '<pre><code>const x = 1;',
          'const y = 2;',
          'console.log(x + y);',
          '</code></pre>',
        ].join('\n'),
        type: 'log',
      },
    })
    expect(logRes.ok()).toBeTruthy()

    const summaryRes = await request.post('/api/task-context/test-summary', {
      data: { taskId: task.id },
    })
    expect(summaryRes.ok()).toBeTruthy()
    const summary = await summaryRes.json()

    // latestProgress should be empty-ish (code stripped, nothing meaningful left)
    // but fallback keeps the log content after stripping, so it could be empty
    expect(summary.latestProgress).not.toContain('const x')
    expect(summary.latestProgress).not.toContain('console.log')
  })
})
