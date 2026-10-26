import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) {
  throw new Error('Run settings UI tests only with the isolated work-outline runner')
}
let original: any
const createdTasks: string[] = []
test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/settings/task-daily-summary')
  expect(response.ok()).toBeTruthy()
  original = await response.json()
  // Keep deterministic fixtures away from scheduled real-provider requests.
  await request.put('/api/settings/task-daily-summary', { data: { enabled: false } })
})
test.afterEach(async ({ request }) => {
  for (const id of createdTasks.splice(0)) await request.delete(`/api/tasks/${id}`)
  const restored = await request.put('/api/settings/task-daily-summary', { data: original })
  expect(restored.ok()).toBeTruthy()
})

async function openSettings(page: Page) {
  await page.goto('/settings?lang=en')
  await page.getByRole('button', { name: 'Task Daily Summary', exact: true }).click()
  const section = page.getByTestId('task-daily-summary-settings')
  await expect(section.getByRole('button', { name: 'Save Task Daily Summary', exact: true })).toBeEnabled()
  return section
}

test('dedicated settings persist independently and reset to the built-in prompt', async ({ page, request }) => {
  const sharedBefore = await (await request.get('/api/settings/llm')).json()
  let section = await openSettings(page)
  await section.getByLabel('Enable scheduled generation and updates').check()
  await section.getByLabel('Polling interval (minutes)', { exact: true }).fill('120')
  await section.getByLabel('Maximum input characters per call', { exact: true }).fill('16000')
  await section.getByLabel('Daily call limit (0 pauses model calls)', { exact: true }).fill('0')
  await section.getByLabel('Maximum output tokens', { exact: true }).fill('4096')
  await section.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Summarize this completed workday only. Return summaryText and sourceEntryIds.')
  await section.getByRole('button', { name: 'Save Task Daily Summary', exact: true }).click()
  await expect(section.getByText('Task daily summary settings saved', { exact: true })).toBeVisible()
  const saved = await (await request.get('/api/settings/task-daily-summary')).json()
  expect(saved).toMatchObject({ enabled: true, intervalMinutes: 120, maxInputChars: 16000, dailyCallBudget: 0, taskDailySummaryMaxTokens: 4096, taskDailySummaryPrompt: 'Summarize this completed workday only. Return summaryText and sourceEntryIds.' })
  const sharedAfter = await (await request.get('/api/settings/llm')).json()
  for (const key of ['baseUrl', 'model', 'apiKey', 'timeoutMs', 'dailySummaryPrompt', 'taskSummaryMaxTokens']) expect(sharedAfter[key]).toBe(sharedBefore[key])

  section = await openSettings(page)
  await expect(section.getByLabel('Enable scheduled generation and updates')).toBeChecked()
  await expect(section.getByLabel('Polling interval (minutes)', { exact: true })).toHaveValue('120')
  await expect(section.getByLabel('Daily call limit (0 pauses model calls)', { exact: true })).toHaveValue('0')
  await expect(section.getByLabel('Maximum output tokens', { exact: true })).toHaveValue('4096')
  await expect(section.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(saved.taskDailySummaryPrompt)
  await section.getByRole('button', { name: 'Reset to Default Prompt', exact: true }).click()
  await expect(section.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(sharedAfter.defaultTaskDailySummaryPrompt)
  await section.getByRole('button', { name: 'Save Task Daily Summary', exact: true }).click()
  await expect.poll(async () => (await (await request.get('/api/settings/task-daily-summary')).json()).taskDailySummaryPrompt).toBe('')
})

test('invalid numeric drafts show an error without silently replacing the persisted setting', async ({ page, request }) => {
  const section = await openSettings(page)
  await section.getByLabel('Maximum output tokens', { exact: true }).fill('')
  await section.getByRole('button', { name: 'Save Task Daily Summary', exact: true }).click()
  await expect(section.getByText('Maximum output tokens must be a whole number between 16 and 32000.', { exact: true })).toBeVisible()
  expect((await (await request.get('/api/settings/task-daily-summary')).json()).taskDailySummaryMaxTokens).toBe(original.taskDailySummaryMaxTokens)
  await section.getByLabel('Maximum output tokens', { exact: true }).fill('1200')
  await section.getByLabel('Polling interval (minutes)', { exact: true }).fill('0')
  await section.getByRole('button', { name: 'Save Task Daily Summary', exact: true }).click()
  await expect(section.getByText('Polling interval (minutes) must be a whole number between 1 and 1440.', { exact: true })).toBeVisible()
})

test('historical prompt testing uses unsaved inputs, shows call logs, and blocks the current workday', async ({ page, request }) => {
  const task = await (await request.post('/api/tasks', { data: { title: 'Historical settings test Task', type: 'TODO', priority: 'MEDIUM', tags: [] } })).json()
  createdTasks.push(task.id)
  await request.put(`/api/tasks/${task.id}`, { data: { status: 'DONE' } })
  let payload: any
  await page.route(`**/api/tasks/${task.id}/days/*/summary-test`, async route => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { summaryText: '完成配置核对。', sourceEntryIds: ['evidence-test'], llmCallLogId: 'call-test', cached: false } })
  })
  await page.route('**/api/llm-call-logs?feature=task_daily_summary&limit=50', async route => {
    await route.fulfill({ json: [{ id: 'call-test', feature: 'task_daily_summary', promptVersion: 'task_daily_summary_default_v1', model: 'test-only', requestInput: { mode: 'test' }, requestMessages: [], rawProviderResponse: '{}', rawResponse: '{"summaryText":"完成配置核对。"}', parsedOutput: { summaryText: '完成配置核对。' }, status: 'success', errorMessage: null, finishReason: 'stop', latencyMs: 12, createdAt: Date.now(), linkedTaskId: task.id }] })
  })
  const section = await openSettings(page)
  await section.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Unsaved test prompt')
  await section.getByLabel('Maximum output tokens', { exact: true }).fill('2048')
  await section.getByRole('button', { name: 'Test Prompt', exact: true }).click()
  const tester = page.getByTestId('task-daily-summary-test')
  await tester.getByRole('combobox', { name: 'Task', exact: true }).selectOption(task.id)
  await expect(tester.getByLabel('Workday', { exact: true })).toHaveValue(original.calendar.lastClosedWorkDate)
  await tester.getByRole('button', { name: 'Run Test', exact: true }).click()
  await expect(page.getByTestId('task-daily-summary-test-result')).toContainText('完成配置核对。')
  expect(payload).toEqual({ prompt: 'Unsaved test prompt', maxTokens: 2048 })
  await expect(section.getByText('task_daily_summary_default_v1', { exact: true })).toBeVisible()
  expect((await (await request.get('/api/settings/task-daily-summary')).json()).taskDailySummaryPrompt).toBe(original.taskDailySummaryPrompt)

  await tester.getByLabel('Workday', { exact: true }).fill(original.calendar.currentWorkDate)
  await expect(tester.getByRole('button', { name: 'Run Test', exact: true })).toBeDisabled()
  await expect(page.getByTestId('task-daily-summary-test-result')).toHaveCount(0)
  const rejected = await request.post(`/api/tasks/${task.id}/days/${original.calendar.currentWorkDate}/summary-test`, { data: { prompt: 'test', maxTokens: 1200 } })
  expect(rejected.status()).toBe(422)
  expect((await rejected.json()).code).toBe('DATE_NOT_CLOSED')
})

test('failed settings reads are visible and retryable, and failed prompt tests do not show a fabricated result', async ({ page, request }) => {
  const task = await (await request.post('/api/tasks', { data: { title: 'Error settings test Task', type: 'TODO', priority: 'MEDIUM', tags: [] } })).json()
  createdTasks.push(task.id)
  let failRead = true
  await page.route('**/api/settings/task-daily-summary', async route => {
    if (route.request().method() === 'GET' && failRead) {
      failRead = false
      await route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } })
    } else await route.continue()
  })
  await page.goto('/settings?lang=en')
  await page.getByRole('button', { name: 'Task Daily Summary', exact: true }).click()
  const section = page.getByTestId('task-daily-summary-settings')
  await expect(section.getByText('Settings temporarily unavailable', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Save Task Daily Summary', exact: true })).toBeDisabled()
  await section.getByRole('button', { name: 'Reload settings', exact: true }).click()
  await expect(section.getByRole('button', { name: 'Save Task Daily Summary', exact: true })).toBeEnabled()
  await page.route(`**/api/tasks/${task.id}/days/*/summary-test`, async route => {
    await route.fulfill({ status: 503, json: { error: 'Model request timed out' } })
  })
  await section.getByRole('button', { name: 'Test Prompt', exact: true }).click()
  const tester = page.getByTestId('task-daily-summary-test')
  await tester.getByRole('combobox', { name: 'Task', exact: true }).selectOption(task.id)
  await tester.getByRole('button', { name: 'Run Test', exact: true }).click()
  await expect(section.getByText('Model request timed out', { exact: true })).toBeVisible()
  await expect(page.getByTestId('task-daily-summary-test-result')).toHaveCount(0)
  await expect(tester.getByRole('button', { name: 'Run Test', exact: true })).toBeEnabled()
})
