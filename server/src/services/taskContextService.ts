import { createHash } from 'crypto'
import { getDb } from '../db'
import { getTaskById, getTaskEntries, getAllTasks } from './taskService'
import { DEFAULT_TASK_SUMMARY_PROMPT, getLlmSettings, insertLlmCallLog, linkLlmCallLogToTask } from './llmService'

export interface TaskProgressSummary {
  taskId: string
  latestProgress: string
  nextStep: string
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

interface CacheRow {
  task_id: string
  fingerprint: string
  latest_progress: string
  next_step: string
  summary_updated_at: number
  error_message: string | null
}

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

function makeFingerprint(taskId: string): string {
  const task = getTaskById(taskId)
  if (!task) return ''
  const entries = getTaskEntries(taskId).slice(-12).map((entry) => `${entry.type}:${entry.createdAt}:${entry.content}`)
  const sessions = queryAll(
    'SELECT started_at, ended_at FROM work_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 12',
    [taskId]
  ).map((row) => `${row.started_at}:${row.ended_at ?? ''}`)

  return createHash('sha1')
    .update(JSON.stringify({
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      entries,
      sessions,
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

function fallbackSummary(taskId: string): { latestProgress: string; nextStep: string } {
  const entries = getTaskEntries(taskId)
  const latestLog = [...entries].reverse().find((entry) => entry.type === 'log' || entry.type === 'plan')
  const explicitNextStep = extractExplicitNextStep(entries.map((entry) => entry.content).reverse())
  return {
    latestProgress: latestLog?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'No recent progress recorded.',
    nextStep: explicitNextStep || '',
  }
}

function stripHtml(content: string): string {
  return content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
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
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(escapeControlCharsInsideJsonStrings(raw))
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

async function callSummaryModel(taskId: string): Promise<{ latestProgress: string; nextStep: string }> {
  const settings = getLlmSettings()
  if (!settings.baseUrl || !settings.model) {
    return fallbackSummary(taskId)
  }

  const task = getTaskById(taskId)
  if (!task) return fallbackSummary(taskId)
  const entries = getTaskEntries(taskId).slice(-10)
  const workMs = getTotalWorkMs(taskId)
  const prompt = settings.taskSummaryPrompt.trim() || DEFAULT_TASK_SUMMARY_PROMPT
  const promptVersion = settings.taskSummaryPrompt.trim() ? 'task_summary_custom' : 'task_summary_default_v1'

  const input = {
    title: task.title,
    status: task.status,
    totalWorkMs: workMs,
    entries: entries.map((entry) => ({
      type: entry.type,
      createdAt: new Date(entry.createdAt).toISOString(),
      content: stripHtml(entry.content),
    })),
  }
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify(input) },
  ]
  const logId = crypto.randomUUID()
  const started = Date.now()
  let rawResponse: string | null = null
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
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages,
      }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    rawResponse = String(json.choices?.[0]?.message?.content ?? '{}').trim()
    const parsed = parseLlmJsonObject(rawResponse)
    parsedOutput = {
      latestProgress: String(parsed.latestProgress ?? '').trim() || fallbackSummary(taskId).latestProgress,
      nextStep: String(parsed.nextStep ?? '').trim(),
    }
    return parsedOutput
  } catch (err: any) {
    status = rawResponse ? 'parse_error' : 'error'
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
      requestInput: input,
      requestMessages: messages,
      rawResponse,
      parsedOutput,
      status,
      errorMessage,
      latencyMs: Date.now() - started,
    })
    linkLlmCallLogToTask(logId, taskId)
  }
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
        summaryUpdatedAt: cached.summary_updated_at,
        stale: cached.fingerprint !== fingerprint,
        errorMessage: cached.error_message,
      }
    : {
        taskId: task.id,
        latestProgress: 'Summary pending.',
        nextStep: '',
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
          task_id, fingerprint, latest_progress, next_step, summary_updated_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          latest_progress = excluded.latest_progress,
          next_step = excluded.next_step,
          summary_updated_at = excluded.summary_updated_at,
          error_message = excluded.error_message`,
        [
          taskId,
          fingerprint,
          escapeJson(summary.latestProgress),
          escapeJson(summary.nextStep),
          Date.now(),
          null,
        ]
      )
    } catch (error: any) {
      const fallback = fallbackSummary(taskId)
      run(
        `INSERT INTO task_progress_summaries (
          task_id, fingerprint, latest_progress, next_step, summary_updated_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          latest_progress = excluded.latest_progress,
          next_step = excluded.next_step,
          summary_updated_at = excluded.summary_updated_at,
          error_message = excluded.error_message`,
        [
          taskId,
          fingerprint,
          escapeJson(fallback.latestProgress),
          escapeJson(fallback.nextStep),
          Date.now(),
          String(error?.message ?? 'Summary refresh failed'),
        ]
      )
    }
  }

  return targets.map((taskId) => buildTaskContext(taskId)).filter((context): context is TaskProgressContext => Boolean(context))
}
