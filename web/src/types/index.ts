export type TaskType = 'TODO' | 'TOREAD' | 'DAILY_IMPROVE'

export type TaskStatus = 'PENDING' | 'DOING' | 'DONE' | 'DROPPED'

export type Priority = 'HIGH' | 'MEDIUM' | 'LOW'

export interface Task {
  id: string
  title: string
  type: TaskType
  priority: Priority
  tags: string[]
  status: TaskStatus
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  dueDate: number | null
}

export interface CreateTaskRequest {
  title: string
  type: TaskType
  priority: Priority
  tags?: string[]
  status?: TaskStatus
  dueDate?: number
  body?: string
}

export interface UpdateTaskRequest {
  title?: string
  type?: TaskType
  priority?: Priority
  tags?: string[]
  status?: TaskStatus
  dueDate?: number
}

export interface TaskEntry {
  id: string
  taskId: string
  content: string
  type: 'body' | 'log'
  createdAt: number
}

export interface WorkSession {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
}

export const priorityColors: Record<Priority, string> = {
  HIGH: 'bg-red-500',
  MEDIUM: 'bg-yellow-500',
  LOW: 'bg-green-500',
}

export const priorityOrder: Record<Priority, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
}
