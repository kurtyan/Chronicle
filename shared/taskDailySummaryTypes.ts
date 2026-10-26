export interface WorkCalendar {
  policyId: string
  timeZone: string
  startOfDayHour: number
  currentWorkDate: string
  lastClosedWorkDate: string
}

export type TaskDailyJobState = 'idle' | 'queued' | 'running' | 'failed' | 'waiting_config' | 'waiting_budget'
export type TaskDailyContentKind = 'llm' | 'time_only' | 'empty'
export type TaskDaySummary =
  | { availability: 'not_applicable'; reason: 'date_not_closed' }
  | {
      availability: 'historical'
      text: string | null
      kind: TaskDailyContentKind | null
      freshness: 'missing' | 'fresh' | 'stale'
      jobState: TaskDailyJobState
      generation: number | null
      generatedAt: number | null
      error?: string | null
      sourceEntryIds?: string[]
      /** The date is older than the configured backfill window and is not refreshed automatically. */
      outsideBackfill?: boolean
    }

export interface TaskDayCell {
  taskId: string
  date: string
  recordedMs: number
  running: boolean
  summary: TaskDaySummary
}

export interface TaskDaysResponse {
  calendar: WorkCalendar
  asOf: number
  columns: Array<{ date: string; start: number; end: number; isCurrent: boolean }>
  tasks: Array<{ taskId: string; title?: string; status: string; totalRecordedMs: number | null; running: boolean; missing?: boolean }>
  cells: TaskDayCell[]
}

export interface TaskDailyEvidence {
  entryId: string
  type: string
  content: string
  contentHtml: string
  workDate: string
  dateSource: string
  revision: number
  contentHash: string
  createdAt: number
  updatedAt: number
  sourceKind: string
  sourceId: string | null
  interval?: { start: number; end: number }
}

export interface TaskDayDetails extends TaskDayCell {
  calendar: WorkCalendar
  asOf: number
  period: { start: number; end: number }
  evidence: TaskDailyEvidence[]
  nextCursor: string | null
  sessions: Array<{ id: string; taskId: string; startedAt: number; endedAt: number | null; clippedStart: number; clippedEnd: number; durationMs: number }>
  anomalies: Array<{ sessionId: string; reason: string }>
}

export interface TaskDailySummarySettings {
  enabled: boolean
  intervalMinutes: number
  timeZone: string
  maxInputChars: number
  dailyCallBudget: number
  /** Closed workdays, counted back from yesterday, that scheduled checks cover. 0 means unlimited. */
  backfillDays: number
  /** Days to keep call logs that no published summary references. 0 keeps them forever. */
  logRetentionDays: number
  concurrency: 1
}

export interface TaskDailySummarySettingsResponse extends TaskDailySummarySettings {
  taskDailySummaryPrompt: string
  taskDailySummaryMaxTokens: number
  defaultTaskDailySummaryPrompt: string
  calendar: WorkCalendar
  asOf: number
  /** Published summaries inside the backfill window; a prompt change regenerates these. */
  summariesInWindow: number
}
