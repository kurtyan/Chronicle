import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { initDb, closeDb } from '../server/src/db'
import { getConfig } from '../server/src/config'
import { callChatCompletionsWithRaw, getLlmSettings, saveLlmSettings, testLlmConnection, insertLlmCallLog, listLlmCallLogs } from '../server/src/services/llmService'
import { DEFAULT_TASK_DAILY_SUMMARY_PROMPT, TASK_DAILY_SUMMARY_DEFAULT_PROMPT_VERSION } from '../shared/llmPrompts'

test.describe.configure({ mode: 'serial' })
let directory: string
let savedEnvironment: Record<string, string | undefined>
const originalFetch = globalThis.fetch

test.beforeEach(() => {
  const root = path.resolve('.dev-data')
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'outline-settings-'))
  const env = {
    CHRONICLE_DB_PATH: path.join(directory, 'test.db'), CHRONICLE_CONFIG_DIR: directory,
    CHRONICLE_CONFIG_PATH: path.join(directory, 'config.json'), CHRONICLE_LOG_DIR: directory,
    CHRONICLE_LOG_PATH: path.join(directory, 'test.log'), CHRONICLE_ATTACHMENT_DIR: path.join(directory, 'attachments'),
    CHRONICLE_LLM_BASE_URL: 'https://mock.invalid/v1', CHRONICLE_LLM_MODEL: 'isolated-settings-model',
    CHRONICLE_LLM_API_KEY: '', CHRONICLE_LLM_TIMEOUT_MS: '1000',
  }
  savedEnvironment = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  initDb()
})
test.afterEach(() => {
  globalThis.fetch = originalFetch
  closeDb()
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(directory, { recursive: true, force: true })
})

test('old config gains an independent task daily summary budget and built-in prompt without rewriting the file', () => {
  const old = { llm: { taskSummaryMaxTokens: 900, dailySummaryMaxTokens: 6000, taskSummaryPrompt: 'latest state', dailySummaryPrompt: 'whole day' } }
  fs.writeFileSync(process.env.CHRONICLE_CONFIG_PATH!, JSON.stringify(old))
  const settings = getLlmSettings()
  expect(settings.taskDailySummaryMaxTokens).toBe(1200)
  expect(settings.taskDailySummaryPrompt).toBe('')
  expect(settings.defaultTaskDailySummaryPrompt).toBe(DEFAULT_TASK_DAILY_SUMMARY_PROMPT)
  expect(settings.defaultTaskDailySummaryPrompt).toContain('sourceEntryIds')
  expect(settings.defaultTaskDailySummaryPrompt).toContain('completed Chronicle workday')
  expect(JSON.parse(fs.readFileSync(process.env.CHRONICLE_CONFIG_PATH!, 'utf8'))).toEqual(old)
})

test('saving and resetting the dedicated prompt/budget preserves other features and unrelated config', () => {
  fs.writeFileSync(process.env.CHRONICLE_CONFIG_PATH!, JSON.stringify({ auto_afk: { enabled: true }, llm: { dailySummaryPrompt: 'whole day', taskSummaryMaxTokens: 4096 } }))
  saveLlmSettings({ taskDailySummaryPrompt: 'summarize only this workday', taskDailySummaryMaxTokens: 16384 })
  const persisted = getConfig()
  expect(persisted.llm.taskDailySummaryMaxTokens).toBe(16384)
  expect(persisted.llm.taskDailySummaryPrompt).toBe('summarize only this workday')
  expect(persisted.llm.dailySummaryPrompt).toBe('whole day')
  expect(persisted.llm.taskSummaryMaxTokens).toBe(4096)
  expect(JSON.parse(fs.readFileSync(process.env.CHRONICLE_CONFIG_PATH!, 'utf8')).auto_afk).toEqual({ enabled: true })
  saveLlmSettings({ timeoutMs: 5000 })
  expect(getLlmSettings().taskDailySummaryPrompt).toBe('summarize only this workday')
  const reset = saveLlmSettings({ taskDailySummaryPrompt: '' })
  expect(reset.taskDailySummaryPrompt).toBe('')
  expect(reset.defaultTaskDailySummaryPrompt).toBe(DEFAULT_TASK_DAILY_SUMMARY_PROMPT)
})

test('the dedicated token limit follows feature normalization and retains omitted values', () => {
  expect(saveLlmSettings({ taskDailySummaryMaxTokens: 90000 }).taskDailySummaryMaxTokens).toBe(32000)
  expect(saveLlmSettings({ taskDailySummaryMaxTokens: 2 }).taskDailySummaryMaxTokens).toBe(16)
  expect(saveLlmSettings({ taskDailySummaryMaxTokens: 2345.9 }).taskDailySummaryMaxTokens).toBe(2345)
  expect(saveLlmSettings({ taskDailySummaryMaxTokens: Number.NaN }).taskDailySummaryMaxTokens).toBe(1200)
  expect(saveLlmSettings({ dailySummaryMaxTokens: 7000 }).taskDailySummaryMaxTokens).toBe(1200)
})

test('shared connection test respects the dedicated budget and provider configuration', async () => {
  let request: any
  let endpoint: string | undefined
  globalThis.fetch = (async (url, init) => {
    endpoint = String(url)
    request = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }))
  }) as typeof fetch
  saveLlmSettings({ taskDailySummaryMaxTokens: 64 })
  expect((await testLlmConnection()).ok).toBe(true)
  expect(endpoint).toBe('https://mock.invalid/v1/chat/completions')
  expect(request.model).toBe('isolated-settings-model')
  expect(request.max_tokens).toBe(64)
})

test('provider retry metadata handles seconds, dates, malformed values, and the one-day cap', async () => {
  for (const [header, expected] of [['15', 15000], ['9999999', 86400000], ['not-a-date', undefined]] as const) {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': header } })) as typeof fetch
    const error = await callChatCompletionsWithRaw(getLlmSettings(), [], 1200).catch(error => error)
    expect(error.message).toBe('LLM request failed (429): rate limited')
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(expected)
  }
  globalThis.fetch = (async () => new Response('unavailable', { status: 503, headers: { 'Retry-After': new Date(Date.now() + 60000).toUTCString() } })) as typeof fetch
  const error = await callChatCompletionsWithRaw(getLlmSettings(), [], 1200).catch(error => error)
  expect(error.status).toBe(503)
  expect(error.retryAfterMs).toBeGreaterThan(58000)
  expect(error.retryAfterMs).toBeLessThanOrEqual(60000)
})

test('task daily summary call logs remain separate from whole-day and current-task summaries', () => {
  for (const feature of ['task_daily_summary', 'daily_summary', 'task_summary']) {
    insertLlmCallLog({ id: `${feature}-log`, feature, promptVersion: TASK_DAILY_SUMMARY_DEFAULT_PROMPT_VERSION,
      model: 'isolated-settings-model', baseUrl: 'https://mock.invalid/v1', requestInput: { mode: 'test' },
      requestMessages: [], rawResponse: '{"summaryText":"核对结果。","sourceEntryIds":[]}', parsedOutput: {},
      finishReason: 'stop', status: 'success', errorMessage: null, latencyMs: 5 })
  }
  expect(listLlmCallLogs('task_daily_summary').map(log => log.id)).toEqual(['task_daily_summary-log'])
})
