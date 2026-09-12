/** Local calendar boundaries with the user's recorded-work day offset.
 * Report and project views must pass this same [start,end) to the server.
 */
export function getWorkPeriodRange(period: 'day' | 'week' | 'month', date: Date, offsetHours: number): { start: number; end: number } {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  if (period === 'month') start.setDate(1)
  const end = new Date(start)
  if (period === 'month') end.setMonth(end.getMonth() + 1)
  else end.setDate(end.getDate() + (period === 'week' ? 7 : 1))
  const offset = offsetHours * 3_600_000
  return { start: start.getTime() + offset, end: end.getTime() + offset }
}
