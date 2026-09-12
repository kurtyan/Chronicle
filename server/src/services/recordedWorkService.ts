import { getDb } from '../db'

export interface RecordedWorkRange { start?: number; end?: number; asOf?: number }
export interface RecordedWorkSession {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
  clippedStart: number
  clippedEnd: number
  durationMs: number
}

/** Recorded time is independent of optional project metadata and never writes sessions. */
export function getRecordedWork(range: RecordedWorkRange = {}) {
  const requestedAsOf = range.asOf ?? Date.now(), start = range.start ?? 0, end = range.end ?? requestedAsOf
  if (![start, end, requestedAsOf].every(Number.isFinite) || start < 0 || end < start || requestedAsOf < 0) {
    throw Object.assign(new Error('Invalid statistics range'), { status: 400, code: 'INVALID_STATISTICS_RANGE' })
  }
  // Future ranges are valid, but they cannot add future running time.
  const asOf = Math.min(requestedAsOf, Date.now())
  const rows = getDb().prepare(`SELECT s.id,s.task_id,s.started_at,s.ended_at FROM work_sessions s
    JOIN tasks t ON t.id=s.task_id WHERE s.started_at < ? AND (s.ended_at IS NULL OR s.ended_at > ?) ORDER BY s.started_at,s.id`)
    .all(Math.min(end, asOf), start) as Array<{ id: string; task_id: string; started_at: number; ended_at: number | null }>
  const sessions: RecordedWorkSession[] = []
  const anomalies: Array<{ sessionId: string; reason: string }> = []
  const byTask = new Map<string, number>()
  let totalMs = 0, latestEnd = -1
  for (const row of rows) {
    const clippedStart = Math.max(start, row.started_at)
    const clippedEnd = Math.min(end, asOf, row.ended_at ?? asOf)
    if (clippedEnd <= clippedStart) {
      anomalies.push({ sessionId: row.id, reason: 'Non-positive recorded interval' })
      continue
    }
    if (clippedStart < latestEnd) anomalies.push({ sessionId: row.id, reason: 'Overlaps another recorded session; both retained using Report summation' })
    latestEnd = Math.max(latestEnd, clippedEnd)
    const durationMs = clippedEnd - clippedStart
    sessions.push({ id: row.id, taskId: row.task_id, startedAt: row.started_at, endedAt: row.ended_at, clippedStart, clippedEnd, durationMs })
    byTask.set(row.task_id, (byTask.get(row.task_id) ?? 0) + durationMs)
    totalMs += durationMs
  }
  return { start, end, asOf, totalMs, byTask, sessions, anomalies }
}
