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
  type: 'body' | 'log' | 'pinned'
  createdAt: number
}

export interface TaskLogDraft {
  taskId: string
  content: string
  updatedAt: number
}

export type WorkOverviewHidableSignalSourceType = 'carry_over' | 'explicit' | 'recommended'

export interface WorkOverviewHiddenSignal {
  id: string
  taskId: string
  sourceType: WorkOverviewHidableSignalSourceType
  signalKey: string
  hiddenAt: number
}

export interface AgentConversation {
  agent: 'devin' | 'claude'
  conversationId: string
  command: string
  createdAt: number
  sourceEntryId?: string
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
  matchType: 'task' | 'entry_body' | 'entry_log' | 'entry_pinned'
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

export interface LlmSettings {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  meetingExtractionMaxTokens: number
  taskSummaryMaxTokens: number
  dailySummaryMaxTokens: number
  meetingExtractionPrompt: string
  defaultMeetingExtractionPrompt: string
  taskSummaryPrompt: string
  defaultTaskSummaryPrompt: string
  dailySummaryPrompt: string
  defaultDailySummaryPrompt: string
}

export interface MeetingExtractionResult {
  llmCallLogId: string
  title: string | null
  startedAt: number | null
  endedAt: number | null
  content: string
  participants: string[]
  tags: string[]
  rawContent: string
  warnings: string[]
}

export interface CreateMeetingRequest {
  title: string
  startedAt: number
  endedAt: number
  content: string
  participants: string[]
  tags: string[]
  rawContent: string
  llmCallLogId?: string
}

export interface DayScriptBlock {
  id: string
  sortOrder: number
  startTime: string
  endTime: string
  headerText: string
  progressText: string
  completed: boolean
  taskIds: string[]
  source: DayScriptBlockSource
  originScriptDate: string | null
  originBlockId: string | null
  originSource: DayScriptBlockSource | null
}

export type DayScriptBlockSource = 'manual' | 'task_next_step' | 'task_recommended_next_step' | 'carry_over'

export interface DayScriptDocument {
  scriptDate: string
  revision: number
  document: Record<string, any>
  blocks: DayScriptBlock[]
  updatedAt: number
}

export interface DayScriptValidationError {
  lineIndex: number
  message: string
}

export interface ProgressSyncConflict {
  blockId: string
  taskId: string
  taskTitle: string
  startTime: string
  endTime: string
  existingProgress: string
  currentProgress: string
}

export interface DayScriptFocusActivity {
  blockKey: string
  taskId: string
  firstEditedAt: number
}

export interface DayScriptExecutionRecord {
  id: string
  scriptDate: string
  blockId: string
  taskId: string
  progressEntryId: string
  workSessionId: string | null
  plannedStartAt: number
  plannedEndAt: number
  actualStartedAt: number
  actualCompletedAt: number
  plannedMinutes: number
  actualMinutes: number
  startDelayMinutes: number
  overrunMinutes: number
  createdAt: number
}

export interface SaveDayScriptResult {
  script: DayScriptDocument
  createdTasks: Task[]
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  executionRecords: DayScriptExecutionRecord[]
  validationErrors: DayScriptValidationError[]
  conflicts: ProgressSyncConflict[]
}

export interface SubmitDayScriptProgressResult {
  script: DayScriptDocument
  createdTasks: Task[]
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  executionRecords: DayScriptExecutionRecord[]
  validationErrors: DayScriptValidationError[]
  conflicts: ProgressSyncConflict[]
}

export interface DailySummaryResult {
  date: string
  summaryMarkdown: string
  cached: boolean
  llmCallLogId: string | null
}

export interface DailySummaryCacheResult extends DailySummaryResult {
  updatedAt: number
  fingerprintStatus: 'fresh' | 'stale'
}

export type BackgroundTaskType = 'daily_summary' | 'task_summary' | 'meeting_extract'
export type BackgroundTaskStatus = 'running' | 'success' | 'error'

export interface BackgroundTask {
  id: string
  type: BackgroundTaskType
  sourceKey: string
  title: string
  status: BackgroundTaskStatus
  result: DailySummaryResult | TaskSummaryTestResult | Omit<MeetingExtractionResult, 'rawContent'> | MeetingExtractionResult | null
  error: string | null
  meta: Record<string, any>
  readAt: number | null
  dismissedAt: number | null
  createdAt: number
  startedAt: number
  updatedAt: number
  completedAt: number | null
  timeoutAt: number | null
}

export interface PlanTodayDraftResult {
  date: string
  document: Record<string, any>
  sources: {
    taskCount: number
    recommendedTaskCount: number
    carriedBlockCount: number
  }
}

export interface TaskProgressSummary {
  taskId: string
  latestProgress: string
  nextStep: string
  recommendedNextStep: string
  summaryUpdatedAt: number | null
  stale: boolean
  errorMessage: string | null
}

export interface TaskProgressContext {
  taskId: string
  taskTitle: string
  status: TaskStatus
  totalWorkMs: number
  lastActivityAt: number | null
  summary: TaskProgressSummary
}

export interface TaskSummaryTestResult {
  taskId: string
  latestProgress: string
  nextStep: string
  recommendedNextStep: string
  llmCallLogId: string | null
}
