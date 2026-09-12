import { getDb } from '../db'
import type { ProjectSession, WorkStatistics, WorkStatisticsGroup, WorkStatisticsRange } from '../../../shared/projectTypes'
import { getRecordedWork } from './recordedWorkService'

export interface WorkStatisticsOverrides { tasks?: Map<string, string | null>; milestones?: Map<string, string> }

/** Same clipped-session summation as Report; overlapping records are identified, never silently deduplicated. */
export function getWorkStatistics(range: WorkStatisticsRange = {}, overrides: WorkStatisticsOverrides = {}): WorkStatistics {
  const recorded = getRecordedWork(range)
  const { start, end, asOf, totalMs, anomalies } = recorded
  const tasks = new Map((getDb().prepare('SELECT id,title,primary_milestone_id FROM tasks').all() as any[]).map(task => [task.id, task]))
  const milestones = new Map((getDb().prepare('SELECT id,name,area_id FROM milestones').all() as any[]).map(m => [m.id, m]))
  const areas = new Map((getDb().prepare('SELECT id,name FROM areas').all() as any[]).map(a => [a.id, a]))
  const sessions: ProjectSession[] = []
  const areaGroups = new Map<string, { name: string; totalMs: number; tasks: Set<string> }>()
  const milestoneGroups = new Map<string, { name: string; totalMs: number; tasks: Set<string> }>()
  const taskGroups = new Map<string, { name: string; totalMs: number; tasks: Set<string> }>()
  let unassignedMs = 0
  const add = (groups: typeof areaGroups, id: string, name: string, taskId: string, duration: number) => {
    const group = groups.get(id) ?? { name, totalMs: 0, tasks: new Set<string>() }
    group.totalMs += duration; group.tasks.add(taskId); groups.set(id, group)
  }
  for (const session of recorded.sessions) {
    const task = tasks.get(session.taskId)
    const milestoneId = overrides.tasks?.has(session.taskId) ? overrides.tasks.get(session.taskId)! : task?.primary_milestone_id ?? null
    const milestone = milestoneId ? milestones.get(milestoneId) : null
    const areaId = milestone ? overrides.milestones?.get(milestoneId!) ?? milestone.area_id : null
    const { durationMs, taskId } = session
    sessions.push({ ...session, milestoneId: milestone?.id ?? null, areaId })
    add(taskGroups, taskId, task?.title ?? taskId, taskId, durationMs)
    if (milestone && areaId) {
      add(milestoneGroups, milestone.id, milestone.name, taskId, durationMs)
      add(areaGroups, areaId, areas.get(areaId)?.name ?? areaId, taskId, durationMs)
    } else unassignedMs += durationMs
  }
  const groups = (map: typeof areaGroups): WorkStatisticsGroup[] => [...map].map(([id, g]) => ({ id, name: g.name, totalMs: g.totalMs, taskCount: g.tasks.size }))
    .sort((a, b) => b.totalMs - a.totalMs || a.id.localeCompare(b.id))
  return { start, end, asOf, totalMs, unassignedMs, byArea: groups(areaGroups), byMilestone: groups(milestoneGroups), byTask: groups(taskGroups), sessions, anomalies }
}
