import { getDb } from '../db'
import type { TaskDayDetails, TaskDaysResponse } from '../../../shared/taskDailySummaryTypes'
import { getRecordedWork } from './recordedWorkService'
import { addWorkDateDays, backfillStartDate, getWorkCalendar, validateWorkDate, workDateRange } from './workCalendarService'
import { dailyError } from './taskDailySummarySettings'
import { buildTaskDaySnapshot, requireDailyTask, taskDailyPrompt } from './taskDailySourceService'
import { readTaskDailySummary, taskDaySummaryView } from './taskDailySummaryService'

export function queryTaskDays(input: { taskIds: string[]; fromDate?: string; toDate?: string; includeTotals?: boolean }): TaskDaysResponse {
  if (!Array.isArray(input.taskIds) || input.taskIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 100)) throw dailyError('taskIds must be an array of Task IDs')
  if (input.includeTotals !== undefined && typeof input.includeTotals !== 'boolean') throw dailyError('includeTotals must be a boolean')
  const taskIds = [...new Set(input.taskIds)]
  if (taskIds.length > 100) throw dailyError('Query at most 100 Tasks at a time', 'QUERY_RANGE_TOO_LARGE')
  const asOf = Date.now(), calendar = getWorkCalendar(asOf)
  const from = validateWorkDate(input.fromDate ?? addWorkDateDays(calendar.currentWorkDate, -13))
  const to = validateWorkDate(input.toDate ?? calendar.currentWorkDate)
  if (from > to) throw dailyError('fromDate must not be after toDate', 'INVALID_DATE_RANGE')
  const columns: TaskDaysResponse['columns'] = []
  for (let date = from; date <= to; date = addWorkDateDays(date, 1)) {
    if (columns.length >= 31) throw dailyError('Query at most 31 dates at a time', 'QUERY_RANGE_TOO_LARGE')
    columns.push({ date, ...workDateRange(date, calendar), isCurrent: date === calendar.currentWorkDate })
  }
  if (!taskIds.length) return { calendar, asOf, columns, tasks: [], cells: [] }
  const rows = getDb().prepare(`SELECT id,title,status FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as Array<{ id: string; title: string; status: string }>
  const byId = new Map(rows.map(row => [row.id, row]))
  const existingIds = rows.map(row => row.id)
  const work = getRecordedWork({ start: columns[0].start, end: columns[columns.length - 1].end, asOf, taskIds: existingIds })
  const total = input.includeTotals === false ? null : getRecordedWork({ asOf, taskIds: existingIds })
  const active = getDb().prepare(`SELECT DISTINCT task_id FROM work_sessions WHERE ended_at IS NULL AND started_at<=? AND task_id IN (${taskIds.map(() => '?').join(',')})`).all(asOf, ...taskIds) as Array<{ task_id: string }>
  const activeIds = new Set(active.map(row => row.task_id))
  const tasks = taskIds.map(taskId => {
    const row = byId.get(taskId)
    return row ? { taskId, title: row.title, status: row.status, totalRecordedMs: total ? total.byTask.get(taskId) ?? 0 : null, running: activeIds.has(taskId) }
      : { taskId, status: 'MISSING', totalRecordedMs: null, running: false, missing: true }
  })
  const sessionsByTask = new Map<string, typeof work.sessions>()
  for (const session of work.sessions) {
    const group = sessionsByTask.get(session.taskId) ?? []
    group.push(session); sessionsByTask.set(session.taskId, group)
  }
  const cells: TaskDaysResponse['cells'] = []
  const prompt = taskDailyPrompt(), backfillStart = backfillStartDate(calendar)
  for (const taskId of existingIds) for (const column of columns) {
    let recordedMs = 0, running = false
    for (const session of sessionsByTask.get(taskId) ?? []) {
      const duration = Math.min(session.clippedEnd, column.end) - Math.max(session.clippedStart, column.start)
      if (duration <= 0) continue
      recordedMs += duration
      if (session.endedAt === null && column.isCurrent) running = true
    }
    cells.push({ taskId, date: column.date, recordedMs, running,
      summary: column.end > asOf ? { availability: 'not_applicable', reason: 'date_not_closed' }
        : taskDaySummaryView(buildTaskDaySnapshot(taskId, column.date, calendar, asOf, prompt), { backfillStart }) })
  }
  return { calendar, asOf, columns, tasks, cells }
}

export function getTaskDayDetails(taskId: string, date: string, options: { cursor?: string; limit?: number } = {}): TaskDayDetails & { evidenceBasis: 'published_summary' | 'current_sources' | 'not_applicable' } {
  requireDailyTask(taskId)
  validateWorkDate(date)
  const asOf = Date.now(), calendar = getWorkCalendar(asOf), period = workDateRange(date, calendar)
  const work = getRecordedWork({ ...period, asOf, taskIds: [taskId] })
  const running = date === calendar.currentWorkDate && work.sessions.some(session => session.endedAt === null)
  if (period.end > asOf) return { taskId, date, calendar, asOf, period, recordedMs: work.totalMs, running, summary: { availability: 'not_applicable', reason: 'date_not_closed' }, evidence: [], nextCursor: null, sessions: work.sessions, anomalies: work.anomalies, evidenceBasis: 'not_applicable' }
  const snapshot = buildTaskDaySnapshot(taskId, date, calendar, asOf)
  const summary = taskDaySummaryView(snapshot)
  const stored = readTaskDailySummary(taskId, date, calendar.policyId)
  // Show exactly the sources used for a published summary, including its prior
  // revisions when a changed/deleted log has made the displayed summary stale.
  const evidence = stored ? JSON.parse(stored.evidence_json) : snapshot.evidence
  const cursorVersion = stored ? `${stored.id}:${stored.generation}` : snapshot.fingerprint
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw dailyError('limit must be between 1 and 100')
  let offset = 0
  if (options.cursor) {
    let cursor: any
    try {
      if (options.cursor.length > 1000) throw new Error('Too long')
      cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
    } catch { throw dailyError('Invalid evidence cursor') }
    if (cursor.version !== cursorVersion) throw dailyError('Evidence changed; restart pagination', 'EVIDENCE_CHANGED', 409)
    if (!Number.isInteger(cursor.offset) || cursor.offset < 0) throw dailyError('Invalid evidence cursor')
    offset = cursor.offset
  }
  const next = offset + limit
  return { taskId, date, calendar, asOf, period, recordedMs: work.totalMs, running, summary, evidence: evidence.slice(offset, next),
    evidenceBasis: stored ? 'published_summary' : 'current_sources',
    nextCursor: next < evidence.length ? Buffer.from(JSON.stringify({ version: cursorVersion, offset: next })).toString('base64url') : null,
    sessions: work.sessions, anomalies: work.anomalies }
}
