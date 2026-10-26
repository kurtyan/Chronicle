import { Hono } from 'hono'
import type { TaskDailySummarySettingsResponse } from '../../shared/taskDailySummaryTypes'
import { getLlmSettings, saveLlmSettings } from './services/llmService'
import { getTaskDailySummarySettings, saveTaskDailySummarySettings, validateTaskDailySummarySettings, dailyError } from './services/taskDailySummarySettings'
import { getWorkCalendar, assertClosedWorkDate, backfillStartDate } from './services/workCalendarService'
import { getDb } from './db'
import { queryTaskDays, getTaskDayDetails } from './services/taskDayQueryService'
import { buildTaskDaySnapshot, setTaskEntryWorkDate } from './services/taskDailySourceService'
import { enqueueTaskDailySummary, listTaskDailySummaryJobs } from './services/taskDailySummaryService'
import { testTaskDailySummary } from './services/taskDailySummaryWorker'
import { broadcastEvent } from './services/eventBus'

export const taskDailySummaryRoutes = new Hono()

taskDailySummaryRoutes.onError((error: any, c) => {
  const status = [400, 404, 409, 422, 429, 503].includes(error?.status) ? error.status : 500
  return c.json({ error: error?.message || 'Daily summary request failed', code: error?.code ?? 'TASK_DAILY_SUMMARY_ERROR' }, status)
})

async function objectBody(c: any): Promise<Record<string, any>> {
  let body: any
  try { body = await c.req.json() } catch { throw dailyError('Expected a JSON object', 'INVALID_REQUEST', 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw dailyError('Expected a JSON object', 'INVALID_REQUEST', 400)
  return body
}

function settingsResponse(): TaskDailySummarySettingsResponse {
  const settings = getTaskDailySummarySettings(), llm = getLlmSettings(), asOf = Date.now()
  const calendar = getWorkCalendar(asOf)
  const summariesInWindow = (getDb().prepare('SELECT COUNT(*) AS n FROM task_daily_summaries WHERE calendar_policy_id=? AND work_date>=?')
    .get(calendar.policyId, backfillStartDate(calendar) ?? '0000-00-00') as { n: number }).n
  return { ...settings, taskDailySummaryPrompt: llm.taskDailySummaryPrompt, taskDailySummaryMaxTokens: llm.taskDailySummaryMaxTokens,
    defaultTaskDailySummaryPrompt: llm.defaultTaskDailySummaryPrompt, calendar, asOf, summariesInWindow }
}

taskDailySummaryRoutes.post('/task-days/query', async c => {
  const body = await objectBody(c)
  return c.json(queryTaskDays(body as any))
})

taskDailySummaryRoutes.get('/tasks/:taskId/days/:date', c => c.json(getTaskDayDetails(c.req.param('taskId'), c.req.param('date'), {
  cursor: c.req.query('cursor'), limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
})))

taskDailySummaryRoutes.post('/tasks/:taskId/days/:date/summary-refresh', c => {
  const now = Date.now(), calendar = getWorkCalendar(now), date = c.req.param('date')
  assertClosedWorkDate(date, calendar, now)
  const queued = enqueueTaskDailySummary(buildTaskDaySnapshot(c.req.param('taskId'), date, calendar, now), { retryFailed: true })
  return c.json(queued, queued.unchanged ? 200 : 202)
})

taskDailySummaryRoutes.post('/tasks/:taskId/days/:date/summary-test', async c => {
  const body = await objectBody(c)
  if (body.prompt !== undefined && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 100000)) throw dailyError('prompt must be nonempty text up to 100000 characters')
  if (body.maxTokens !== undefined && (!Number.isInteger(body.maxTokens) || body.maxTokens < 16 || body.maxTokens > 32000)) throw dailyError('maxTokens must be between 16 and 32000')
  return c.json(await testTaskDailySummary(c.req.param('taskId'), c.req.param('date'), { prompt: body.prompt, maxTokens: body.maxTokens }))
})

taskDailySummaryRoutes.get('/task-daily-summary-jobs', c => c.json(listTaskDailySummaryJobs({ cursor: c.req.query('cursor'), limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')) })))

taskDailySummaryRoutes.get('/settings/task-daily-summary', c => c.json(settingsResponse()))

taskDailySummaryRoutes.put('/settings/task-daily-summary', async c => {
  const body = await objectBody(c)
  const schedule = validateTaskDailySummarySettings(body)
  if (body.taskDailySummaryPrompt !== undefined && (typeof body.taskDailySummaryPrompt !== 'string' || body.taskDailySummaryPrompt.length > 100000)) throw dailyError('taskDailySummaryPrompt must be text up to 100000 characters')
  if (body.taskDailySummaryMaxTokens !== undefined && (!Number.isInteger(body.taskDailySummaryMaxTokens) || body.taskDailySummaryMaxTokens < 16 || body.taskDailySummaryMaxTokens > 32000)) throw dailyError('taskDailySummaryMaxTokens must be between 16 and 32000')
  // Validate the complete request before either the shared config or DB settings is changed.
  if (body.taskDailySummaryPrompt !== undefined || body.taskDailySummaryMaxTokens !== undefined) saveLlmSettings({ taskDailySummaryPrompt: body.taskDailySummaryPrompt, taskDailySummaryMaxTokens: body.taskDailySummaryMaxTokens })
  saveTaskDailySummarySettings(schedule)
  broadcastEvent('task_daily_summary_settings_updated', { calendar: getWorkCalendar() })
  return c.json(settingsResponse())
})

taskDailySummaryRoutes.put('/tasks/:taskId/logs/:entryId/work-date', async c => {
  const body = await objectBody(c)
  if (body.workDate !== null && typeof body.workDate !== 'string') throw dailyError('workDate must be a date or null')
  const entry = setTaskEntryWorkDate(c.req.param('taskId'), c.req.param('entryId'), body.workDate)
  broadcastEvent('entry_updated', { taskId: c.req.param('taskId'), entryId: c.req.param('entryId'), type: 'log' })
  return c.json(entry)
})
