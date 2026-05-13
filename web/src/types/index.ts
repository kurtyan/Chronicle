export type TaskType = 'TODO' | 'TOREAD' | 'DAILY_IMPROVE'

export type TaskStatus = 'PENDING' | 'DOING' | 'DONE' | 'DROPPED' | 'ON_HOLD'

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
  type: 'body' | 'log' | 'plan'
  createdAt: number
  planStatus?: 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED'
  planDetailId?: string
  planEstimatedMinutes?: number
  planEstimatedStart?: string
  planEstimatedEnd?: string
}

export interface WorkSession {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
}

export interface SearchResult {
  taskId: string
  taskTitle: string
  taskType: TaskType
  taskStatus: TaskStatus
  taskTags: string[]
  matchType: 'task' | 'entry_body' | 'entry_log'
  matchedContent: string
  originalTitle: string
  matchedOriginal: string
  tokens: string[]
  exactMatch: boolean
  rank: number
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

export interface TaskExtraInfo {
  taskId: string
  key: string
  value: string
}

export interface AfkEvent {
  id: string
  triggeredAt: number
  reason: string
  userNote: string | null
  submittedAt: number | null
}

export interface PlanItemDetail {
  id: string
  entryId: string
  planDate: string
  estimatedMinutes: number
  estimatedStart: string | null
  estimatedEnd: string | null
  actualStartedAt: number | null
  actualCompletedAt: number | null
  status: 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED'
  sortOrder: number
}

export interface PlanItem extends TaskEntry {
  detailId: string
  taskTitle: string
  estimatedMinutes: number
  estimatedStart: string | null
  estimatedEnd: string | null
  actualStartedAt: number | null
  actualCompletedAt: number | null
  planStatus: 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED'
  planDate: string
  sortOrder: number
}

export interface BatchCreatePlanItem {
  taskId: string
  content: string
  estimatedMinutes: number
  estimatedStart: string
  estimatedEnd: string
  sortOrder: number
  detailId?: string
}

export interface BatchCreatePlanItemsRequest {
  planDate: string
  items: BatchCreatePlanItem[]
}
