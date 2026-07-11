import { getDb } from '../db'
import { upsertTaskSearchDocument, upsertTaskEntrySearchDocument, sourceForEntryType } from './searchIndexService'
import { ensureMeetingTag, linkLlmCallLogToTask } from './llmService'
import { allocateTaskId, getTaskById, type Task } from './taskService'

export interface CreateMeetingRequest {
  title: string
  startedAt: number
  endedAt: number
  content: string
  participants: string[]
  tags: string[]
  rawContent: string
  llmCallLogId?: string
}

export function createMeeting(data: CreateMeetingRequest): Task {
  if (!data.title?.trim()) throw new Error('title is required')
  if (!Number.isFinite(data.startedAt) || !Number.isFinite(data.endedAt)) throw new Error('startedAt and endedAt are required')
  if (data.endedAt <= data.startedAt) throw new Error('endedAt must be after startedAt')

  const db = getDb()
  const now = Date.now()
  const taskId = allocateTaskId()
  const entryId = crypto.randomUUID()
  const tags = ensureMeetingTag(data.tags)
  const participants = uniqueClean(data.participants)

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, title, type, priority, tags, status, created_at, updated_at, started_at, completed_at, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, data.title.trim(), 'TODO', 'MEDIUM', JSON.stringify(tags), 'DONE', now, now, data.startedAt, data.endedAt, null)

    db.prepare('INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(entryId, taskId, data.content.trim(), 'body', now)

    db.prepare('INSERT OR REPLACE INTO task_extra_info(task_id, key, value) VALUES (?, ?, ?)')
      .run(taskId, 'meeting_raw_content', data.rawContent)
    db.prepare('INSERT OR REPLACE INTO task_extra_info(task_id, key, value) VALUES (?, ?, ?)')
      .run(taskId, 'meeting_participants', JSON.stringify(participants))
    db.prepare('INSERT OR REPLACE INTO task_extra_info(task_id, key, value) VALUES (?, ?, ?)')
      .run(taskId, 'meeting_source', 'manual_record')

    const intervals = subtractExistingWorkSessions([{ start: data.startedAt, end: data.endedAt }])
    trimAfkForIntervals(intervals)
    for (const interval of intervals) {
      db.prepare('INSERT INTO work_sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), taskId, interval.start, interval.end)
    }

    if (data.llmCallLogId) linkLlmCallLogToTask(data.llmCallLogId, taskId)
  })

  tx()
  upsertTaskSearchDocument(taskId, data.title.trim(), tags)
  if (data.content.trim()) upsertTaskEntrySearchDocument(taskId, entryId, sourceForEntryType('body'), data.content.trim(), now)
  return getTaskById(taskId)!
}

type Interval = { start: number; end: number }

function subtractExistingWorkSessions(intervals: Interval[]): Interval[] {
  const db = getDb()
  let remaining = intervals
  const rows = db.prepare(`
    SELECT started_at, ended_at
    FROM work_sessions
    WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
    ORDER BY started_at ASC
  `).all(intervals[0].end, Number.MAX_SAFE_INTEGER, intervals[0].start) as Array<{ started_at: number; ended_at: number | null }>

  for (const row of rows) {
    const blocker = { start: row.started_at, end: row.ended_at ?? Number.MAX_SAFE_INTEGER }
    remaining = remaining.flatMap((interval) => subtractInterval(interval, blocker))
  }
  return remaining.filter((interval) => interval.end > interval.start)
}

function subtractInterval(interval: Interval, blocker: Interval): Interval[] {
  if (blocker.end <= interval.start || blocker.start >= interval.end) return [interval]
  const result: Interval[] = []
  if (blocker.start > interval.start) result.push({ start: interval.start, end: Math.min(blocker.start, interval.end) })
  if (blocker.end < interval.end) result.push({ start: Math.max(blocker.end, interval.start), end: interval.end })
  return result
}

function trimAfkForIntervals(intervals: Interval[]): void {
  const db = getDb()
  for (const interval of intervals) {
    const rows = db.prepare(`
      SELECT id, triggered_at, submitted_at, reason, user_note
      FROM afk_events
      WHERE submitted_at IS NOT NULL AND triggered_at < ? AND submitted_at > ?
    `).all(interval.end, interval.start) as Array<{
      id: string
      triggered_at: number
      submitted_at: number
      reason: string
      user_note: string | null
    }>

    for (const row of rows) {
      const afk = { start: row.triggered_at, end: row.submitted_at }
      const pieces = subtractInterval(afk, interval)
      if (pieces.length === 0) {
        db.prepare('DELETE FROM afk_events WHERE id = ?').run(row.id)
      } else if (pieces.length === 1) {
        db.prepare('UPDATE afk_events SET triggered_at = ?, submitted_at = ? WHERE id = ?')
          .run(pieces[0].start, pieces[0].end, row.id)
      } else {
        db.prepare('UPDATE afk_events SET triggered_at = ?, submitted_at = ? WHERE id = ?')
          .run(pieces[0].start, pieces[0].end, row.id)
        db.prepare('INSERT INTO afk_events(id, triggered_at, reason, user_note, submitted_at) VALUES (?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), pieces[1].start, row.reason, row.user_note, pieces[1].end)
      }
    }
  }
}

function uniqueClean(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const clean = String(value).trim()
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(clean)
  }
  return result
}
