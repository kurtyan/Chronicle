import { createHash } from 'crypto'
import { z } from 'zod'
import { getDb } from '../db'
import { getTaskById, getTaskEntries, getAllTasks } from './taskService'
import { DEFAULT_TASK_SUMMARY_PROMPT, TASK_SUMMARY_DEFAULT_PROMPT_VERSION, getLlmSettings, insertLlmCallLog, linkLlmCallLogToTask } from './llmService'

export interface TaskProgressSummary {
  taskId: string
  latestProgress: string
  nextStep: string
  recommendedNextStep: string
  summaryUpdatedAt: number | null
  stale: boolean
  errorMessage: string | null
}

export interface TaskProgressContext {
  taskId: string
  taskTitle: string
  status: string
  totalWorkMs: number
  lastActivityAt: number | null
  summary: TaskProgressSummary
}

export interface TaskSummaryTestResult {
  taskId: string
  latestProgress: string
  nextStep: string
  recommendedNextStep: string
  llmCallLogId: string | null
}

interface CacheRow {
  task_id: string
  fingerprint: string
  latest_progress: string
  next_step: string
  recommended_next_step: string
  summary_updated_at: number
  error_message: string | null
}

const summarySchema = z.object({
  latestProgress: z.string().trim().min(1),
  nextStep: z.string(),
  recommendedNextStep: z.string().optional().default(''),
}).strict()

function queryAll(sql: string, params: any[] = []): any[] {
  return getDb().prepare(sql).all(...params)
}

function queryOne(sql: string, params: any[] = []): any | null {
  return getDb().prepare(sql).get(...params)
}

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params)
}

function escapeJson(text: string): string {
  return text.replace(/\u0000/g, '')
}

function getEffectiveTaskSummaryPrompt(): { prompt: string; version: string } {
  const settings = getLlmSettings()
  const customPrompt = settings.taskSummaryPrompt.trim()
  if (customPrompt) {
    const hash = createHash('sha1').update(customPrompt).digest('hex').slice(0, 12)
    return { prompt: customPrompt, version: `task_summary_custom_${hash}` }
  }
  return { prompt: DEFAULT_TASK_SUMMARY_PROMPT, version: TASK_SUMMARY_DEFAULT_PROMPT_VERSION }
}

function makeFingerprint(taskId: string): string {
  const task = getTaskById(taskId)
  if (!task) return ''
  const entries = getRecentSummaryEntries(taskId).map((entry) => `${entry.type}:${entry.createdAt}:${entry.content}`)
  const { prompt, version } = getEffectiveTaskSummaryPrompt()

  return createHash('sha1')
    .update(JSON.stringify({
      promptVersion: version,
      prompt,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      entries,
    }))
    .digest('hex')
}

function readCache(taskId: string): CacheRow | null {
  return queryOne('SELECT * FROM task_progress_summaries WHERE task_id = ?', [taskId]) as CacheRow | null
}

function getTotalWorkMs(taskId: string): number {
  const rows = queryAll('SELECT started_at, ended_at FROM work_sessions WHERE task_id = ?', [taskId]) as Array<{ started_at: number; ended_at: number | null }>
  const now = Date.now()
  return rows.reduce((sum, row) => sum + ((row.ended_at ?? now) - row.started_at), 0)
}

function getLastActivityAt(taskId: string, fallbackUpdatedAt: number): number | null {
  const entry = queryOne('SELECT MAX(created_at) as value FROM task_entries WHERE task_id = ?', [taskId]) as { value: number | null } | null
  const session = queryOne(
    'SELECT MAX(COALESCE(ended_at, started_at)) as value FROM work_sessions WHERE task_id = ?',
    [taskId]
  ) as { value: number | null } | null

  return Math.max(fallbackUpdatedAt, entry?.value ?? 0, session?.value ?? 0) || null
}

function fallbackSummary(taskId: string): { latestProgress: string; nextStep: string; recommendedNextStep: string } {
  const entries = getTaskEntries(taskId)
  const latestLog = [...entries].reverse().find((entry) => entry.type === 'log')
  const explicitNextStep = extractExplicitNextStep(entries.map((entry) => stripHtmlWithoutCodeBlocks(entry.content)).reverse())
  return {
    latestProgress: latestLog ? normalizeSummaryValue(stripHtmlWithoutCodeBlocks(latestLog.content)) : 'No recent progress recorded.',
    nextStep: explicitNextStep || '',
    recommendedNextStep: '',
  }
}

function stripHtml(content: string): string {
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function stripHtmlWithoutCodeBlocks(content: string): string {
  // Match <pre> with or without attributes, non-greedily across newlines
  const withoutPre = content.replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, '')
  return stripHtml(withoutPre)
}

function normalizeSummaryValue(value: string): string {
  return value
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getRecentSummaryEntries(taskId: string) {
  return getTaskEntries(taskId).slice(-10)
}

function buildSummaryInputText(input: { title: string; status: string; entries: Array<{ type: string; createdAt: string; content: string }> }): string {
  const entryLines = input.entries.length > 0
    ? input.entries.map((entry, index) => [
        `Entry ${index + 1}`,
        `Type: ${entry.type}`,
        `Submitted At: ${entry.createdAt}`,
        `Content:`,
        entry.content,
      ].join('\n')).join('\n\n')
    : 'No recent entries.'

  return [
    `Task Title: ${input.title}`,
    `Task Status: ${input.status}`,
    '',
    'Recent Task Entries:',
    entryLines,
  ].join('\n')
}

function extractExplicitNextStep(contents: string[]): string {
  for (const content of contents) {
    const text = stripHtml(content)
    const match = text.match(/(?:下一步(?:需要|计划)?|接下来(?:的计划)?|next\s*steps?|next\s*step|todo|计划)[:：\-]?\s*(.{1,240})/i)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

function parseLlmJsonObject(raw: string): any {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const repaired = escapeControlCharsInsideJsonStrings(trimmed)
    try {
      return JSON.parse(repaired)
    } catch {
      const start = repaired.indexOf('{')
      const end = repaired.lastIndexOf('}')
      if (start >= 0 && end > start) return JSON.parse(repaired.slice(start, end + 1))
      throw new Error('No JSON object found in LLM response')
    }
  }
}

function escapeControlCharsInsideJsonStrings(raw: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (const char of raw) {
    if (escaped) {
      result += char
      escaped = false
      continue
    }

    if (char === '\\') {
      result += char
      escaped = true
      continue
    }

    if (char === '"') {
      result += char
      inString = !inString
      continue
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n'
        continue
      }
      if (char === '\r') {
        result += '\\r'
        continue
      }
      if (char === '\t') {
        result += '\\t'
        continue
      }
    }

    result += char
  }

  return result
}

async function callSummaryModel(taskId: string, mode: 'record' | 'test' = 'record'): Promise<TaskSummaryTestResult> {
  const settings = getLlmSettings()
  if (!settings.baseUrl || !settings.model) {
    return { taskId, ...fallbackSummary(taskId), llmCallLogId: null }
  }

  const task = getTaskById(taskId)
  if (!task) return { taskId, ...fallbackSummary(taskId), llmCallLogId: null }
  const entries = getRecentSummaryEntries(taskId)
  const { prompt, version: promptVersion } = getEffectiveTaskSummaryPrompt()

  const input = {
    taskId,
    mode,
    title: task.title,
    status: task.status,
    entries: entries.map((entry) => ({
      type: entry.type,
      createdAt: new Date(entry.createdAt).toISOString(),
      content: stripHtmlWithoutCodeBlocks(entry.content),
    })),
  }
  const inputText = buildSummaryInputText(input)
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: inputText },
  ]
  const logId = crypto.randomUUID()
  const started = Date.now()
  let rawProviderResponse: string | null = null
  let rawResponse: string | null = null
  let finishReason: string | null = null
  let parsedOutput: any = null
  let status = 'success'
  let errorMessage: string | null = null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs)
  try {
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0,
          max_tokens: settings.taskSummaryMaxTokens,
          response_format: { type: 'json_object' },
          messages,
        }),
      })
      .catch((err: any) => {
        if (err?.name === 'AbortError') {
          throw new Error(`LLM request timed out after ${settings.timeoutMs} ms`)
        }
        throw err
      })
    const text = await response.text()
    rawProviderResponse = text
    if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    finishReason = json.choices?.[0]?.finish_reason ?? null
    rawResponse = String(json.choices?.[0]?.message?.content ?? '{}').trim()
    if (finishReason === 'length') {
      throw new Error('LLM output was truncated because finish_reason is length. Increase max tokens and retry.')
    }
    const parsed = summarySchema.parse(parseLlmJsonObject(rawResponse))
    const normalizedNextStep = normalizeSummaryValue(parsed.nextStep)
    parsedOutput = {
      latestProgress: normalizeSummaryValue(parsed.latestProgress),
      nextStep: normalizedNextStep,
      recommendedNextStep: normalizedNextStep ? '' : normalizeSummaryValue(parsed.recommendedNextStep),
    }
    return { taskId, ...parsedOutput, llmCallLogId: logId }
  } catch (err: any) {
    status = finishReason === 'length' ? 'truncated' : (rawResponse || rawProviderResponse ? 'parse_error' : 'error')
    errorMessage = err?.message ?? 'Task summary failed'
    parsedOutput = fallbackSummary(taskId)
    throw err
  } finally {
    clearTimeout(timeout)
    insertLlmCallLog({
      id: logId,
      feature: 'task_summary',
      promptVersion,
      model: settings.model,
      baseUrl: settings.baseUrl,
      requestInput: { ...input, inputText },
      requestMessages: messages,
      rawProviderResponse,
      rawResponse,
      finishReason,
      parsedOutput,
      status,
      errorMessage,
      latencyMs: Date.now() - started,
    })
    linkLlmCallLogToTask(logId, taskId)
  }
}

export async function testTaskSummaryPrompt(taskId: string): Promise<TaskSummaryTestResult> {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')
  return callSummaryModel(taskId, 'test')
}

function buildTaskContext(taskId: string): TaskProgressContext | null {
  const task = getTaskById(taskId)
  if (!task) return null
  const fingerprint = makeFingerprint(task.id)
  const cached = readCache(task.id)
  const summary = cached
    ? {
        taskId: task.id,
        latestProgress: cached.latest_progress,
        nextStep: cached.next_step,
        recommendedNextStep: cached.recommended_next_step ?? '',
        summaryUpdatedAt: cached.summary_updated_at,
        stale: cached.fingerprint !== fingerprint,
        errorMessage: cached.error_message,
      }
    : {
        taskId: task.id,
        latestProgress: 'Summary pending.',
        nextStep: '',
        recommendedNextStep: '',
        summaryUpdatedAt: null,
        stale: true,
        errorMessage: null,
      }

  return {
    taskId: task.id,
    taskTitle: task.title,
    status: task.status,
    totalWorkMs: getTotalWorkMs(task.id),
    lastActivityAt: getLastActivityAt(task.id, task.updatedAt),
    summary,
  }
}

export function getTaskContexts(statuses: string[]): TaskProgressContext[] {
  const tasks = getAllTasks({ status: statuses }).sort((a, b) => b.updatedAt - a.updatedAt)
  return tasks.map((task) => buildTaskContext(task.id)).filter((context): context is TaskProgressContext => Boolean(context))
}

export async function refreshTaskContexts(taskIds?: string[]): Promise<TaskProgressContext[]> {
  const targets = (taskIds && taskIds.length > 0)
    ? taskIds
    : getAllTasks({ status: ['PENDING', 'DOING'] }).map((task) => task.id)

  for (const taskId of targets) {
    const task = getTaskById(taskId)
    if (!task) continue
    const fingerprint = makeFingerprint(taskId)
    try {
      const summary = await callSummaryModel(taskId)
      run(
        `INSERT INTO task_progress_summaries (
          task_id, fingerprint, latest_progress, next_step, recommended_next_step, summary_updated_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          latest_progress = excluded.latest_progress,
          next_step = excluded.next_step,
          recommended_next_step = excluded.recommended_next_step,
          summary_updated_at = excluded.summary_updated_at,
          error_message = excluded.error_message`,
        [
          taskId,
          fingerprint,
          escapeJson(summary.latestProgress),
          escapeJson(summary.nextStep),
          escapeJson(summary.recommendedNextStep),
          Date.now(),
          null,
        ]
      )
    } catch (error: any) {
      const fallback = fallbackSummary(taskId)
      run(
        `INSERT INTO task_progress_summaries (
          task_id, fingerprint, latest_progress, next_step, recommended_next_step, summary_updated_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          latest_progress = excluded.latest_progress,
          next_step = excluded.next_step,
          recommended_next_step = excluded.recommended_next_step,
          summary_updated_at = excluded.summary_updated_at,
          error_message = excluded.error_message`,
        [
          taskId,
          fingerprint,
          escapeJson(fallback.latestProgress),
          escapeJson(fallback.nextStep),
          escapeJson(fallback.recommendedNextStep),
          Date.now(),
          String(error?.message ?? 'Summary refresh failed'),
        ]
      )
    }
  }

  return targets.map((taskId) => buildTaskContext(taskId)).filter((context): context is TaskProgressContext => Boolean(context))
}
