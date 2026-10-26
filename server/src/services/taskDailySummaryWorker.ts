import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { getLlmSettings, callChatCompletionsWithRaw, insertLlmCallLog } from './llmService'
import type { LlmSettings } from './llmService'
import { getTaskDailySummarySettings, dailyError } from './taskDailySummarySettings'
import { assertClosedWorkDate, getWorkCalendar, workDateRange } from './workCalendarService'
import { buildTaskDaySnapshot, dailyFingerprint, type TaskDaySnapshot } from './taskDailySourceService'
import { claimTaskDailySummaryJob, enqueueTaskDailySummary, publishTaskDailySummary, readTaskDailySummary, reconcileTaskDailySummaries, renewTaskDailySummaryLease, setTaskDailySummaryJobWait, type TaskDailySummaryJob } from './taskDailySummaryService'

interface ModelResult { summaryText: string; sourceEntryIds: string[]; llmCallLogId: string | null }
interface EvidenceFragment { entryId: string; content: string; sourceKind: string; interval?: { start: number; end: number }; fragment?: number }
class DailyBudgetError extends Error {
  readonly code = 'DAILY_BUDGET_EXHAUSTED'
  readonly status = 429
  constructor() { super('Daily summary model call budget exhausted') }
}
class DailyLeaseError extends Error { constructor() { super('Daily summary worker lease is no longer current') } }
class DailyOutputError extends Error { readonly code = 'DAILY_OUTPUT_INVALID' }

type FailureKind = 'abort' | 'transient' | 'permanent' | 'output'
/**
 * abort: the caller stopped the request; transient: the provider or network is unavailable and a later try can succeed;
 * permanent: retrying the same request cannot help; output: the model replied but unusably (or the cause is unknown).
 */
export function classifyDailyFailure(error: any, signal?: AbortSignal): FailureKind {
  if (signal?.aborted || error?.code === 'LLM_ABORTED') return 'abort'
  if (error instanceof DailyOutputError || error?.name === 'LlmProviderResponseError') return 'output'
  if (error?.name === 'LlmOutputTruncatedError' || error?.finishReason === 'length') return 'permanent'
  if (error?.code === 'INPUT_BUDGET_TOO_SMALL' || error?.code === 'INVALID_REQUEST') return 'permanent'
  if (Number.isInteger(error?.status)) return [408, 409, 425, 429].includes(error.status) || error.status >= 500 ? 'transient' : 'permanent'
  if (error?.code === 'LLM_TIMEOUT' || (error?.name === 'TypeError' && /fetch failed/i.test(String(error?.message)))) return 'transient'
  return 'output'
}

// A provider outage should pause every job, not make each one fail separately.
const PROVIDER_BACKOFF_MS = [10_000, 30_000, 60_000, 300_000]
const providerBackoff = { until: 0, streak: 0 }
export function resetTaskDailySummaryProviderBackoff() { providerBackoff.until = 0; providerBackoff.streak = 0 }
function noteProviderFailure(now: number, retryAfterMs: number): number {
  providerBackoff.streak++
  providerBackoff.until = now + Math.max(retryAfterMs, PROVIDER_BACKOFF_MS[Math.min(providerBackoff.streak, PROVIDER_BACKOFF_MS.length) - 1])
  return providerBackoff.until
}
class DailySourceChangedError extends Error { constructor() { super('Daily summary evidence changed during generation') } }

interface BudgetReservation { policyId: string; workDate: string }
function reserveModelCall(now: number): BudgetReservation {
  const calendar = getWorkCalendar(now)
  const settings = getTaskDailySummarySettings()
  const db = getDb()
  const reserved = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO task_daily_summary_budget(calendar_policy_id,work_date,calls) VALUES(?,?,0)').run(calendar.policyId, calendar.currentWorkDate)
    return db.prepare('UPDATE task_daily_summary_budget SET calls=calls+1 WHERE calendar_policy_id=? AND work_date=? AND calls<?').run(calendar.policyId, calendar.currentWorkDate, settings.dailyCallBudget).changes
  })()
  if (!reserved) throw new DailyBudgetError()
  return { policyId: calendar.policyId, workDate: calendar.currentWorkDate }
}

/** A request the provider never processed (aborted, unreachable, rejected) must not use the day's budget. */
function releaseModelCall(reservation: BudgetReservation): void {
  try {
    getDb().prepare('UPDATE task_daily_summary_budget SET calls=MAX(0,calls-1) WHERE calendar_policy_id=? AND work_date=?').run(reservation.policyId, reservation.workDate)
  } catch { /* The database may have been replaced; its budget is a different ledger. */ }
}

export function validateTaskDailySummaryOutput(raw: string, allowedEntryIds: Set<string>): Omit<ModelResult, 'llmCallLogId'> {
  let result: any
  try { result = JSON.parse(raw.trim()) } catch { throw new DailyOutputError('Daily summary must be valid JSON') }
  if (!result || Array.isArray(result) || typeof result.summaryText !== 'string' || !result.summaryText.trim() || result.summaryText.length > 1200) throw new DailyOutputError('Daily summary text must contain 1–1200 characters')
  if (/<\/?[a-z][^>]*>|```/i.test(result.summaryText)) throw new DailyOutputError('Daily summary must be plain text')
  if (!Array.isArray(result.sourceEntryIds) || !result.sourceEntryIds.length || result.sourceEntryIds.length > 32 || result.sourceEntryIds.some((id: unknown) => typeof id !== 'string' || !allowedEntryIds.has(id))) throw new DailyOutputError('Daily summary must cite supplied entry IDs')
  return { summaryText: result.summaryText.trim(), sourceEntryIds: [...new Set<string>(result.sourceEntryIds)] }
}

async function modelCall(snapshot: TaskDaySnapshot, input: unknown, allowedEntryIds: Set<string>, options: { prompt: string; maxTokens: number; provider: LlmSettings; renew?: () => boolean; signal?: AbortSignal; mode: 'record' | 'test' }): Promise<ModelResult> {
  const database = getDb()
  if (options.renew && !options.renew()) throw new DailyLeaseError()
  const settings = options.provider
  const chunkHash = dailyFingerprint({ version: 1, input, prompt: options.prompt, model: settings.model, baseUrl: settings.baseUrl, maxTokens: options.maxTokens })
  const checkpointKey = [snapshot.taskId, snapshot.date, snapshot.policy.policyId, snapshot.fingerprint, chunkHash]
  if (options.mode === 'record') {
    const cached = database.prepare('SELECT summary_text,source_entry_ids_json,llm_call_log_id FROM task_daily_summary_chunks WHERE task_id=? AND work_date=? AND calendar_policy_id=? AND input_fingerprint=? AND chunk_hash=?')
      .get(...checkpointKey) as { summary_text: string; source_entry_ids_json: string; llm_call_log_id: string | null } | undefined
    if (cached) {
      // Checkpoint data is validated again before it becomes synthesis input.
      const parsed = validateTaskDailySummaryOutput(JSON.stringify({ summaryText: cached.summary_text, sourceEntryIds: JSON.parse(cached.source_entry_ids_json) }), allowedEntryIds)
      return { ...parsed, llmCallLogId: cached.llm_call_log_id }
    }
  }
  const reservation = reserveModelCall(Date.now())
  const id = randomUUID(), started = Date.now()
  const messages = [{ role: 'system', content: options.prompt }, { role: 'user', content: JSON.stringify(input) }]
  let rawProviderResponse: string | null = null, rawResponse: string | null = null, finishReason: string | null = null
  let parsedOutput: unknown = null, errorMessage: string | null = null, status = 'success'
  try {
    const response = await callChatCompletionsWithRaw(settings, messages, options.maxTokens, { jsonResponse: true, signal: options.signal })
    rawProviderResponse = response.providerResponse; rawResponse = response.content; finishReason = response.finishReason
    if (finishReason === 'length') throw new Error('Daily summary output was truncated; increase its token limit')
    const parsed = validateTaskDailySummaryOutput(response.content, allowedEntryIds)
    parsedOutput = parsed
    if (options.mode === 'record') {
      if (!sameDatabase(database) || options.renew && !options.renew()) throw new DailyLeaseError()
      const currentCalendar = getWorkCalendar()
      if (currentCalendar.policyId !== snapshot.policy.policyId || buildTaskDaySnapshot(snapshot.taskId, snapshot.date, currentCalendar).fingerprint !== snapshot.fingerprint) throw new DailySourceChangedError()
      database.prepare(`INSERT OR IGNORE INTO task_daily_summary_chunks(task_id,work_date,calendar_policy_id,input_fingerprint,chunk_hash,stage,summary_text,source_entry_ids_json,llm_call_log_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...checkpointKey, (input as { stage?: string })?.stage ?? 'summary', parsed.summaryText, JSON.stringify(parsed.sourceEntryIds), id, Date.now())
    }
    return { ...parsed, llmCallLogId: id }
  } catch (error: any) {
    rawProviderResponse ||= error?.providerResponse ?? null
    rawResponse ||= error?.content ?? null
    finishReason ||= error?.finishReason ?? null
    errorMessage = error?.message ?? 'Daily summary model call failed'
    const kind = classifyDailyFailure(error, options.signal)
    status = kind === 'abort' ? 'aborted' : finishReason === 'length' ? 'truncated' : rawResponse ? 'parse_error' : 'error'
    if (kind === 'abort' || kind === 'transient' || (kind === 'permanent' && Number.isInteger(error?.status))) releaseModelCall(reservation)
    throw error
  } finally {
    if (sameDatabase(database)) insertLlmCallLog({ id, feature: 'task_daily_summary', promptVersion: snapshot.prompt.version, model: settings.model, baseUrl: settings.baseUrl,
      requestInput: { taskId: snapshot.taskId, date: snapshot.date, calendarPolicyId: snapshot.policy.policyId, fingerprint: snapshot.fingerprint, mode: options.mode, stage: (input as { stage?: string })?.stage ?? 'summary' },
      requestMessages: messages, rawProviderResponse, rawResponse, finishReason, parsedOutput, status, errorMessage, latencyMs: Date.now() - started })
  }
}

function groupByInputSize<T>(items: T[], limit: number): T[][] {
  const groups: T[][] = []
  let group: T[] = [], size = 2
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1
    if (itemSize > limit) throw new Error('Daily summary input limit is too small for a source fragment')
    if (group.length && size + itemSize > limit) { groups.push(group); group = []; size = 2 }
    group.push(item); size += itemSize
  }
  if (group.length) groups.push(group)
  return groups
}

/** All formal entries are covered; long entries are split with their original IDs. */
async function generateModelSummary(snapshot: TaskDaySnapshot, options: { prompt?: string; maxTokens?: number; renew?: () => boolean; signal?: AbortSignal; mode?: 'record' | 'test' } = {}): Promise<ModelResult> {
  const settings = getLlmSettings()
  if (!settings.baseUrl.trim() || !settings.model.trim()) throw dailyError('LLM is not configured', 'LLM_NOT_CONFIGURED', 503)
  const prompt = options.prompt ?? snapshot.prompt.text
  const maxTokens = options.maxTokens ?? settings.taskDailySummaryMaxTokens
  if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 32000) throw dailyError('maxTokens must be between 16 and 32000')
  const context = { taskId: snapshot.taskId, workDate: snapshot.date, timeZone: snapshot.policy.timeZone, period: snapshot.period,
    instruction: 'Evidence belongs to this closed workday. An interval spanning dates describes the entire meeting; do not invent a per-day subdivision.' }
  const inputBudget = getTaskDailySummarySettings().maxInputChars - prompt.length - JSON.stringify(context).length - 200
  if (inputBudget < 1000) throw dailyError('Input limit is too small for the configured prompt', 'INPUT_BUDGET_TOO_SMALL')
  const fragments: EvidenceFragment[] = []
  for (const entry of snapshot.evidence) {
    const base = { entryId: entry.entryId, sourceKind: entry.sourceKind, ...(entry.interval ? { interval: entry.interval } : {}) }
    // JSON escaping can expand a character by six bytes; pack by actual serialized
    // size and split adaptively instead of truncating the remaining evidence.
    const text = entry.content || '[This formal record contains no extractable text.]'
    let offset = 0, part = 0
    while (offset < text.length) {
      let length = Math.min(text.length - offset, Math.max(1, Math.floor(inputBudget / 2)))
      let fragment: EvidenceFragment
      while (true) {
        fragment = { ...base, fragment: part, content: text.slice(offset, offset + length) }
        if (JSON.stringify(fragment).length + 4 <= inputBudget) break
        length = Math.floor(length / 2)
        if (length < 1) throw dailyError('Input limit is too small for a source', 'INPUT_BUDGET_TOO_SMALL')
      }
      fragments.push(fragment!)
      offset += length; part++
    }
  }
  const groups = groupByInputSize(fragments, inputBudget)
  const callOptions = { prompt, maxTokens, provider: settings, renew: options.renew, signal: options.signal, mode: options.mode ?? 'record' as const }
  let partials: ModelResult[] = []
  for (const group of groups) {
    partials.push(await modelCall(snapshot, { ...context, stage: groups.length === 1 ? 'summary' : 'source_chunk', evidence: group }, new Set(group.map(item => item.entryId)), callOptions))
  }
  while (partials.length > 1) {
    const reducedGroups = groupByInputSize(partials.map(({ summaryText, sourceEntryIds }) => ({ summaryText, sourceEntryIds })), inputBudget)
    if (reducedGroups.length >= partials.length) throw dailyError('Input limit is too small to combine the source summaries; increase it', 'INPUT_BUDGET_TOO_SMALL')
    const next: ModelResult[] = []
    for (const group of reducedGroups) {
      next.push(await modelCall(snapshot, { ...context, stage: 'synthesis', chunkSummaries: group }, new Set(group.flatMap(item => item.sourceEntryIds)), callOptions))
    }
    partials = next
  }
  if (!partials[0]) throw new Error('No source evidence to summarize')
  return partials[0]
}

export async function testTaskDailySummary(taskId: string, date: string, options: { prompt?: string; maxTokens?: number } = {}) {
  const database = getDb()
  const now = Date.now(), calendar = getWorkCalendar(now)
  assertClosedWorkDate(date, calendar, now)
  const snapshot = buildTaskDaySnapshot(taskId, date, calendar, now)
  if (!snapshot.evidence.length) return { summaryText: snapshot.hasRecordedWork ? '已记录工时，未记录工作内容' : '', sourceEntryIds: [], llmCallLogId: null, cached: false }
  if (options.prompt !== undefined) snapshot.prompt = { text: options.prompt, version: `task_daily_summary_test_${dailyFingerprint(options.prompt).slice(0, 16)}` }
  return { ...await generateModelSummary(snapshot, { ...options, mode: 'test', renew: () => sameDatabase(database) }), cached: false }
}

function sameDatabase(database: ReturnType<typeof getDb>) {
  try { return getDb() === database && database.open } catch { return false }
}

export async function processNextTaskDailySummaryJob(options: { now?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  const database = getDb()
  const now = options.now ?? Date.now(), policy = getWorkCalendar(now)
  const provider = getLlmSettings()
  const leaseMs = Math.max(120000, provider.timeoutMs + 60000)
  const job = claimTaskDailySummaryJob(policy, now, leaseMs)
  if (!job) return false
  try {
    assertClosedWorkDate(job.work_date, policy, now)
    const snapshot = buildTaskDaySnapshot(job.task_id, job.work_date, policy, now)
    if (snapshot.fingerprint !== job.requested_fingerprint || readTaskDailySummary(job.task_id, job.work_date, policy.policyId)?.input_fingerprint === snapshot.fingerprint) {
      enqueueTaskDailySummary(snapshot)
      return true
    }
    if (!snapshot.evidence.length) {
      publishTaskDailySummary(job, snapshot, { text: snapshot.hasRecordedWork ? '已记录工时，未记录工作内容' : '', kind: snapshot.hasRecordedWork ? 'time_only' : 'empty', sourceEntryIds: [], model: null, llmCallLogId: null })
      return true
    }
    if (!provider.baseUrl.trim() || !provider.model.trim()) {
      setTaskDailySummaryJobWait(job, 'waiting_config', 'LLM is not configured', Date.now() + 60000)
      return true
    }
    if (now < providerBackoff.until) {
      setTaskDailySummaryJobWait(job, 'queued', 'Waiting for the model provider to recover', providerBackoff.until, Date.now(), true)
      return true
    }
    const result = await generateModelSummary(snapshot, { renew: () => sameDatabase(database) && renewTaskDailySummaryLease(job, Date.now(), leaseMs), signal: options.signal })
    providerBackoff.until = 0; providerBackoff.streak = 0
    if (sameDatabase(database)) publishTaskDailySummary(job, snapshot, { text: result.summaryText, kind: 'llm', sourceEntryIds: result.sourceEntryIds, model: provider.model, llmCallLogId: result.llmCallLogId })
  } catch (error: any) {
    if (!sameDatabase(database)) return true
    if (error instanceof DailyLeaseError) return true
    if (error instanceof DailySourceChangedError) {
      const current = getWorkCalendar()
      if (current.policyId === policy.policyId) enqueueTaskDailySummary(buildTaskDaySnapshot(job.task_id, job.work_date, current))
      else setTaskDailySummaryJobWait(job, 'failed', error.message, Date.now())
    } else if (error instanceof DailyBudgetError) {
      const current = getWorkCalendar()
      setTaskDailySummaryJobWait(job, 'waiting_budget', error.message, workDateRange(current.currentWorkDate, current).end)
    } else if (error?.code === 'DATE_NOT_CLOSED' || error?.code === 'TASK_NOT_FOUND') {
      setTaskDailySummaryJobWait(job, 'failed', error.message, Date.now())
    } else if (error?.code === 'LLM_NOT_CONFIGURED') {
      setTaskDailySummaryJobWait(job, 'waiting_config', error.message, Date.now() + 60000)
    } else {
      const kind = classifyDailyFailure(error, options.signal), message = error?.message ?? 'Daily summary failed', failedAt = Date.now()
      if (kind === 'abort') {
        // Shutdown or a database replacement interrupted the call; the job is untouched and due immediately.
        setTaskDailySummaryJobWait(job, 'queued', 'Interrupted before completion', failedAt, failedAt, true)
      } else if (kind === 'transient') {
        const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0
        setTaskDailySummaryJobWait(job, 'queued', message, noteProviderFailure(failedAt, retryAfterMs), failedAt, true)
      } else {
        // Retrying a deterministic failure cannot help: fail at once. An unusable reply gets one more try.
        const failed = kind === 'permanent' || job.attempts >= 2
        setTaskDailySummaryJobWait(job, failed ? 'failed' : 'queued', message, failedAt + 60000, failedAt)
      }
    }
  }
  return true
}

let scheduler: { timer: ReturnType<typeof setInterval>; controller: AbortController; stopped: boolean; nextReconcileAt: number; intervalMinutes: number; running: Promise<void> | null } | null = null

export function isTaskDailySummarySchedulerRunning(): boolean { return scheduler !== null }

/** Startup only registers a clock. Reconciliation starts after the configured interval. */
export function startTaskDailySummaryScheduler(): void {
  if (scheduler) return
  resetTaskDailySummaryProviderBackoff()
  const settings = getTaskDailySummarySettings()
  const state = { timer: null as unknown as ReturnType<typeof setInterval>, controller: new AbortController(), stopped: false,
    nextReconcileAt: Date.now() + settings.intervalMinutes * 60000, intervalMinutes: settings.intervalMinutes, running: null as Promise<void> | null }
  const tick = async () => {
    const config = getTaskDailySummarySettings()
    if (config.intervalMinutes !== state.intervalMinutes) {
      state.intervalMinutes = config.intervalMinutes
      state.nextReconcileAt = Date.now() + config.intervalMinutes * 60000
    }
    if (!config.enabled || state.stopped) return
    if (Date.now() >= state.nextReconcileAt) {
      state.nextReconcileAt = Date.now() + config.intervalMinutes * 60000
      await reconcileTaskDailySummaries({ shouldStop: () => state.stopped })
    }
    // Recover due persisted work on periodic worker ticks, including expired leases.
    // Bound each tick so settings changes and shutdown are observed between jobs.
    for (let count = 0; count < 20 && !state.stopped && getTaskDailySummarySettings().enabled; count++) {
      if (!await processNextTaskDailySummaryJob({ signal: state.controller.signal })) break
    }
  }
  state.timer = setInterval(() => {
    if (state.running || state.stopped) return
    state.running = tick().catch(error => {
      // Log an operational error; an individual model failure is already persisted.
      console.error('[task_daily_summary] scheduler:', error?.message ?? error)
    }).finally(() => { state.running = null })
  }, 60000)
  state.timer.unref?.()
  scheduler = state
}

export async function stopTaskDailySummaryScheduler(): Promise<void> {
  const current = scheduler
  if (!current) return
  current.stopped = true
  clearInterval(current.timer)
  current.controller.abort()
  await current.running
  if (scheduler === current) scheduler = null
}
