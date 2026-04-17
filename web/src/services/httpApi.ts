import axios from 'axios'
import type { AxiosInstance } from 'axios'
import type { ApiInterface } from './apiTypes'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession } from '@/types'

// Server base URL:
// - Tauri: reads server URL from config via native command (defaults to http://localhost:8080)
// - Web served by the server: uses relative path, works on whatever port the server uses.
// - Dev mode (Vite): relative path, proxied to localhost:8080 by Vite.
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__

let clientPromise: Promise<AxiosInstance> | null = null

function getClient(): Promise<AxiosInstance> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (isTauri) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const url = await invoke<string>('get_server_url')
          return axios.create({ baseURL: url })
        } catch {
          return axios.create({ baseURL: 'http://localhost:8080' })
        }
      }
      return axios.create({ baseURL: '' })
    })()
  }
  return clientPromise
}

export const httpApi: ApiInterface = {
  async fetchTodos(type?: string, status?: string): Promise<Task[]> {
    const params: Record<string, string> = {}
    if (status) params.status = status
    else params.status = 'PENDING,DOING'
    if (type) params.type = type
    const { data } = await (await getClient()).get<Task[]>('/api/tasks', { params })
    return data
  },

  async getTaskById(id: string): Promise<Task | null> {
    const { data } = await (await getClient()).get<Task>(`/api/tasks/${id}`)
    return data
  },

  async createTask(req: CreateTaskRequest): Promise<Task> {
    const { data } = await (await getClient()).post<Task>('/api/tasks', req)
    return data
  },

  async updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null> {
    const { data } = await (await getClient()).put<Task>(`/api/tasks/${id}`, req)
    return data
  },

  async deleteTask(id: string): Promise<void> {
    await (await getClient()).delete(`/api/tasks/${id}`)
  },

  async markTaskDone(id: string): Promise<Task | null> {
    const { data } = await (await getClient()).put<Task>(`/api/tasks/${id}/done`)
    return data
  },

  async fetchTaskEntries(taskId: string): Promise<TaskEntry[]> {
    const { data } = await (await getClient()).get<TaskEntry[]>(`/api/tasks/${taskId}/logs`)
    return data
  },

  async submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log'): Promise<TaskEntry> {
    const { data } = await (await getClient()).post<TaskEntry>(`/api/tasks/${taskId}/logs`, { content, type })
    return data
  },

  async updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
    const { data } = await (await getClient()).put<TaskEntry>(`/api/tasks/${taskId}/logs/${entryId}`, { content })
    return data
  },

  async takeOverTask(taskId: string): Promise<WorkSession> {
    const { data } = await (await getClient()).post<WorkSession>(`/api/tasks/${taskId}/takeover`)
    return data
  },

  async doAfk(): Promise<void> {
    await (await getClient()).post('/api/afk')
  },

  async getCurrentSession(): Promise<WorkSession | null> {
    const { data } = await (await getClient()).get<WorkSession | null>('/api/sessions/current')
    return data
  },

  async fetchSessions(start: number, end: number): Promise<WorkSession[]> {
    const { data } = await (await getClient()).get<WorkSession[]>('/api/sessions', { params: { start, end } })
    return data
  },

  async dropTask(taskId: string, reason: string): Promise<Task | null> {
    const { data } = await (await getClient()).post<Task>(`/api/tasks/${taskId}/drop`, { reason })
    return data
  },

  async fetchTodayTasks(): Promise<Task[]> {
    const { data } = await (await getClient()).get<Task[]>('/api/tasks/today')
    return data
  },

  async fetchTodayReport(): Promise<{
    totalToday: number
    completedToday: number
    inProgress: number
    tasks: Task[]
  }> {
    const { data } = await (await getClient()).get('/api/reports/today')
    return data
  },

  async fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }> {
    const { data } = await (await getClient()).get('/api/reports/summary')
    return data
  },
}
