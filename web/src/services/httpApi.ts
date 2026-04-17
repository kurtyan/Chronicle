import axios from 'axios'
import type { ApiInterface } from './apiTypes'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession } from '@/types'

export const httpApi: ApiInterface = {
  async fetchTodos(type?: string, status?: string): Promise<Task[]> {
    const params: Record<string, string> = {}
    if (status) params.status = status
    else params.status = 'PENDING,DOING'
    if (type) params.type = type
    const { data } = await axios.get<Task[]>('/api/tasks', { params })
    return data
  },

  async getTaskById(id: string): Promise<Task | null> {
    const { data } = await axios.get<Task>(`/api/tasks/${id}`)
    return data
  },

  async createTask(req: CreateTaskRequest): Promise<Task> {
    const { data } = await axios.post<Task>('/api/tasks', req)
    return data
  },

  async updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null> {
    const { data } = await axios.put<Task>(`/api/tasks/${id}`, req)
    return data
  },

  async deleteTask(id: string): Promise<void> {
    await axios.delete(`/api/tasks/${id}`)
  },

  async markTaskDone(id: string): Promise<Task | null> {
    const { data } = await axios.put<Task>(`/api/tasks/${id}/done`)
    return data
  },

  async fetchTaskEntries(taskId: string): Promise<TaskEntry[]> {
    const { data } = await axios.get<TaskEntry[]>(`/api/tasks/${taskId}/logs`)
    return data
  },

  async submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log'): Promise<TaskEntry> {
    const { data } = await axios.post<TaskEntry>(`/api/tasks/${taskId}/logs`, { content, type })
    return data
  },

  async updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
    const { data } = await axios.put<TaskEntry>(`/api/tasks/${taskId}/logs/${entryId}`, { content })
    return data
  },

  async takeOverTask(taskId: string): Promise<WorkSession> {
    const { data } = await axios.post<WorkSession>(`/api/tasks/${taskId}/takeover`)
    return data
  },

  async doAfk(): Promise<void> {
    await axios.post('/api/afk')
  },

  async getCurrentSession(): Promise<WorkSession | null> {
    const { data } = await axios.get<WorkSession | null>('/api/sessions/current')
    return data
  },

  async fetchSessions(start: number, end: number): Promise<WorkSession[]> {
    const { data } = await axios.get<WorkSession[]>('/api/sessions', { params: { start, end } })
    return data
  },

  async dropTask(taskId: string, reason: string): Promise<Task | null> {
    const { data } = await axios.post<Task>(`/api/tasks/${taskId}/drop`, { reason })
    return data
  },

  async fetchTodayTasks(): Promise<Task[]> {
    const { data } = await axios.get<Task[]>('/api/tasks/today')
    return data
  },

  async fetchTodayReport(): Promise<{
    totalToday: number
    completedToday: number
    inProgress: number
    tasks: Task[]
  }> {
    const { data } = await axios.get('/api/reports/today')
    return data
  },

  async fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }> {
    const { data } = await axios.get('/api/reports/summary')
    return data
  },
}
