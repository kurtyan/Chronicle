import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession, SearchResult, TaskExtraInfo, AfkEvent } from '@/types'

export interface ApiInterface {
  fetchTodos(type?: string, status?: string): Promise<Task[]>
  getNextTaskId(): Promise<string>
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
  // Task Extra Info
  getTaskExtraInfo(taskId: string): Promise<TaskExtraInfo[]>
  getTaskExtraInfoValue(taskId: string, key: string): Promise<string | null>
  setTaskExtraInfo(taskId: string, key: string, value: string): Promise<TaskExtraInfo>
  deleteTaskExtraInfo(taskId: string, key: string): Promise<boolean>
  togglePinned(taskId: string): Promise<boolean>
  getPinnedTaskIds(): Promise<string[]>
  // AFK Events
  createAfkEvent(reason: string, triggeredAt: number, userNote?: string): Promise<AfkEvent>
  updateAfkEvent(id: string, userNote: string): Promise<AfkEvent | null>
  getAfkEvents(start?: number, end?: number): Promise<AfkEvent[]>
}
