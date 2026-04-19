import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession, SearchResult } from '@/types'

export interface ApiInterface {
  fetchTodos(type?: string, status?: string): Promise<Task[]>
  getTaskById(id: string): Promise<Task | null>
  createTask(req: CreateTaskRequest): Promise<Task>
  updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null>
  deleteTask(id: string): Promise<void>
  markTaskDone(id: string): Promise<Task | null>
  fetchTaskEntries(taskId: string): Promise<TaskEntry[]>
  submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log'): Promise<TaskEntry>
  updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null>
  takeOverTask(taskId: string): Promise<WorkSession>
  doAfk(): Promise<void>
  getCurrentSession(): Promise<WorkSession | null>
  fetchSessions(start: number, end: number): Promise<WorkSession[]>
  dropTask(taskId: string, reason: string): Promise<Task | null>
  fetchTodayTasks(): Promise<Task[]>
  fetchTodayReport(): Promise<{
    totalToday: number
    completedToday: number
    inProgress: number
    tasks: Task[]
  }>
  fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }>
  fetchRangeStats(start: number, end: number): Promise<{
    total: number
    completed: number
    inProgress: number
  }>
  searchTasks(query: string, limit?: number): Promise<{
    results: SearchResult[]
    tokens: string[]
    total: number
  }>
}
