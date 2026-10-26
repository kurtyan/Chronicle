import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type { TaskDailyContentKind, TaskDailyJobState, TaskDaySummary } from '../../../shared/taskDailySummaryTypes'
import { broadcastEvent } from './eventBus'
import { buildTaskDaySnapshot, entryCandidateDates, intervalWorkDates, taskDailyPrompt, type TaskDaySnapshot } from './taskDailySourceService'
import { dailyError, getTaskDailySummarySettings } from './taskDailySummarySettings'
import { assertClosedWorkDate, backfillStartDate, getWorkCalendar, type CalendarPolicy } from './workCalendarService'

export interface TaskDailySummaryRow {
  id: string; task_id: string; work_date: string; calendar_policy_id: string
  period_start: number; period_end: number; summary_text: string; content_kind: TaskDailyContentKind
  input_fingerprint: string; evidence_json: string; source_entry_ids_json: string
  model: string | null; prompt_version: string; generation: number; generated_at: number; llm_call_log_id: string | null
}
export interface TaskDailySummaryJob {
  id: string; task_id: string; work_date: string; calendar_policy_id: string; requested_fingerprint: string
  state: TaskDailyJobState; attempts: number; next_attempt_at: number; lease_token: string | null
  lease_expires_at: number | null; last_error: string | null; updated_at: number
}

export function readTaskDailySummary(taskId: string, date: string, policyId: string): TaskDailySummaryRow | undefined {
  return getDb().prepare('SELECT * FROM task_daily_summaries WHERE task_id=? AND work_date=? AND calendar_policy_id=?').get(taskId, date, policyId) as TaskDailySummaryRow | undefined
}

export function readTaskDailyJob(taskId: string, date: string, policyId: string): TaskDailySummaryJob | undefined {
  return getDb().prepare('SELECT * FROM task_daily_summary_jobs WHERE task_id=? AND work_date=? AND calendar_policy_id=?').get(taskId, date, policyId) as TaskDailySummaryJob | undefined
}

export function taskDaySummaryView(snapshot: TaskDaySnapshot, options: { backfillStart?: string | null } = {}): TaskDaySummary {
  if (snapshot.period.end > snapshot.asOf) return { availability: 'not_applicable', reason: 'date_not_closed' }
  const backfillStart = options.backfillStart === undefined ? backfillStartDate(getWorkCalendar(snapshot.asOf)) : options.backfillStart
  const outsideBackfill = backfillStart !== null && snapshot.date < backfillStart
  const stored = readTaskDailySummary(snapshot.taskId, snapshot.date, snapshot.policy.policyId)
  const job = readTaskDailyJob(snapshot.taskId, snapshot.date, snapshot.policy.policyId)
  if (!stored && !snapshot.evidence.length && !snapshot.hasRecordedWork && !job) return {
    availability: 'historical', text: null, kind: 'empty', freshness: 'fresh', jobState: 'idle', generation: null, generatedAt: null,
  }
  return {
    availability: 'historical', text: stored?.summary_text ?? null, kind: stored?.content_kind ?? null,
    freshness: !stored ? 'missing' : stored.input_fingerprint === snapshot.fingerprint ? 'fresh' : 'stale',
    jobState: job?.state ?? 'idle', generation: stored?.generation ?? null, generatedAt: stored?.generated_at ?? null,
    error: job?.last_error ?? null,
    sourceEntryIds: stored ? JSON.parse(stored.source_entry_ids_json) : [],
    ...(outsideBackfill ? { outsideBackfill: true } : {}),
  }
}

/** One job per Task/date/policy; a fresh explicit request is a read-only no-op. */
export function enqueueTaskDailySummary(snapshot: TaskDaySnapshot, options: { retryFailed?: boolean } = {}) {
  assertClosedWorkDate(snapshot.date, snapshot.policy, snapshot.asOf)
  const db = getDb()
  return db.transaction(() => {
    // A new source snapshot invalidates every partial stage from older inputs.
    // Completed stages of the same snapshot survive retries and process restarts.
    db.prepare('DELETE FROM task_daily_summary_chunks WHERE task_id=? AND work_date=? AND calendar_policy_id=? AND input_fingerprint!=?')
      .run(snapshot.taskId, snapshot.date, snapshot.policy.policyId, snapshot.fingerprint)
    const summary = readTaskDailySummary(snapshot.taskId, snapshot.date, snapshot.policy.policyId)
    if (summary?.input_fingerprint === snapshot.fingerprint) {
      // A source may change and then return to its published contents while an old
      // generation is in flight. Revoke that lease rather than leaving a stale job.
      db.prepare("UPDATE task_daily_summary_jobs SET state='idle',requested_fingerprint=?,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE task_id=? AND work_date=? AND calendar_policy_id=? AND state!='idle'")
        .run(snapshot.fingerprint, snapshot.asOf, snapshot.taskId, snapshot.date, snapshot.policy.policyId)
      return { unchanged: true as const, jobId: null, jobState: 'idle' as const }
    }
    const current = readTaskDailyJob(snapshot.taskId, snapshot.date, snapshot.policy.policyId)
    if (current && current.requested_fingerprint === snapshot.fingerprint) {
      if (current.state === 'failed' && options.retryFailed) {
        db.prepare("UPDATE task_daily_summary_jobs SET state='queued',attempts=0,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=?")
          .run(snapshot.asOf, snapshot.asOf, current.id)
        return { unchanged: false as const, jobId: current.id, jobState: 'queued' as const }
      }
      // Failed jobs remain visible until a source change or an explicit retry. A scan
      // must not turn a permanent provider/output error into unbounded hourly calls.
      if (current.state !== 'idle') return { unchanged: false as const, jobId: current.id, jobState: current.state }
    }
    const id = current?.id ?? randomUUID()
    db.prepare(`INSERT INTO task_daily_summary_jobs(id,task_id,work_date,calendar_policy_id,requested_fingerprint,state,attempts,next_attempt_at,lease_token,lease_expires_at,last_error,updated_at)
      VALUES(?,?,?,?,?,'queued',0,?,NULL,NULL,NULL,?)
      ON CONFLICT(task_id,work_date,calendar_policy_id) DO UPDATE SET requested_fingerprint=excluded.requested_fingerprint,
        state='queued',attempts=0,next_attempt_at=excluded.next_attempt_at,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=excluded.updated_at`)
      .run(id, snapshot.taskId, snapshot.date, snapshot.policy.policyId, snapshot.fingerprint, snapshot.asOf, snapshot.asOf)
    return { unchanged: false as const, jobId: id, jobState: 'queued' as const }
  })()
}

let reconciling = false

/** Complete historical reconciliation, with keyset paging and a connection-local key set. */
export async function reconcileTaskDailySummaries(options: { now?: number; pageSize?: number; shouldStop?: () => boolean } = {}) {
  if (reconciling) return { skipped: true, candidates: 0, queued: 0 }
  reconciling = true
  const now = options.now ?? Date.now()
  const policy = getWorkCalendar(now)
  // The prompt and the backfill window are constant for a pass; resolve them once.
  const prompt = taskDailyPrompt()
  const backfillStart = backfillStartDate(policy)
  const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? 250))
  const db = getDb()
  let candidates = 0, queued = 0
  try {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS task_daily_reconcile_keys(task_id TEXT NOT NULL,work_date TEXT NOT NULL,PRIMARY KEY(task_id,work_date)) WITHOUT ROWID; DELETE FROM task_daily_reconcile_keys;')
    const insertKey = db.prepare('INSERT OR IGNORE INTO task_daily_reconcile_keys(task_id,work_date) VALUES(?,?)')
    const add = (taskId: string, dates: string[]) => { for (const date of dates) if (date <= policy.lastClosedWorkDate && (backfillStart === null || date >= backfillStart)) insertKey.run(taskId, date) }
    let cursor = ''
    while (!options.shouldStop?.()) {
      const rows = db.prepare(`SELECT e.* FROM task_entries e JOIN tasks t ON t.id=e.task_id
        WHERE e.id>? AND (e.type='log' OR (e.type='body' AND e.source_kind='meeting')) ORDER BY e.id LIMIT ?`).all(cursor, pageSize) as any[]
      if (!rows.length) break
      db.transaction(() => { for (const row of rows) add(row.task_id, entryCandidateDates(row, policy, now)) })()
      cursor = rows[rows.length - 1].id
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    cursor = ''
    while (!options.shouldStop?.()) {
      const rows = db.prepare(`SELECT s.* FROM work_sessions s JOIN tasks t ON t.id=s.task_id WHERE s.id>? ORDER BY s.id LIMIT ?`).all(cursor, pageSize) as any[]
      if (!rows.length) break
      db.transaction(() => { for (const row of rows) add(row.task_id, intervalWorkDates(row.started_at, Math.min(row.ended_at ?? now, now), policy)) })()
      cursor = rows[rows.length - 1].id
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    // Previously published keys survive source deletion, so stale facts are cleared.
    db.prepare(`INSERT OR IGNORE INTO task_daily_reconcile_keys SELECT s.task_id,s.work_date FROM task_daily_summaries s JOIN tasks t ON t.id=s.task_id WHERE s.calendar_policy_id=? AND s.work_date<=? AND s.work_date>=?`)
      .run(policy.policyId, policy.lastClosedWorkDate, backfillStart ?? '0000-00-00')
    let taskCursor = '', dateCursor = ''
    while (!options.shouldStop?.()) {
      const keys = db.prepare(`SELECT task_id,work_date FROM task_daily_reconcile_keys WHERE task_id>? OR (task_id=? AND work_date>?) ORDER BY task_id,work_date LIMIT ?`)
        .all(taskCursor, taskCursor, dateCursor, pageSize) as Array<{ task_id: string; work_date: string }>
      if (!keys.length) break
      // The yielding scan may race a calendar change; check once per page.
      if (getWorkCalendar().policyId !== policy.policyId) return { skipped: true, candidates, queued }
      for (const key of keys) {
        // The yielding scan may race a Task deletion.
        if (!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(key.task_id)) continue
        const snapshot = buildTaskDaySnapshot(key.task_id, key.work_date, policy, now, prompt)
        candidates++
        if (!enqueueTaskDailySummary(snapshot).unchanged) queued++
      }
      taskCursor = keys[keys.length - 1].task_id
      dateCursor = keys[keys.length - 1].work_date
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (!options.shouldStop?.()) pruneTaskDailySummaryLogs(now)
    return { skipped: false, candidates, queued }
  } finally { reconciling = false }
}

/** Drops call logs no published summary cites. Logs a summary cites are its provenance and stay. */
export function pruneTaskDailySummaryLogs(now = Date.now()): number {
  const days = getTaskDailySummarySettings().logRetentionDays
  if (!days) return 0
  return getDb().prepare(`DELETE FROM llm_call_logs WHERE feature='task_daily_summary' AND created_at<?
    AND id NOT IN (SELECT llm_call_log_id FROM task_daily_summaries WHERE llm_call_log_id IS NOT NULL)`).run(now - days * 86400000).changes
}

export function claimTaskDailySummaryJob(policy: CalendarPolicy, now = Date.now(), leaseMs = 120000): TaskDailySummaryJob | null {
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM task_daily_summary_jobs WHERE calendar_policy_id=? AND (
      (state IN ('queued','waiting_config','waiting_budget') AND next_attempt_at<=?)
      OR (state='running' AND lease_expires_at<=?)) ORDER BY next_attempt_at,updated_at,id LIMIT 1`)
      .get(policy.policyId, now, now) as TaskDailySummaryJob | undefined
    if (!row) return null
    const lease = randomUUID()
    db.prepare("UPDATE task_daily_summary_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?")
      .run(lease, now + leaseMs, now, row.id)
    return { ...row, state: 'running' as const, attempts: row.attempts + 1, lease_token: lease, lease_expires_at: now + leaseMs, updated_at: now }
  })()
}

export function renewTaskDailySummaryLease(job: TaskDailySummaryJob, now = Date.now(), leaseMs = 120000): boolean {
  return Boolean(getDb().prepare("UPDATE task_daily_summary_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?")
    .run(now + leaseMs, now, job.id, job.lease_token, now).changes)
}

/** `refundAttempt` returns the claim's attempt: interruptions and provider outages are not job failures. */
export function setTaskDailySummaryJobWait(job: TaskDailySummaryJob, state: 'queued' | 'failed' | 'waiting_config' | 'waiting_budget', message: string, nextAttemptAt: number, now = Date.now(), refundAttempt = false) {
  getDb().prepare(`UPDATE task_daily_summary_jobs SET state=?,last_error=?,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
    attempts=CASE WHEN ? IN ('waiting_config','waiting_budget') OR ?=1 THEN MAX(0,attempts-1) ELSE attempts END,updated_at=?
    WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?`)
    .run(state, message.slice(0, 2000), nextAttemptAt, state, refundAttempt ? 1 : 0, now, job.id, job.lease_token, now)
}

export function publishTaskDailySummary(job: TaskDailySummaryJob, snapshot: TaskDaySnapshot, result: { text: string; kind: TaskDailyContentKind; sourceEntryIds: string[]; model: string | null; llmCallLogId: string | null }, now = Date.now()): boolean {
  const db = getDb()
  const committed = db.transaction(() => {
    const current = db.prepare("SELECT * FROM task_daily_summary_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?")
      .get(job.id, job.lease_token, now) as TaskDailySummaryJob | undefined
    if (!current) return false
    const policy = getWorkCalendar(now)
    if (policy.policyId !== snapshot.policy.policyId || snapshot.period.end > now) {
      db.prepare("UPDATE task_daily_summary_jobs SET state='idle',lease_token=NULL,lease_expires_at=NULL,last_error='Calendar policy changed',updated_at=? WHERE id=? AND lease_token=?").run(now, job.id, job.lease_token)
      return false
    }
    if (!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(snapshot.taskId)) return false
    const latest = buildTaskDaySnapshot(snapshot.taskId, snapshot.date, policy, now)
    if (latest.fingerprint !== snapshot.fingerprint || current.requested_fingerprint !== snapshot.fingerprint) {
      enqueueTaskDailySummary(latest)
      return false
    }
    db.prepare(`INSERT INTO task_daily_summaries(id,task_id,work_date,calendar_policy_id,period_start,period_end,summary_text,content_kind,input_fingerprint,evidence_json,source_entry_ids_json,model,prompt_version,generation,generated_at,llm_call_log_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(task_id,work_date,calendar_policy_id) DO UPDATE SET
      period_start=excluded.period_start,period_end=excluded.period_end,summary_text=excluded.summary_text,content_kind=excluded.content_kind,
      input_fingerprint=excluded.input_fingerprint,evidence_json=excluded.evidence_json,source_entry_ids_json=excluded.source_entry_ids_json,
      model=excluded.model,prompt_version=excluded.prompt_version,generation=task_daily_summaries.generation+1,generated_at=excluded.generated_at,llm_call_log_id=excluded.llm_call_log_id`)
      .run(randomUUID(), snapshot.taskId, snapshot.date, policy.policyId, snapshot.period.start, snapshot.period.end, result.text, result.kind,
        snapshot.fingerprint, JSON.stringify(snapshot.evidence), JSON.stringify(result.sourceEntryIds), result.model, snapshot.prompt.version, now, result.llmCallLogId)
    db.prepare("UPDATE task_daily_summary_jobs SET state='idle',last_error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?").run(now, job.id, job.lease_token)
    return true
  })()
  if (committed) {
    const summary = readTaskDailySummary(snapshot.taskId, snapshot.date, snapshot.policy.policyId)!
    try { broadcastEvent('task_daily_summary_updated', { taskId: snapshot.taskId, date: snapshot.date, policyId: snapshot.policy.policyId, generation: summary.generation }) } catch { /* Persisted work cannot be failed by a disconnected SSE listener. */ }
  }
  return committed
}

export function listTaskDailySummaryJobs(options: { limit?: number; cursor?: string } = {}) {
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw dailyError('limit must be between 1 and 200')
  const rows = getDb().prepare('SELECT * FROM task_daily_summary_jobs WHERE id>? ORDER BY id LIMIT ?').all(options.cursor ?? '', limit + 1) as TaskDailySummaryJob[]
  const items = rows.slice(0, limit).map(row => ({ id: row.id, taskId: row.task_id, date: row.work_date, policyId: row.calendar_policy_id, state: row.state, attempts: row.attempts, nextAttemptAt: row.next_attempt_at, error: row.last_error, updatedAt: row.updated_at }))
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null }
}
