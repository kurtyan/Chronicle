import type { ApiInterface } from './apiTypes'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession, SearchResult } from '@/types'

// Deployment: server API + Tauri UI.
// Always use HTTP API — the Tauri desktop app connects to the local server at localhost:8080.
// The embedded sql.js path is no longer used.

let _api: ApiInterface | null = null

async function getApi(): Promise<ApiInterface> {
  if (!_api) {
    const { httpApi } = await import('./httpApi')
    _api = httpApi
  }
  return _api
}

// Backward-compatible named exports — consumers don't need to change
export async function fetchTodos(type?: string, status?: string): Promise<Task[]> {
  return (await getApi()).fetchTodos(type, status)
}
export async function getTaskById(id: string): Promise<Task | null> {
  return (await getApi()).getTaskById(id)
}
export async function createTask(req: CreateTaskRequest): Promise<Task> {
  return (await getApi()).createTask(req)
}
export async function updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null> {
  return (await getApi()).updateTask(id, req)
}
export async function deleteTask(id: string): Promise<void> {
  return (await getApi()).deleteTask(id)
}
export async function markTaskDone(id: string): Promise<Task | null> {
  return (await getApi()).markTaskDone(id)
}
export async function fetchTaskEntries(taskId: string): Promise<TaskEntry[]> {
  return (await getApi()).fetchTaskEntries(taskId)
}
export async function submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log'): Promise<TaskEntry> {
  return (await getApi()).submitTaskEntry(taskId, content, type)
}
export async function updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
  return (await getApi()).updateTaskEntry(taskId, entryId, content)
}
export async function takeOverTask(taskId: string): Promise<WorkSession> {
  return (await getApi()).takeOverTask(taskId)
}
export async function doAfk(): Promise<void> {
  return (await getApi()).doAfk()
}
export async function getCurrentSession(): Promise<WorkSession | null> {
  return (await getApi()).getCurrentSession()
}
export async function fetchSessions(start: number, end: number): Promise<WorkSession[]> {
  return (await getApi()).fetchSessions(start, end)
}
export async function dropTaskApi(taskId: string, reason: string): Promise<Task | null> {
  return (await getApi()).dropTask(taskId, reason)
}
export async function fetchTodayTasks(): Promise<Task[]> {
  return (await getApi()).fetchTodayTasks()
}
export async function fetchTodayReport(): Promise<{
  totalToday: number
  completedToday: number
  inProgress: number
  tasks: Task[]
}> {
  return (await getApi()).fetchTodayReport()
}
export async function fetchSummary(): Promise<{
  byType: Record<string, number>
  byPriority: Record<string, number>
  totalTasks: number
}> {
  return (await getApi()).fetchSummary()
}
export async function fetchRangeStats(start: number, end: number): Promise<{
  total: number
  completed: number
  inProgress: number
}> {
  return (await getApi()).fetchRangeStats(start, end)
}
export async function searchTasks(query: string, limit?: number): Promise<{
  results: SearchResult[]
  tokens: string[]
  total: number
}> {
  return (await getApi()).searchTasks(query, limit)
}
