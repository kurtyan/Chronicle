import type { MilestoneOverview } from '@/services/projectApi'

export const calendarDay = (value: number) => { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
export const addCalendarDays = (value: number, count: number) => { const d = new Date(value); d.setDate(d.getDate() + count); return d.getTime() }
export const TRACK_HEIGHT = 36

export interface GanttPlacement {
  milestone: MilestoneOverview
  track: number
  left: number
  right: number
  labelLeft: number
  labelWidth: number
  barLeft: number
  barWidth: number
  hitLeft: number
  hitRight: number
  point: boolean
  clippedStart: boolean
  clippedEnd: boolean
}

// Allocate by inclusive calendar dates, not by title length. Text is clipped
// inside its available space; full content is available through preview/select.
export function layoutMilestones(milestones: MilestoneOverview[], windowStart: number, windowEnd: number, width: number) {
  const position = (value: number) => (value - windowStart) / (windowEnd - windowStart) * width
  const scheduled: GanttPlacement[] = []
  const outside: MilestoneOverview[] = []
  const undated: MilestoneOverview[] = []
  const dates = new Map<string, { start: number; end: number }>()
  for (const milestone of milestones) {
    const start = milestone.startDate === null ? null : calendarDay(milestone.startDate)
    const target = milestone.targetDate === null ? null : calendarDay(milestone.targetDate)
    if (start === null && target === null) { undated.push(milestone); continue }
    const end = target === null ? Infinity : addCalendarDays(target, 1)
    if ((start ?? target!) >= windowEnd || end <= windowStart) { outside.push(milestone); continue }
    const point = start === null
    const barLeft = Math.max(0, position(start ?? target!))
    const barRight = point ? barLeft : Math.min(width, position(end))
    dates.set(milestone.id, { start: start ?? target!, end })
    scheduled.push({
      milestone, track: 0, left: barLeft, right: barRight, labelLeft: barLeft,
      labelWidth: barRight - barLeft, barLeft, barWidth: barRight - barLeft, hitLeft: barLeft, hitRight: barRight, point,
      clippedStart: start !== null && start < windowStart,
      clippedEnd: target !== null && end > windowEnd,
    })
  }
  scheduled.sort((a, b) => dates.get(a.milestone.id)!.start - dates.get(b.milestone.id)!.start || dates.get(a.milestone.id)!.end - dates.get(b.milestone.id)!.end || a.milestone.id.localeCompare(b.milestone.id))
  const trackEnds: number[] = []
  for (const item of scheduled) {
    const interval = dates.get(item.milestone.id)!
    const available = trackEnds.findIndex(end => end <= interval.start)
    item.track = available < 0 ? trackEnds.length : available
    trackEnds[item.track] = interval.end
  }
  // A target-only marker may use the following empty space for its title,
  // bounded by the next actual item on the same track.
  for (let index = 0; index < scheduled.length; index++) {
    const item = scheduled[index]
    if (!item.point) continue
    const next = scheduled.slice(index + 1).find(candidate => candidate.track === item.track)
    item.labelLeft = item.barLeft + 14
    item.labelWidth = Math.max(0, Math.min(170, (next?.left ?? width) - item.labelLeft - 6))
    item.right = Math.min(width, Math.max(item.barLeft + 8, item.labelLeft + item.labelWidth))
  }
  for (const item of scheduled) {
    item.hitLeft = item.left
    item.hitRight = item.right
    if (item.right - item.left >= 24) continue
    const peers = scheduled.filter(candidate => candidate.track === item.track)
    const index = peers.indexOf(item)
    const previous = peers[index - 1]
    const next = peers[index + 1]
    // Expand only the transparent hit region, stopping halfway to neighbors.
    // Even at month scale every actual mark keeps its own reachable center.
    item.hitLeft = Math.max(0, item.left - 10, previous ? (previous.right + item.left) / 2 : 0)
    item.hitRight = Math.min(width, item.right + 10, next ? (item.right + next.left) / 2 : width)
  }
  return { scheduled, outside, undated, trackCount: trackEnds.length }
}
