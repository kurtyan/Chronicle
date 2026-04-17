import {
  getAllTasks, getTaskById, createTask, updateTask, deleteTask,
  getTaskEntries, createTaskEntry, updateTaskEntry, markTaskDone,
  startWorkSession, endAllSessions, getCurrentSession, getSessionsForRange, dropTask, getTodayTasks,
  type Task, type TaskEntry, type WorkSession,
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

  async takeOverTask(taskId: string): Promise<WorkSession> {
    return startWorkSession(taskId)
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

    const db = getDb()
    const todayTasks = db.exec(
      `SELECT * FROM tasks WHERE created_at >= ${ts} ORDER BY created_at DESC`
    )

    const rows: Task[] = todayTasks.length > 0 ? todayTasks[0].columns.map((col, i) => {
      const obj: any = {}
      todayTasks[0].columns.forEach((c, j) => { obj[c] = todayTasks[0].values[i][j] })
      return obj
    }).map((row: any) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      priority: row.priority,
      tags: row.tags ? JSON.parse(row.tags) : [],
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      dueDate: row.due_date,
    })) : []

    const completedResult = db.exec(
      `SELECT COUNT(*) as count FROM tasks WHERE completed_at >= ${ts}`
    )
    const inProgressResult = db.exec(
      `SELECT COUNT(*) as count FROM tasks WHERE status = 'DOING'`
    )

    return {
      totalToday: todayTasks.length > 0 ? todayTasks[0].values.length : 0,
      completedToday: completedResult[0]?.values[0][0] ?? 0,
      inProgress: inProgressResult[0]?.values[0][0] ?? 0,
      tasks: rows,
    }
  }

  async fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }> {
    const db = getDb()
    const result = db.exec('SELECT type, priority FROM tasks')
    const byType: Record<string, number> = {}
    const byPriority: Record<string, number> = {}

    if (result.length > 0) {
      const cols = result[0].columns
      for (const row of result[0].values) {
        const type = row[cols.indexOf('type')] as string
        const priority = row[cols.indexOf('priority')] as string
        byType[type] = (byType[type] || 0) + 1
        byPriority[priority] = (byPriority[priority] || 0) + 1
      }
    }

    return {
      byType,
      byPriority,
      totalTasks: result.length > 0 ? result[0].values.length : 0,
    }
  }
}
