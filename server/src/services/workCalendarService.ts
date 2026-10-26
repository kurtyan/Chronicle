import { createHash } from 'node:crypto'
import { getMetaValue } from '../db'
import type { WorkCalendar } from '../../../shared/taskDailySummaryTypes'
import { dailyError, getTaskDailySummarySettings } from './taskDailySummarySettings'

export type CalendarPolicy = Pick<WorkCalendar, 'policyId' | 'timeZone' | 'startOfDayHour'>
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string) {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    formatters.set(timeZone, value)
  }
  return value
}

function localParts(epoch: number, timeZone: string) {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(epoch)) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second }
}

function dateString(year: number, month: number, day: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function validateWorkDate(date: unknown): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw dailyError('date must be YYYY-MM-DD', 'INVALID_DATE')
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (year < 1970 || year > 9998 || dateString(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate()) !== date) throw dailyError('Invalid calendar date', 'INVALID_DATE')
  return date
}

export function addWorkDateDays(date: string, amount: number): string {
  const [year, month, day] = validateWorkDate(date).split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + amount))
  return dateString(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
}

/** Compatible DST disambiguation: first occurrence in a fold, forward through a gap. */
export function workDateStart(date: string, policy: CalendarPolicy): number {
  const [year, month, day] = validateWorkDate(date).split('-').map(Number)
  const wall = Date.UTC(year, month - 1, day, policy.startOfDayHour)
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wall + hours * 3600000
    const p = localParts(sample, policy.timeZone)
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sample)
  }
  const candidates = [...offsets].map(offset => {
    const epoch = wall - offset
    const p = localParts(epoch, policy.timeZone)
    const actualWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    return { epoch, delta: actualWall - wall }
  })
  const exact = candidates.filter(value => value.delta === 0).sort((a, b) => a.epoch - b.epoch)
  if (exact.length) return exact[0].epoch
  const after = candidates.filter(value => value.delta > 0).sort((a, b) => a.delta - b.delta || a.epoch - b.epoch)
  if (after.length) return after[0].epoch
  throw dailyError('Cannot resolve date boundary', 'INVALID_DATE')
}

export function workDateRange(date: string, policy: CalendarPolicy) {
  return { start: workDateStart(date, policy), end: workDateStart(addWorkDateDays(date, 1), policy) }
}

export function workDateAt(epoch: number, policy: CalendarPolicy): string {
  if (!Number.isFinite(epoch) || epoch < 0) throw dailyError('Invalid timestamp')
  const p = localParts(epoch, policy.timeZone)
  const date = dateString(p.year, p.month, p.day)
  return epoch < workDateStart(date, policy) ? addWorkDateDays(date, -1) : date
}

export function getWorkCalendar(now = Date.now()): WorkCalendar {
  const timeZone = getTaskDailySummarySettings().timeZone
  const rawOffset = Number(getMetaValue('start_of_day_offset') ?? 5)
  const startOfDayHour = Number.isFinite(rawOffset) ? Math.max(0, Math.min(23, Math.trunc(rawOffset))) : 5
  const policy = { timeZone, startOfDayHour, policyId: `calendar-v1-${createHash('sha256').update(JSON.stringify([timeZone, startOfDayHour])).digest('hex').slice(0, 24)}` }
  const currentWorkDate = workDateAt(now, policy)
  return { ...policy, currentWorkDate, lastClosedWorkDate: addWorkDateDays(currentWorkDate, -1) }
}

export function assertClosedWorkDate(date: string, policy: CalendarPolicy, now = Date.now()) {
  const range = workDateRange(date, policy)
  if (range.end > now) throw dailyError('Only closed dates can have a daily summary', 'DATE_NOT_CLOSED')
  return range
}

/** First closed workday covered by scheduled generation, or null when the window is unlimited. */
export function backfillStartDate(calendar: Pick<WorkCalendar, 'lastClosedWorkDate'>): string | null {
  const days = getTaskDailySummarySettings().backfillDays
  return days > 0 ? addWorkDateDays(calendar.lastClosedWorkDate, -(days - 1)) : null
}
