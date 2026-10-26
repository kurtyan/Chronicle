import { getMetaValue, setMetaValue } from '../db'
import type { TaskDailySummarySettings } from '../../../shared/taskDailySummaryTypes'

const SETTINGS_KEY = 'task_daily_summary_settings'
const DEFAULTS: TaskDailySummarySettings = {
  enabled: true,
  intervalMinutes: 60,
  timeZone: 'Asia/Shanghai',
  maxInputChars: 24000,
  dailyCallBudget: 100,
  backfillDays: 60,
  logRetentionDays: 30,
  concurrency: 1,
}

export function dailyError(message: string, code = 'INVALID_REQUEST', status = 422): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status })
}

export function validateTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw dailyError('timeZone must be an IANA time zone')
  try { return new Intl.DateTimeFormat('en', { timeZone: value.trim() }).resolvedOptions().timeZone }
  catch { throw dailyError('timeZone must be an IANA time zone') }
}

export function getTaskDailySummarySettings(): TaskDailySummarySettings {
  let parsed: any = {}
  try { parsed = JSON.parse(getMetaValue(SETTINGS_KEY) ?? '{}') } catch { /* defaults recover malformed legacy settings */ }
  const numeric = (key: keyof TaskDailySummarySettings, minimum: number, maximum: number) => {
    const value = parsed?.[key]
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : DEFAULTS[key]
  }
  let timeZone = DEFAULTS.timeZone
  try { if (parsed?.timeZone) timeZone = validateTimeZone(parsed.timeZone) } catch { /* default */ }
  return {
    enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
    intervalMinutes: numeric('intervalMinutes', 1, 1440) as number,
    timeZone,
    maxInputChars: numeric('maxInputChars', 4000, 200000) as number,
    dailyCallBudget: numeric('dailyCallBudget', 0, 10000) as number,
    backfillDays: numeric('backfillDays', 0, 3650) as number,
    logRetentionDays: numeric('logRetentionDays', 0, 3650) as number,
    concurrency: 1,
  }
}

export function validateTaskDailySummarySettings(input: Partial<TaskDailySummarySettings>): TaskDailySummarySettings {
  const next = getTaskDailySummarySettings()
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw dailyError('enabled must be a boolean')
    next.enabled = input.enabled
  }
  if (input.timeZone !== undefined) next.timeZone = validateTimeZone(input.timeZone)
  for (const [key, minimum, maximum] of [['intervalMinutes', 1, 1440], ['maxInputChars', 4000, 200000], ['dailyCallBudget', 0, 10000], ['backfillDays', 0, 3650], ['logRetentionDays', 0, 3650]] as const) {
    if (input[key] === undefined) continue
    if (!Number.isInteger(input[key]) || input[key]! < minimum || input[key]! > maximum) throw dailyError(`${key} must be an integer between ${minimum} and ${maximum}`)
    next[key] = input[key]!
  }
  if (input.concurrency !== undefined && input.concurrency !== 1) throw dailyError('concurrency must be 1')
  return next
}

export function saveTaskDailySummarySettings(input: Partial<TaskDailySummarySettings>): TaskDailySummarySettings {
  const next = validateTaskDailySummarySettings(input)
  setMetaValue(SETTINGS_KEY, JSON.stringify(next))
  return next
}
