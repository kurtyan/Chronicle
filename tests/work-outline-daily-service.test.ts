import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { initDb, closeDb, getDb, setMetaValue } from '../server/src/db'
import { createTask, createTaskEntry, updateTaskEntry, deleteTaskEntry, deleteTask, updateTask } from '../server/src/services/taskService'
import { createMeeting } from '../server/src/services/meetingService'
import { getWorkCalendar, workDateRange, workDateAt, addWorkDateDays, workDateStart } from '../server/src/services/workCalendarService'
import { getTaskDailySummarySettings, saveTaskDailySummarySettings } from '../server/src/services/taskDailySummarySettings'
import { buildTaskDaySnapshot, setTaskEntryWorkDate } from '../server/src/services/taskDailySourceService'
import { claimTaskDailySummaryJob, enqueueTaskDailySummary, pruneTaskDailySummaryLogs, publishTaskDailySummary, readTaskDailyJob, readTaskDailySummary, reconcileTaskDailySummaries } from '../server/src/services/taskDailySummaryService'
import { isTaskDailySummarySchedulerRunning, processNextTaskDailySummaryJob, resetTaskDailySummaryProviderBackoff, startTaskDailySummaryScheduler, stopTaskDailySummaryScheduler } from '../server/src/services/taskDailySummaryWorker'
import { getTaskDayDetails, queryTaskDays } from '../server/src/services/taskDayQueryService'
import { taskDailySummaryRoutes } from '../server/src/taskDailySummaryRoutes'

let directory: string
const originalFetch = globalThis.fetch
let calls: any[]
let previousEnvironment: Record<string, string | undefined>

test.beforeEach(() => {
  const root = path.resolve('.dev-data'); fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'outline-daily-'))
  previousEnvironment = {}
  const env = { CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'), CHRONICLE_CONFIG_DIR: directory, CHRONICLE_CONFIG_PATH: path.join(directory, 'config.json'),
    CHRONICLE_LOG_DIR: directory, CHRONICLE_LOG_PATH: path.join(directory, 'test.log'), CHRONICLE_LLM_BASE_URL: 'https://example.invalid/v1', CHRONICLE_LLM_MODEL: 'daily-test-model', CHRONICLE_LLM_API_KEY: '', CHRONICLE_LLM_TIMEOUT_MS: '1000' }
  for (const [key, value] of Object.entries(env)) { previousEnvironment[key] = process.env[key]; process.env[key] = value }
  initDb()
  resetTaskDailySummaryProviderBackoff()
  calls = []
  globalThis.fetch = (async (_url, init) => reply(String(init?.body))) as typeof fetch
})

test.afterEach(async () => {
  await stopTaskDailySummaryScheduler()
  mock.timers.reset()
  globalThis.fetch = originalFetch
  closeDb()
  for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  fs.rmSync(directory, { recursive: true, force: true })
})

function reply(body: string, text = '已验证记录中的方案，并保留待处理问题。') {
  const request = JSON.parse(body); calls.push(request)
  const input = JSON.parse(request.messages[1].content)
  const sourceEntryIds = input.evidence ? [...new Set(input.evidence.map((entry: any) => entry.entryId))].slice(0, 4) : [...new Set(input.chunkSummaries.flatMap((item: any) => item.sourceEntryIds))].slice(0, 4)
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summaryText: text, sourceEntryIds }) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function task(name = 'Independent daily work') { return createTask({ title: name, type: 'TODO', priority: 'MEDIUM' }) }
function day(offset = -1) { return addWorkDateDays(getWorkCalendar().currentWorkDate, offset) }
function entry(taskId: string, date: string, content = '<p>验证配置，发现一个待处理的兼容问题。</p>') {
  const value = createTaskEntry(taskId, content, 'log')
  setTaskEntryWorkDate(taskId, value.id, date)
  return value
}
function session(taskId: string, start: number, end: number | null) {
  const id = randomUUID()
  getDb().prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(id, taskId, start, end)
  return id
}
async function drain(limit = 100) {
  for (let index = 0; index < limit; index++) if (!await processNextTaskDailySummaryJob()) return
  throw new Error('Daily queue did not drain')
}
function stored(taskId: string, date: string) { return readTaskDailySummary(taskId, date, getWorkCalendar().policyId) }

test('calendar uses Focus offset and explicit timezone, including DST gaps and folds', () => {
  const calendar = getWorkCalendar()
  const range = workDateRange('2026-10-14', calendar)
  expect(new Date(range.start).toISOString()).toBe('2026-10-13T21:00:00.000Z')
  expect(workDateAt(range.end - 1, calendar)).toBe('2026-10-14')
  expect(workDateAt(range.end, calendar)).toBe('2026-10-15')
  setMetaValue('start_of_day_offset', '0')
  saveTaskDailySummarySettings({ timeZone: 'America/New_York' })
  const dst = getWorkCalendar()
  expect(dst.policyId).not.toBe(calendar.policyId)
  const spring = workDateRange('2026-03-08', dst), fall = workDateRange('2026-11-01', dst)
  expect(spring.end - spring.start).toBe(23 * 3600000)
  expect(fall.end - fall.start).toBe(25 * 3600000)
  expect(new Date(workDateStart('2026-03-08', { ...dst, startOfDayHour: 2 })).toISOString()).toBe('2026-03-08T07:00:00.000Z')
  expect(new Date(workDateStart('2026-11-01', { ...dst, startOfDayHour: 1 })).toISOString()).toBe('2026-11-01T05:00:00.000Z')
})

test('all historical candidates are summarized independently of outlines; unchanged sources and duration-only edits skip the model', async () => {
  saveTaskDailySummarySettings({ backfillDays: 0 }) // this test is about unbounded history; the default window is 60 days
  const value = task(), date = day(-90), range = workDateRange(date, getWorkCalendar())
  entry(value.id, date)
  const recorded = session(value.id, range.start + 1000, range.start + 61000)
  createTaskEntry(value.id, '<p>Current mutable description is not historical evidence.</p>', 'body')
  createTaskEntry(value.id, '<p>Today is not yesterday.</p>', 'log')
  expect(await reconcileTaskDailySummaries({ pageSize: 1 })).toMatchObject({ candidates: 1, queued: 1 })
  await drain()
  expect(stored(value.id, date)).toMatchObject({ content_kind: 'llm', generation: 1 })
  expect(calls).toHaveLength(1)
  expect(calls[0].messages[1].content).not.toContain('Current mutable')
  expect(calls[0].messages[1].content).not.toContain('Today is')
  updateTask(value.id, { title: 'Renamed and completed today', status: 'DONE' })
  getDb().prepare('UPDATE work_sessions SET ended_at=ended_at+60000 WHERE id=?').run(recorded)
  expect(await reconcileTaskDailySummaries()).toMatchObject({ queued: 0 })
  await drain()
  expect(calls).toHaveLength(1)
  expect(queryTaskDays({ taskIds: [value.id, value.id], fromDate: date, toDate: date }).cells[0]).toMatchObject({ recordedMs: 120000, summary: { freshness: 'fresh' } })
})

test('old log edits, explicit date moves and deletion of every source refresh both previous and new date keys', async () => {
  const value = task(), previous = day(-45), next = day(-44)
  const log = entry(value.id, previous)
  await reconcileTaskDailySummaries(); await drain()
  updateTaskEntry(value.id, log.id, '<p>纠正：方案尚未通过验证。</p>')
  await reconcileTaskDailySummaries(); await drain()
  expect(stored(value.id, previous)?.generation).toBe(2)
  setTaskEntryWorkDate(value.id, log.id, next)
  await reconcileTaskDailySummaries(); await drain()
  expect(stored(value.id, previous)).toMatchObject({ content_kind: 'empty', summary_text: '', generation: 3 })
  expect(stored(value.id, next)?.content_kind).toBe('llm')
  deleteTaskEntry(value.id, log.id)
  expect(await reconcileTaskDailySummaries()).toMatchObject({ candidates: 2, queued: 1 })
  await drain()
  expect(stored(value.id, next)).toMatchObject({ content_kind: 'empty', generation: 2 })
  expect(calls).toHaveLength(3)
})

test('time-only dates and removal of the last work session use deterministic results without a model', async () => {
  const value = task(), date = day(-1), range = workDateRange(date, getWorkCalendar())
  const id = session(value.id, range.end - 60000, range.end + 60000)
  await reconcileTaskDailySummaries(); await drain()
  expect(stored(value.id, date)).toMatchObject({ content_kind: 'time_only', summary_text: '已记录工时，未记录工作内容' })
  const query = queryTaskDays({ taskIds: [value.id], fromDate: date, toDate: day(0) })
  expect(query.cells.map(cell => cell.recordedMs)).toEqual([60000, 60000])
  expect(query.tasks[0].totalRecordedMs).toBe(120000)
  getDb().prepare('DELETE FROM work_sessions WHERE id=?').run(id)
  await reconcileTaskDailySummaries(); await drain()
  expect(stored(value.id, date)).toMatchObject({ content_kind: 'empty', summary_text: '', generation: 2 })
  expect(calls).toHaveLength(0)
})

test('current and future dates expose only time, even with an injected old summary; generation endpoints reject them', async () => {
  const value = task(), calendar = getWorkCalendar(), date = calendar.currentWorkDate, period = workDateRange(date, calendar)
  entry(value.id, date, 'Today private evidence')
  session(value.id, Math.max(period.start, Date.now() - 60000), null)
  getDb().prepare(`INSERT INTO task_daily_summaries(id,task_id,work_date,calendar_policy_id,period_start,period_end,summary_text,content_kind,input_fingerprint,evidence_json,prompt_version,generated_at)
    VALUES(?,?,?,?,?,?,'MUST NOT DISPLAY','llm','old','[]','old',?)`).run(randomUUID(), value.id, date, calendar.policyId, period.start, period.end, Date.now())
  const response = queryTaskDays({ taskIds: [value.id], fromDate: date, toDate: day(1) })
  expect(response.cells.every(cell => cell.summary.availability === 'not_applicable')).toBeTruthy()
  expect(JSON.stringify(response)).not.toContain('MUST NOT DISPLAY')
  const details = getTaskDayDetails(value.id, date)
  expect(details.evidence).toEqual([])
  expect(details.running).toBeTruthy()
  for (const suffix of ['summary-refresh', 'summary-test']) {
    const result = await taskDailySummaryRoutes.request(`/tasks/${value.id}/days/${date}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(result.status).toBe(422)
    expect(await result.json()).toMatchObject({ code: 'DATE_NOT_CLOSED' })
  }
  expect(calls).toHaveLength(0)
})

test('Focus source mappings preserve original work dates across append and replace; meeting records use their explicit interval', () => {
  const value = task(), date = day(-10), now = Date.now()
  getDb().prepare('INSERT INTO day_scripts(script_date,document_json,created_at,updated_at) VALUES(?,?,?,?)').run(date, '{}', now, now)
  getDb().prepare(`INSERT INTO day_script_blocks(id,script_date,sort_order,start_time,end_time,header_text,created_at,updated_at) VALUES('block',?,0,'10:00','11:00','Work',?,?)`).run(date, now, now)
  const first = createTaskEntry(value.id, 'First submitted work')
  getDb().prepare('INSERT INTO day_script_progress_syncs(block_id,task_id,synced_progress,last_entry_id,updated_at) VALUES(?,?,?,?,?)').run('block', value.id, 'first', first.id, now)
  const second = createTaskEntry(value.id, 'Second submitted work')
  getDb().prepare('UPDATE day_script_progress_syncs SET last_entry_id=? WHERE block_id=? AND task_id=?').run(second.id, 'block', value.id)
  updateTaskEntry(value.id, second.id, 'Replaced work')
  const evidence = buildTaskDaySnapshot(value.id, date).evidence
  expect(evidence.map(item => item.entryId).sort()).toEqual([first.id, second.id].sort())
  expect(evidence.every(item => item.sourceKind === 'focus' && item.dateSource === 'focus')).toBeTruthy()
  expect(evidence.find(item => item.entryId === second.id)!.revision).toBeGreaterThan(1)
  expect(evidence.find(item => item.entryId === second.id)!.createdAt).toBe(second.createdAt)
  const period = workDateRange(date, getWorkCalendar())
  const meeting = createMeeting({ title: 'Historical meeting', startedAt: period.start + 3600000, endedAt: period.start + 7200000, content: '<p>明确了接口约定。</p>', participants: [], tags: [], rawContent: 'Meeting notes' })
  expect(buildTaskDaySnapshot(meeting.id, date).evidence[0]).toMatchObject({ type: 'body', sourceKind: 'meeting', interval: { start: period.start + 3600000, end: period.start + 7200000 } })
  expect(buildTaskDaySnapshot(meeting.id, day(0)).evidence).toEqual([])
})

test('worker rejects a slow result after source mutation and generates the new snapshot', async () => {
  const value = task(), date = day(-1), log = entry(value.id, date)
  await reconcileTaskDailySummaries()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), beginning = new Promise<void>(resolve => { started = resolve })
  globalThis.fetch = (async (_url, init) => { started(); await gate; return reply(String(init?.body), '旧版本结果。') }) as typeof fetch
  const running = processNextTaskDailySummaryJob()
  await beginning
  updateTaskEntry(value.id, log.id, 'The evidence changed during generation')
  release(); await running
  expect(stored(value.id, date)).toBeUndefined()
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)?.state).toBe('queued')
  globalThis.fetch = (async (_url, init) => reply(String(init?.body), '新版本结果。')) as typeof fetch
  await drain()
  expect(stored(value.id, date)).toMatchObject({ generation: 1, summary_text: '新版本结果。' })
})

test('expired durable leases are reclaimable and an obsolete lease cannot publish or overwrite', async () => {
  const value = task(), date = day(-1), snapshot = buildTaskDaySnapshot(value.id, date)
  enqueueTaskDailySummary(snapshot)
  const original = claimTaskDailySummaryJob(getWorkCalendar())!
  getDb().prepare('UPDATE task_daily_summary_jobs SET lease_expires_at=0 WHERE id=?').run(original.id)
  closeDb(); initDb()
  const replacement = claimTaskDailySummaryJob(getWorkCalendar())!
  expect(replacement.id).toBe(original.id)
  expect(replacement.lease_token).not.toBe(original.lease_token)
  const result = { text: '', kind: 'empty' as const, sourceEntryIds: [], model: null, llmCallLogId: null }
  expect(publishTaskDailySummary(original, snapshot, result)).toBeFalsy()
  expect(publishTaskDailySummary(replacement, snapshot, result)).toBeTruthy()
  expect(stored(value.id, date)?.generation).toBe(1)
})

function budgetCalls() { return (getDb().prepare('SELECT COALESCE(SUM(calls),0) AS n FROM task_daily_summary_budget').get() as { n: number }).n }

test('a provider outage pauses jobs without failing them or spending budget, and honors Retry-After', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  let requests = 0
  globalThis.fetch = (async () => { requests++; return new Response('provider busy', { status: 429, headers: { 'Retry-After': '600' } }) }) as typeof fetch
  const start = Date.now()
  await processNextTaskDailySummaryJob()
  let job = readTaskDailyJob(value.id, date, getWorkCalendar().policyId)!
  expect(job).toMatchObject({ state: 'queued', attempts: 0 })
  expect(job.next_attempt_at).toBeGreaterThanOrEqual(start + 600000)
  expect(budgetCalls()).toBe(0)
  // The circuit is open: a job that is otherwise due does not reach the provider again.
  getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0 WHERE id=?').run(job.id)
  await processNextTaskDailySummaryJob()
  expect(requests).toBe(1)
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'queued', attempts: 0 })
  // An outage never exhausts attempts, however long it lasts; the next healthy call publishes.
  for (let index = 0; index < 6; index++) {
    resetTaskDailySummaryProviderBackoff()
    getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0 WHERE id=?').run(job.id)
    await processNextTaskDailySummaryJob()
  }
  expect(requests).toBe(7)
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'queued', attempts: 0 })
  resetTaskDailySummaryProviderBackoff()
  globalThis.fetch = (async (_url, init) => reply(String(init?.body))) as typeof fetch
  getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0 WHERE id=?').run(job.id)
  await drain()
  expect(stored(value.id, date)).toMatchObject({ content_kind: 'llm', generation: 1 })
  expect(budgetCalls()).toBe(1)
})

test('consecutive provider failures back off 10s, 30s, 60s, then 5 minutes and recover on success', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch
  const delays: number[] = []
  for (let index = 0; index < 6; index++) {
    getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0').run()
    // The worker clock is moved past the open circuit; the failure itself is timed with the real clock.
    await processNextTaskDailySummaryJob({ now: Date.now() + 3_600_000 })
    delays.push(Math.round((readTaskDailyJob(value.id, date, getWorkCalendar().policyId)!.next_attempt_at - Date.now()) / 1000))
  }
  expect(delays).toHaveLength(6)
  for (const [index, expected] of [10, 30, 60, 300, 300, 300].entries()) expect(Math.abs(delays[index] - expected), `attempt ${index + 1}: ${delays[index]}s`).toBeLessThanOrEqual(2)
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'queued', attempts: 0 })
  globalThis.fetch = (async (_url, init) => reply(String(init?.body))) as typeof fetch
  getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0').run()
  await processNextTaskDailySummaryJob({ now: Date.now() + 3_600_000 })
  expect(stored(value.id, date)?.content_kind).toBe('llm')
  // Success closes the circuit: the next failure starts again at 10 seconds.
  const other = task('After recovery'), otherDate = day(-2)
  entry(other.id, otherDate); await reconcileTaskDailySummaries()
  globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch
  await processNextTaskDailySummaryJob({ now: Date.now() + 3_600_000 })
  const wait = (readTaskDailyJob(other.id, otherDate, getWorkCalendar().policyId)!.next_attempt_at - Date.now()) / 1000
  expect(Math.abs(wait - 10)).toBeLessThanOrEqual(2)
})

test('permanent provider errors fail at once and stay failed until a source change or explicit retry', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  globalThis.fetch = (async () => new Response('invalid api key', { status: 401 })) as typeof fetch
  await processNextTaskDailySummaryJob()
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'failed', attempts: 1 })
  expect(budgetCalls()).toBe(0)
  await reconcileTaskDailySummaries()
  expect(await processNextTaskDailySummaryJob()).toBeFalsy()
  const response = await taskDailySummaryRoutes.request(`/tasks/${value.id}/days/${date}/summary-refresh`, { method: 'POST' })
  expect(response.status).toBe(202)
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'queued', attempts: 0 })
})

test('a truncated reply is not retried and keeps its budget charge; an unusable reply gets exactly one more try', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summaryText":"cut' }, finish_reason: 'length' }] }), { status: 200 })) as typeof fetch
  await processNextTaskDailySummaryJob()
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'failed', attempts: 1 })
  expect(budgetCalls()).toBe(1)
  const other = task('Unusable output'), otherDate = day(-2)
  entry(other.id, otherDate); await reconcileTaskDailySummaries()
  let requests = 0
  globalThis.fetch = (async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] }), { status: 200 }) }) as typeof fetch
  await processNextTaskDailySummaryJob()
  const job = readTaskDailyJob(other.id, otherDate, getWorkCalendar().policyId)!
  expect(job).toMatchObject({ state: 'queued', attempts: 1 })
  getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0 WHERE id=?').run(job.id)
  await processNextTaskDailySummaryJob()
  expect(readTaskDailyJob(other.id, otherDate, getWorkCalendar().policyId)).toMatchObject({ state: 'failed', attempts: 2 })
  expect(requests).toBe(2)
})

test('an aborted call is neither a failed attempt nor a spent budget call and is due again at once', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  const controller = new AbortController()
  let started!: () => void
  const beginning = new Promise<void>(resolve => { started = resolve })
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    started()
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
  })) as typeof fetch
  const running = processNextTaskDailySummaryJob({ signal: controller.signal })
  await beginning
  controller.abort()
  await running
  const job = readTaskDailyJob(value.id, date, getWorkCalendar().policyId)!
  expect(job).toMatchObject({ state: 'queued', attempts: 0 })
  expect(job.next_attempt_at).toBeLessThanOrEqual(Date.now())
  expect(job.last_error).toMatch(/Interrupted/)
  expect(budgetCalls()).toBe(0)
  expect(getDb().prepare("SELECT status FROM llm_call_logs WHERE feature='task_daily_summary'").all()).toEqual([{ status: 'aborted' }])
  globalThis.fetch = (async (_url, init) => reply(String(init?.body))) as typeof fetch
  await drain()
  expect(stored(value.id, date)?.content_kind).toBe('llm')
})

test('the backfill window limits scheduled generation but not explicit refresh, and old summaries are never marked stale', async () => {
  saveTaskDailySummarySettings({ backfillDays: 30 })
  const value = task(), recent = day(-5), old = day(-60)
  entry(value.id, recent); entry(value.id, old)
  expect(await reconcileTaskDailySummaries()).toMatchObject({ candidates: 1, queued: 1 })
  await drain()
  expect(stored(value.id, recent)?.content_kind).toBe('llm')
  expect(stored(value.id, old)).toBeUndefined()
  expect(queryTaskDays({ taskIds: [value.id], fromDate: old, toDate: old }).cells[0].summary).toMatchObject({ outsideBackfill: true, freshness: 'missing', jobState: 'idle' })
  expect(queryTaskDays({ taskIds: [value.id], fromDate: recent, toDate: recent }).cells[0].summary).not.toHaveProperty('outsideBackfill')
  const refreshed = await taskDailySummaryRoutes.request(`/tasks/${value.id}/days/${old}/summary-refresh`, { method: 'POST' })
  expect(refreshed.status).toBe(202)
  await drain()
  expect(stored(value.id, old)?.content_kind).toBe('llm')
  // A prompt change regenerates only summaries inside the window.
  const settings = await (await taskDailySummaryRoutes.request('/settings/task-daily-summary')).json()
  expect(settings).toMatchObject({ backfillDays: 30, summariesInWindow: 1 })
  await taskDailySummaryRoutes.request('/settings/task-daily-summary', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskDailySummaryPrompt: 'Return JSON with summaryText and sourceEntryIds, concisely.' }) })
  const before = calls.length
  expect(await reconcileTaskDailySummaries()).toMatchObject({ candidates: 1, queued: 1 })
  await drain()
  expect(calls.length).toBe(before + 1)
  expect(stored(value.id, old)).toMatchObject({ generation: 1 })
  saveTaskDailySummarySettings({ backfillDays: 0 })
  expect(await reconcileTaskDailySummaries()).toMatchObject({ candidates: 2 })
})

test('call logs are pruned after the retention period unless a published summary cites them', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries(); await drain()
  const cited = stored(value.id, date)!.llm_call_log_id!
  const insert = getDb().prepare("INSERT INTO llm_call_logs(id,feature,prompt_version,model,base_url,request_input,request_messages,raw_response,parsed_output,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
  const old = Date.now() - 40 * 86400000
  getDb().prepare('UPDATE llm_call_logs SET created_at=? WHERE id=?').run(old, cited)
  insert.run('stale-task-log', 'task_daily_summary', 'v', 'm', 'u', '{}', '[]', '', 'null', 'error', old)
  insert.run('fresh-task-log', 'task_daily_summary', 'v', 'm', 'u', '{}', '[]', '', 'null', 'error', Date.now())
  insert.run('stale-other-log', 'daily_summary', 'v', 'm', 'u', '{}', '[]', '', 'null', 'success', old)
  expect(pruneTaskDailySummaryLogs()).toBe(1)
  const ids = (getDb().prepare('SELECT id FROM llm_call_logs ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
  expect(ids).toEqual(expect.arrayContaining([cited, 'fresh-task-log', 'stale-other-log']))
  expect(ids).not.toContain('stale-task-log')
  saveTaskDailySummarySettings({ logRetentionDays: 0 })
  insert.run('another-stale-log', 'task_daily_summary', 'v', 'm', 'u', '{}', '[]', '', 'null', 'error', old)
  expect(pruneTaskDailySummaryLogs()).toBe(0)
  const first = JSON.parse((getDb().prepare('SELECT request_input FROM llm_call_logs WHERE id=?').get(cited) as { request_input: string }).request_input)
  expect(first).toMatchObject({ mode: 'record', stage: 'summary' })
  expect(first).not.toHaveProperty('input')
})

test('unconfigured provider and zero daily budget wait durably without publishing empty summaries', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  process.env.CHRONICLE_LLM_MODEL = ''
  await processNextTaskDailySummaryJob()
  let job = readTaskDailyJob(value.id, date, getWorkCalendar().policyId)!
  expect(job).toMatchObject({ state: 'waiting_config', attempts: 0 })
  process.env.CHRONICLE_LLM_MODEL = 'daily-test-model'
  saveTaskDailySummarySettings({ dailyCallBudget: 0 })
  getDb().prepare('UPDATE task_daily_summary_jobs SET next_attempt_at=0 WHERE id=?').run(job.id)
  await processNextTaskDailySummaryJob()
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toMatchObject({ state: 'waiting_budget', attempts: 0 })
  expect(stored(value.id, date)).toBeUndefined()
  expect(calls).toHaveLength(0)
})

test('long evidence is fully chunked with original citations and every model call remains bounded', async () => {
  saveTaskDailySummarySettings({ maxInputChars: 4000 })
  const value = task(), date = day(-1)
  const content = Array.from({ length: 100 }, (_, index) => `fact-${index}: ${'记录中的具体证据'.repeat(12)}`).join(' ')
  const log = entry(value.id, date, content)
  await reconcileTaskDailySummaries(); await drain()
  expect(stored(value.id, date)?.content_kind).toBe('llm')
  expect(calls.length).toBeGreaterThan(2)
  const observed = calls.flatMap(request => JSON.parse(request.messages[1].content).evidence ?? []).map(item => item.content).join('')
  expect(observed).toBe(content)
  expect(calls.every(request => request.messages[0].content.length + request.messages[1].content.length <= 4000)).toBeTruthy()
  expect(JSON.parse(stored(value.id, date)!.source_entry_ids_json)).toEqual([log.id])
})

test('a one-call daily budget resumes durable chunk stages across multiple days and a database reopen', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T02:00:00Z') })
  saveTaskDailySummarySettings({ maxInputChars: 4000, dailyCallBudget: 1 })
  const value = task(), date = day(-1)
  entry(value.id, date, Array.from({ length: 75 }, (_, index) => `evidence-${index} ${'完整保留的输入内容'.repeat(7)}`).join(' '))
  await reconcileTaskDailySummaries()
  let elapsedDays = 0
  for (; elapsedDays < 20; elapsedDays++) {
    await processNextTaskDailySummaryJob()
    if (stored(value.id, date)) break
    expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)?.state).toBe('waiting_budget')
    if (elapsedDays === 0) {
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summary_chunks').get()).toEqual({ n: 1 })
      closeDb(); initDb() // persisted checkpoints and waiting jobs survive process recovery
    }
    mock.timers.tick(24 * 3600000)
  }
  expect(elapsedDays + 1).toBeGreaterThanOrEqual(3)
  expect(elapsedDays).toBeLessThan(20)
  expect(stored(value.id, date)).toMatchObject({ content_kind: 'llm', generation: 1 })
  expect(calls.length).toBe(elapsedDays + 1)
  expect(new Set(calls.map(call => JSON.stringify(call.messages))).size).toBe(calls.length)
  const budget = getDb().prepare('SELECT calls FROM task_daily_summary_budget').all() as Array<{ calls: number }>
  expect(budget.every(row => row.calls === 1)).toBeTruthy()
})

test('changed source fingerprints discard old chunk checkpoints instead of mixing past facts into a resumed summary', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T02:00:00Z') })
  saveTaskDailySummarySettings({ maxInputChars: 4000, dailyCallBudget: 1 })
  const value = task(), date = day(-1), log = entry(value.id, date, 'OLD_EVIDENCE '.repeat(450))
  await reconcileTaskDailySummaries(); await processNextTaskDailySummaryJob()
  const previous = buildTaskDaySnapshot(value.id, date).fingerprint
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summary_chunks').get()).toEqual({ n: 1 })
  updateTaskEntry(value.id, log.id, 'NEW_EVIDENCE '.repeat(450))
  await reconcileTaskDailySummaries()
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summary_chunks WHERE input_fingerprint=?').get(previous)).toEqual({ n: 0 })
  const oldCallCount = calls.length
  for (let index = 0; index < 20 && !stored(value.id, date); index++) {
    mock.timers.tick(24 * 3600000)
    await processNextTaskDailySummaryJob()
  }
  expect(stored(value.id, date)?.content_kind).toBe('llm')
  expect(calls.slice(oldCallCount).every(call => !call.messages[1].content.includes('OLD_EVIDENCE'))).toBeTruthy()
  const fingerprints = getDb().prepare('SELECT DISTINCT input_fingerprint FROM task_daily_summary_chunks').all()
  expect(fingerprints).toEqual([{ input_fingerprint: buildTaskDaySnapshot(value.id, date).fingerprint }])
})

test('query batches, default range, missing Tasks, evidence cursors and fresh refresh are consistent', async () => {
  const value = task(), date = day(-2)
  entry(value.id, date, 'First'); entry(value.id, date, 'Second')
  await reconcileTaskDailySummaries(); await drain()
  expect(queryTaskDays({ taskIds: [] }).columns).toHaveLength(14)
  const range = queryTaskDays({ taskIds: [value.id, 'deleted'], fromDate: date, toDate: date })
  expect(range.tasks[1]).toMatchObject({ missing: true, status: 'MISSING', totalRecordedMs: null })
  const first = getTaskDayDetails(value.id, date, { limit: 1 })
  expect(first.evidenceBasis).toBe('published_summary')
  expect(first.nextCursor).toBeTruthy()
  const second = getTaskDayDetails(value.id, date, { limit: 1, cursor: first.nextCursor! })
  expect(second.evidence[0].entryId).not.toBe(first.evidence[0].entryId)
  expect(second.nextCursor).toBeNull()
  const response = await taskDailySummaryRoutes.request(`/tasks/${value.id}/days/${date}/summary-refresh`, { method: 'POST' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ unchanged: true, jobId: null })
  expect(() => queryTaskDays({ taskIds: [value.id], fromDate: day(-40), toDate: day(0) })).toThrow(/31/)
})

test('daily settings validate before mutation and prompt tests write call logs without published state', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date)
  const previous = getTaskDailySummarySettings()
  const invalid = await taskDailySummaryRoutes.request('/settings/task-daily-summary', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, taskDailySummaryMaxTokens: 1 }) })
  expect(invalid.status).toBe(422)
  expect(getTaskDailySummarySettings()).toEqual(previous)
  const good = await taskDailySummaryRoutes.request('/settings/task-daily-summary', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMinutes: 30, taskDailySummaryMaxTokens: 777 }) })
  expect(await good.json()).toMatchObject({ intervalMinutes: 30, taskDailySummaryMaxTokens: 777, calendar: { currentWorkDate: day(0) } })
  const response = await taskDailySummaryRoutes.request(`/tasks/${value.id}/days/${date}/summary-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Return evidence-backed JSON using summaryText and sourceEntryIds.', maxTokens: 888 }) })
  expect(response.status).toBe(200)
  expect(calls[0].max_tokens).toBe(888)
  expect(stored(value.id, date)).toBeUndefined()
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)).toBeUndefined()
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM llm_call_logs WHERE feature='task_daily_summary'").get()).toEqual({ n: 1 })
})

test('startup only registers periodic timers, while Task deletion cascades independent daily state', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  startTaskDailySummaryScheduler()
  expect(isTaskDailySummarySchedulerRunning()).toBeTruthy()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(calls).toHaveLength(0)
  expect(readTaskDailyJob(value.id, date, getWorkCalendar().policyId)?.state).toBe('queued')
  await stopTaskDailySummaryScheduler()
  await drain()
  deleteTask(value.id)
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summaries').get()).toEqual({ n: 0 })
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summary_jobs').get()).toEqual({ n: 0 })
})

test('a connection replacement fences model completion and call-log writes away from the new database', async () => {
  const value = task(), date = day(-1)
  entry(value.id, date); await reconcileTaskDailySummaries()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), beginning = new Promise<void>(resolve => { started = resolve })
  globalThis.fetch = (async (_url, init) => { started(); await gate; return reply(String(init?.body)) }) as typeof fetch
  const running = processNextTaskDailySummaryJob()
  await beginning
  closeDb()
  process.env.CHRONICLE_DB_PATH = path.join(directory, 'replacement.db')
  initDb()
  release(); await running
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summaries').get()).toEqual({ n: 0 })
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM llm_call_logs').get()).toEqual({ n: 0 })
})

test('periodic scheduler executes repeated full-history checks, honors interval changes and disable/re-enable', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-15T02:00:00Z') })
  const value = task(), date = day(-20), log = entry(value.id, date, 'Initial historical record')
  const settle = async () => { for (let index = 0; index < 30; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  startTaskDailySummaryScheduler()
  await settle()
  expect(stored(value.id, date)).toBeUndefined()
  expect(calls).toHaveLength(0)
  mock.timers.tick(59 * 60000); await settle()
  expect(calls).toHaveLength(0)
  mock.timers.tick(60000); await settle()
  expect(stored(value.id, date)).toMatchObject({ generation: 1 })
  updateTaskEntry(value.id, log.id, 'Historical record corrected later today')
  mock.timers.tick(60 * 60000); await settle()
  expect(stored(value.id, date)).toMatchObject({ generation: 2 })
  expect(calls).toHaveLength(2)

  saveTaskDailySummarySettings({ enabled: false })
  updateTaskEntry(value.id, log.id, 'Another correction while disabled')
  mock.timers.tick(120 * 60000); await settle()
  expect(calls).toHaveLength(2)
  saveTaskDailySummarySettings({ enabled: true })
  mock.timers.tick(60000); await settle()
  expect(stored(value.id, date)?.generation).toBe(3)

  saveTaskDailySummarySettings({ intervalMinutes: 10 })
  updateTaskEntry(value.id, log.id, 'Correction using the shorter interval')
  mock.timers.tick(60000); await settle() // observe configuration and establish the next interval
  expect(calls).toHaveLength(3)
  mock.timers.tick(9 * 60000); await settle()
  expect(calls).toHaveLength(3)
  mock.timers.tick(60000); await settle()
  expect(stored(value.id, date)?.generation).toBe(4)
  mock.timers.tick(10 * 60000); await settle()
  expect(calls).toHaveLength(4) // unchanged, even on a new periodic pass
})

test('the next periodic pass after days offline discovers older records without a startup-triggered job', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-09T02:00:00Z') })
  const value = task(), friday = day(0)
  entry(value.id, friday, 'Work recorded on Friday')
  mock.timers.tick(4 * 24 * 3600000)
  startTaskDailySummaryScheduler()
  for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(calls).toHaveLength(0)
  mock.timers.tick(60 * 60000)
  for (let index = 0; index < 30; index++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(stored(value.id, friday)?.content_kind).toBe('llm')
  expect(calls).toHaveLength(1)
})
