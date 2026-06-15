import { randomUUID } from 'crypto'
import { getDb } from '../db'

export type BackgroundTaskType = 'daily_summary' | 'task_summary' | 'meeting_extract'
export type BackgroundTaskStatus = 'running' | 'success' | 'error'

export interface BackgroundTask {
  id: string
  type: BackgroundTaskType
  sourceKey: string
  title: string
  status: BackgroundTaskStatus
  result: unknown | null
  error: string | null
  meta: Record<string, unknown>
  readAt: number | null
  dismissedAt: number | null
  createdAt: number
  startedAt: number
  updatedAt: number
  completedAt: number | null
  timeoutAt: number | null
}

export type BackgroundTaskListItem = BackgroundTask

interface BackgroundTaskRow {
  id: string
  type: BackgroundTaskType
  source_key: string
  title: string
  status: BackgroundTaskStatus
  result_json: string | null
  error_message: string | null
  meta_json: string | null
  read_at: number | null
  dismissed_at: number | null
  created_at: number
  started_at: number
  updated_at: number
  completed_at: number | null
  timeout_at: number | null
}

function parseJson(value: string | null, fallback: unknown): unknown {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function sanitizeMeta(type: BackgroundTaskType, meta: Record<string, unknown>): Record<string, unknown> {
  if (type !== 'meeting_extract') return meta
  const { rawContent: _rawContent, ...safeMeta } = meta
  return safeMeta
}

function sanitizeResult(type: BackgroundTaskType, result: unknown): unknown | null {
  if (!result) return null
  if (type !== 'meeting_extract') return result
  if (typeof result !== 'object') return null
  const { rawContent: _rawContent, ...safeResult } = result as Record<string, unknown>
  return safeResult
}

function mapRow(row: BackgroundTaskRow, options: { includeSensitive?: boolean } = {}): BackgroundTask {
  const meta = parseJson(row.meta_json, {}) as Record<string, unknown>
  const result = parseJson(row.result_json, null)
  return {
    id: row.id,
    type: row.type,
    sourceKey: row.source_key,
    title: row.title,
    status: row.status,
    result: options.includeSensitive ? result : sanitizeResult(row.type, result),
    error: row.error_message,
    meta: options.includeSensitive ? meta : sanitizeMeta(row.type, meta),
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    timeoutAt: row.timeout_at,
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function timeoutMessage(task: BackgroundTask): string {
  const elapsedMs = task.timeoutAt && task.startedAt ? Math.max(0, task.timeoutAt - task.startedAt) : 0
  return elapsedMs > 0
    ? `Background task interrupted or timed out after ${elapsedMs} ms`
    : 'Background task interrupted or timed out'
}

export function createOrReuseRunningTask(input: {
  type: BackgroundTaskType
  sourceKey: string
  title: string
  meta?: Record<string, unknown>
  timeoutAt?: number | null
}): BackgroundTask {
  const existing = getDb().prepare(
    `SELECT * FROM background_tasks
     WHERE type = ? AND source_key = ? AND status = 'running'
     ORDER BY updated_at DESC
     LIMIT 1`
  ).get(input.type, input.sourceKey) as BackgroundTaskRow | undefined
  const now = Date.now()
  if (existing) {
      const existingTask = mapRow(existing, { includeSensitive: true })
    if (existingTask.timeoutAt && existingTask.timeoutAt <= now) {
      failBackgroundTask(existingTask.id, timeoutMessage(existingTask))
    } else {
      getDb().prepare(
        `UPDATE background_tasks
         SET title = ?, meta_json = ?, timeout_at = COALESCE(?, timeout_at), updated_at = ?
         WHERE id = ?`
      ).run(input.title, stringify({ ...existingTask.meta, ...(input.meta ?? {}) }), input.timeoutAt ?? null, now, existing.id)
      return getBackgroundTask(existing.id)!
    }
  }

  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO background_tasks (
      id, type, source_key, title, status, result_json, error_message, meta_json,
      read_at, dismissed_at, created_at, started_at, updated_at, completed_at, timeout_at
    ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, NULL, ?, ?, ?, NULL, ?)`
  ).run(id, input.type, input.sourceKey, input.title, stringify(input.meta ?? {}), now, now, now, input.timeoutAt ?? null)
  return getBackgroundTask(id)!
}

export function expireStaleRunningTasks(now = Date.now()): BackgroundTask[] {
  const rows = getDb().prepare(
    `SELECT * FROM background_tasks
     WHERE status = 'running' AND timeout_at IS NOT NULL AND timeout_at <= ?`
  ).all(now) as BackgroundTaskRow[]
  const expired: BackgroundTask[] = []
  for (const row of rows) {
    const task = mapRow(row, { includeSensitive: true })
    const next = failBackgroundTask(task.id, timeoutMessage(task))
    if (next) expired.push(next)
  }
  return expired
}

export function finishBackgroundTask(id: string, result: unknown): BackgroundTask | null {
  if (!id) return null
  const now = Date.now()
  const update = getDb().prepare(
    `UPDATE background_tasks
     SET status = 'success', result_json = ?, error_message = NULL, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`
  ).run(stringify(result), now, now, id)
  if ((update.changes ?? 0) === 0) return getBackgroundTask(id)
  return getBackgroundTask(id)
}

export function failBackgroundTask(id: string, error: string): BackgroundTask | null {
  if (!id) return null
  const now = Date.now()
  const update = getDb().prepare(
    `UPDATE background_tasks
     SET status = 'error', error_message = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`
  ).run(error, now, now, id)
  if ((update.changes ?? 0) === 0) return getBackgroundTask(id)
  return getBackgroundTask(id)
}

export function getBackgroundTask(id: string, options: { includeSensitive?: boolean } = {}): BackgroundTask | null {
  const row = getDb().prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTaskRow | undefined
  if (!row) return null
  const task = mapRow(row, { includeSensitive: true })
  if (task.status === 'running' && task.timeoutAt && task.timeoutAt <= Date.now()) {
    failBackgroundTask(task.id, timeoutMessage(task))
    const expired = getDb().prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTaskRow | undefined
    return expired ? mapRow(expired, options) : null
  }
  return mapRow(row, options)
}

export function getRunningBackgroundTaskBySource(type: BackgroundTaskType, sourceKey: string): BackgroundTask | null {
  const row = getDb().prepare(
    `SELECT * FROM background_tasks
     WHERE type = ? AND source_key = ? AND status = 'running'
     ORDER BY updated_at DESC
     LIMIT 1`
  ).get(type, sourceKey) as BackgroundTaskRow | undefined
  if (!row) return null
  const task = mapRow(row, { includeSensitive: true })
  if (task.timeoutAt && task.timeoutAt <= Date.now()) {
    failBackgroundTask(task.id, timeoutMessage(task))
    return null
  }
  return getBackgroundTask(task.id)
}

export function listBackgroundTasks(options: {
  status?: BackgroundTaskStatus | 'all'
  includeDismissed?: boolean
  limit?: number
} = {}): BackgroundTask[] {
  expireStaleRunningTasks()
  const params: unknown[] = []
  const where: string[] = []
  if (options.status && options.status !== 'all') {
    where.push('status = ?')
    params.push(options.status)
  }
  if (!options.includeDismissed) where.push('dismissed_at IS NULL')
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 100))
  const rows = getDb().prepare(
    `SELECT * FROM background_tasks
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(...params, limit) as BackgroundTaskRow[]
  return rows.map((row) => mapRow(row))
}

export function interruptRunningBackgroundTasks(reason = 'Background task interrupted by server restart'): BackgroundTask[] {
  const rows = getDb().prepare("SELECT * FROM background_tasks WHERE status = 'running'").all() as BackgroundTaskRow[]
  const interrupted: BackgroundTask[] = []
  for (const row of rows) {
    const task = failBackgroundTask(row.id, reason)
    if (task) interrupted.push(task)
  }
  return interrupted
}

export function markBackgroundTaskRead(id: string): BackgroundTask | null {
  getDb().prepare('UPDATE background_tasks SET read_at = COALESCE(read_at, ?), updated_at = updated_at WHERE id = ?').run(Date.now(), id)
  return getBackgroundTask(id)
}

export function dismissBackgroundTask(id: string): BackgroundTask | null {
  const now = Date.now()
  getDb().prepare('UPDATE background_tasks SET dismissed_at = COALESCE(dismissed_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?').run(now, now, id)
  return getBackgroundTask(id)
}

export function consumeBackgroundTask(id: string, meta: Record<string, unknown>): BackgroundTask | null {
  const current = getBackgroundTask(id, { includeSensitive: true })
  if (!current) return null
  const now = Date.now()
  getDb().prepare(
    `UPDATE background_tasks
     SET meta_json = ?, read_at = COALESCE(read_at, ?), updated_at = updated_at
     WHERE id = ?`
  ).run(stringify({ ...current.meta, consumedAt: now, ...meta }), now, id)
  return getBackgroundTask(id)
}

export function cleanupBackgroundTasks(retentionMs = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - retentionMs
  const result = getDb().prepare("DELETE FROM background_tasks WHERE status != 'running' AND updated_at < ?").run(cutoff)
  return Number(result.changes ?? 0)
}
