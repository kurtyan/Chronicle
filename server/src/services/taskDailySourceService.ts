import { createHash } from 'node:crypto'
import { getDb } from '../db'
import type { TaskDailyEvidence } from '../../../shared/taskDailySummaryTypes'
import { getLlmSettings, DEFAULT_TASK_DAILY_SUMMARY_PROMPT, TASK_DAILY_SUMMARY_DEFAULT_PROMPT_VERSION } from './llmService'
import { htmlToPlainText } from './searchText'
import { dailyError } from './taskDailySummarySettings'
import { getWorkCalendar, validateWorkDate, workDateAt, workDateRange, type CalendarPolicy } from './workCalendarService'

export function dailyFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function taskDailyPrompt() {
  const settings = getLlmSettings()
  const custom = settings.taskDailySummaryPrompt.trim()
  return {
    text: custom || DEFAULT_TASK_DAILY_SUMMARY_PROMPT,
    version: custom ? `task_daily_summary_custom_${dailyFingerprint(custom).slice(0, 16)}` : TASK_DAILY_SUMMARY_DEFAULT_PROMPT_VERSION,
  }
}

export interface TaskDaySnapshot {
  taskId: string
  date: string
  policy: CalendarPolicy
  period: { start: number; end: number }
  asOf: number
  hasRecordedWork: boolean
  evidence: TaskDailyEvidence[]
  fingerprint: string
  prompt: { text: string; version: string }
}

export function requireDailyTask(taskId: string) {
  const task = getDb().prepare('SELECT id,title,status FROM tasks WHERE id=?').get(taskId) as { id: string; title: string; status: string } | undefined
  if (!task) throw dailyError('Task not found', 'TASK_NOT_FOUND', 404)
  return task
}

export function buildTaskDaySnapshot(taskId: string, date: string, policy: CalendarPolicy = getWorkCalendar(), asOf = Date.now(), prompt = taskDailyPrompt()): TaskDaySnapshot {
  requireDailyTask(taskId)
  validateWorkDate(date)
  const period = workDateRange(date, policy)
  const rows = getDb().prepare(`SELECT * FROM task_entries WHERE task_id=? AND (
    (type='log' AND (work_date=? OR (work_date IS NULL AND created_at>=? AND created_at<?)))
    OR (type='body' AND source_kind='meeting' AND source_started_at<? AND source_ended_at>?)
  ) ORDER BY created_at,id`).all(taskId, date, period.start, period.end, period.end, period.start) as any[]
  const evidence: TaskDailyEvidence[] = rows.map(row => ({
    entryId: row.id,
    type: row.type,
    content: htmlToPlainText(row.content),
    contentHtml: row.content,
    workDate: date,
    dateSource: row.source_kind === 'meeting' ? 'meeting_interval' : row.work_date_source,
    revision: row.revision,
    contentHash: dailyFingerprint(row.content),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    ...(row.source_kind === 'meeting' ? { interval: { start: row.source_started_at, end: row.source_ended_at } } : {}),
  }))
  const hasRecordedWork = Boolean(getDb().prepare(`SELECT 1 FROM work_sessions
    WHERE task_id=? AND started_at<? AND COALESCE(ended_at,?)>?
      AND MIN(COALESCE(ended_at,?),?)>MAX(started_at,?) LIMIT 1`)
    .get(taskId, Math.min(asOf, period.end), asOf, period.start, asOf, Math.min(asOf, period.end), period.start))
  // Time magnitude, current title/status, outline membership and source update timestamps
  // cannot rewrite historical facts. Presence of recorded work distinguishes empty/time-only.
  const fingerprint = dailyFingerprint({
    version: 1, taskId, date, policyId: policy.policyId, period, prompt,
    hasRecordedWork,
    evidence: evidence.map(({ entryId, type, contentHash, workDate, dateSource, sourceKind, sourceId, interval }) => ({ entryId, type, contentHash, workDate, dateSource, sourceKind, sourceId, interval })),
  })
  return { taskId, date, policy, period, asOf, hasRecordedWork, evidence, fingerprint, prompt }
}

/** Explicit attribution changes preserve submission time and receive a revision from the schema trigger. */
export function setTaskEntryWorkDate(taskId: string, entryId: string, workDate: string | null) {
  if (workDate !== null) validateWorkDate(workDate)
  const result = getDb().prepare(`UPDATE task_entries SET work_date=?,work_date_source=? WHERE task_id=? AND id=? AND type='log'`)
    .run(workDate, workDate === null ? 'recorded' : 'explicit', taskId, entryId)
  if (!result.changes) throw dailyError('Log entry not found', 'ENTRY_NOT_FOUND', 404)
  return getDb().prepare('SELECT id,task_id AS taskId,work_date AS workDate,work_date_source AS workDateSource,revision,updated_at AS updatedAt FROM task_entries WHERE id=?').get(entryId)
}

export function entryCandidateDates(row: any, policy: CalendarPolicy, asOf: number): string[] {
  if (row.type === 'log') return [row.work_date ? validateWorkDate(row.work_date) : workDateAt(row.created_at, policy)]
  if (row.source_kind !== 'meeting' || !Number.isFinite(row.source_started_at) || !Number.isFinite(row.source_ended_at) || row.source_ended_at <= row.source_started_at) return []
  return intervalWorkDates(row.source_started_at, Math.min(row.source_ended_at, asOf), policy)
}

export function intervalWorkDates(start: number, end: number, policy: CalendarPolicy): string[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return []
  const dates: string[] = []
  let cursor = start
  while (cursor < end) {
    const date = workDateAt(cursor, policy)
    dates.push(date)
    const next = workDateRange(date, policy).end
    if (next <= cursor) throw dailyError('Invalid calendar interval')
    cursor = next
  }
  return dates
}
