import { createHash } from 'crypto'
import { getDb } from '../db'
import { getTaskById, getTaskEntries, getAllTasks } from './taskService'
import { getLlmSettings } from './llmService'

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
  const task = getTaskById(taskId)
  const entries = getTaskEntries(taskId)
  const latestLog = [...entries].reverse().find((entry) => entry.type === 'log' || entry.type === 'plan')
  const body = entries.find((entry) => entry.type === 'body')
  return {
    latestProgress: latestLog?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'No recent progress recorded.',
    nextStep: body?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || `Continue ${task?.title ?? 'this task'}.`,
  }
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
  const prompt = [
    'Summarize the latest task state.',
    'Return JSON only:',
    '{"latestProgress":"string","nextStep":"string"}',
    'Use concise plain English.',
    'Base the answer only on the supplied task data.',
  ].join('\n')

  const input = {
    title: task.title,
    status: task.status,
    totalWorkMs: workMs,
    entries: entries.map((entry) => ({
      type: entry.type,
      createdAt: new Date(entry.createdAt).toISOString(),
      content: entry.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    })),
  }

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
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(input) },
        ],
      }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    const raw = String(json.choices?.[0]?.message?.content ?? '{}').trim()
    const parsed = JSON.parse(raw)
    return {
      latestProgress: String(parsed.latestProgress ?? '').trim() || fallbackSummary(taskId).latestProgress,
      nextStep: String(parsed.nextStep ?? '').trim() || fallbackSummary(taskId).nextStep,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function getTaskContexts(statuses: string[]): TaskProgressContext[] {
  const tasks = getAllTasks({ status: statuses }).sort((a, b) => b.updatedAt - a.updatedAt)
  return tasks.map((task) => {
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
  })
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

  return getTaskContexts(['PENDING', 'DOING']).filter((context) => targets.includes(context.taskId))
}
