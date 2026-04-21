import {
  getAllTasks, getTaskById, createTask, updateTask, deleteTask,
  getTaskEntries, createTaskEntry, updateTaskEntry, markTaskDone,
  startWorkSession, endAllSessions, getCurrentSession, getSessionsForRange, dropTask, getTodayTasks,
  setTaskExtraInfo, getTaskExtraInfo, getTaskExtraInfoValue, deleteTaskExtraInfo, getAllTasksWithPinned, togglePinned, getPinnedTaskIds,
  createAfkEvent, updateAfkEvent, getAfkEvents,
  type Task, type TaskEntry, type WorkSession, type TaskExtraInfo, type AfkEvent,
} from './taskService'
import { getDb } from '../db'

export class AppService {
  // --- Tasks ---

  async fetchTodos(type?: string, status?: string): Promise<Task[]> {
    const statusArr = status ? status.split(',') : undefined
    return getAllTasks({ type, status: statusArr })
  }

  async getTaskById(id: string): Promise<Task | null> {
    return getTaskById(id)
  }

  async createTask(data: {
    title: string
    type: string
    priority: string
    tags?: string[]
    status?: string
    dueDate?: number
    body?: string
  }): Promise<Task> {
    return createTask(data)
  }

  async updateTask(id: string, data: {
    title?: string
    type?: string
    priority?: string
    tags?: string[]
    status?: string
    dueDate?: number
  }): Promise<Task | null> {
    return updateTask(id, data)
  }

  async deleteTask(id: string): Promise<void> {
    const ok = deleteTask(id)
    if (!ok) throw new Error('Task not found')
  }

  async markTaskDone(id: string): Promise<Task | null> {
    return markTaskDone(id)
  }

  // --- Task Entries ---

  async fetchTaskEntries(taskId: string): Promise<TaskEntry[]> {
    return getTaskEntries(taskId)
  }

  async submitTaskEntry(taskId: string, content: string, type: 'body' | 'log' = 'log'): Promise<TaskEntry> {
    return createTaskEntry(taskId, content, type)
  }

  async updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
    return updateTaskEntry(entryId, content)
  }

  // --- Work Sessions ---

  async takeOverTask(taskId: string): Promise<{ session: WorkSession; task: Task | null }> {
    // Auto-start: PENDING → DOING
    let changedTask: Task | null = null
    const task = getTaskById(taskId)
    if (task?.status === 'PENDING') {
      changedTask = await updateTask(taskId, { status: 'DOING' })
    }
    const session = startWorkSession(taskId)
    return { session, task: changedTask }
  }

  async doAfk(): Promise<void> {
    endAllSessions()
  }

  async getCurrentSession(): Promise<WorkSession | null> {
    return getCurrentSession()
  }

  async fetchSessions(start: number, end: number): Promise<WorkSession[]> {
    return getSessionsForRange(start, end)
  }

  async dropTask(id: string, reason: string): Promise<Task | null> {
    return dropTask(id, reason)
  }

  async fetchTodayTasks(): Promise<Task[]> {
    return getTodayTasks()
  }

  // --- Reports ---

  async fetchTodayReport(): Promise<{
    totalToday: number
    completedToday: number
    inProgress: number
    tasks: Task[]
  }> {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const ts = startOfDay.getTime()

    const tasks = getAllTasks()
    const todayTasks = tasks.filter(t => t.createdAt >= ts)

    const completedResult = getDb().prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE completed_at >= ?'
    ).get(ts) as { count: number }

    const inProgressResult = getDb().prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE status = 'DOING'"
    ).get() as { count: number }

    return {
      totalToday: todayTasks.length,
      completedToday: completedResult.count,
      inProgress: inProgressResult.count,
      tasks: todayTasks,
    }
  }

  async fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }> {
    const rows = getDb().prepare('SELECT type, priority FROM tasks').all() as { type: string; priority: string }[]
    const byType: Record<string, number> = {}
    const byPriority: Record<string, number> = {}

    for (const row of rows) {
      byType[row.type] = (byType[row.type] || 0) + 1
      byPriority[row.priority] = (byPriority[row.priority] || 0) + 1
    }

    return {
      byType,
      byPriority,
      totalTasks: rows.length,
    }
  }

  async fetchRangeStats(start: number, end: number): Promise<{
    total: number
    completed: number
    inProgress: number
  }> {
    // Total tasks created in range
    const totalResult = getDb().prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE created_at >= ? AND created_at <= ?'
    ).get(start, end) as { count: number }

    // Tasks completed in range (completed_at falls within range)
    const completedResult = getDb().prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ? AND completed_at <= ?'
    ).get(start, end) as { count: number }

    // In progress: tasks with sessions in range, not yet DONE
    const inProgressResult = getDb().prepare(
      `SELECT COUNT(DISTINCT t.id) as count FROM tasks t
       INNER JOIN work_sessions ws ON ws.task_id = t.id
       WHERE ws.started_at >= ? AND ws.started_at <= ?
       AND t.status != 'DONE' AND t.status != 'DROPPED'`
    ).get(start, end) as { count: number }

    return {
      total: totalResult.count,
      completed: completedResult.count,
      inProgress: inProgressResult.count,
    }
  }

  // --- Task Extra Info ---

  async setTaskExtraInfo(taskId: string, key: string, value: string): Promise<TaskExtraInfo> {
    return setTaskExtraInfo(taskId, key, value)
  }

  async getTaskExtraInfo(taskId: string): Promise<TaskExtraInfo[]> {
    return getTaskExtraInfo(taskId)
  }

  async getTaskExtraInfoValue(taskId: string, key: string): Promise<string | null> {
    return getTaskExtraInfoValue(taskId, key)
  }

  async deleteTaskExtraInfo(taskId: string, key: string): Promise<boolean> {
    return deleteTaskExtraInfo(taskId, key)
  }

  async getAllTasksWithPinned(): Promise<Array<Task & { pinned: boolean }>> {
    return getAllTasksWithPinned()
  }

  async togglePinned(taskId: string): Promise<boolean> {
    return togglePinned(taskId)
  }

  async getPinnedTaskIds(): Promise<string[]> {
    return [...getPinnedTaskIds()]
  }

  // --- AFK Events ---

  async createAfkEvent(reason: string, triggeredAt: number): Promise<AfkEvent> {
    return createAfkEvent(reason, triggeredAt)
  }

  async updateAfkEvent(id: string, userNote: string): Promise<AfkEvent | null> {
    return updateAfkEvent(id, userNote)
  }

  async getAfkEvents(start?: number, end?: number): Promise<AfkEvent[]> {
    return getAfkEvents(start, end)
  }
}
