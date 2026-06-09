import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession, SearchResult, TaskExtraInfo, AfkEvent, PlanItem, PlanItemDetail, BatchCreatePlanItemsRequest, LlmSettings, MeetingExtractionResult, CreateMeetingRequest, DayScriptDocument, SaveDayScriptResult, TaskProgressContext } from '@/types'

export interface ApiInterface {
  fetchTodos(type?: string, status?: string): Promise<Task[]>
  getNextTaskId(): Promise<string>
  getTaskById(id: string): Promise<Task | null>
  createTask(req: CreateTaskRequest): Promise<Task>
  updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null>
  deleteTask(id: string): Promise<void>
  markTaskDone(id: string): Promise<Task | null>
  fetchTaskEntries(taskId: string): Promise<TaskEntry[]>
  submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry>
  submitTaskEntries(taskIds: string[], content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry[]>
  updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null>
  deleteTaskEntry(taskId: string, entryId: string): Promise<void>
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
  // Report tasks
  fetchReportTasks(params: { start: number; end: number; filter: string; page?: number; pageSize?: number }): Promise<{
    items: any[]
    total: number
    hasMore: boolean
  }>
  // Plan Items
  hasPlanForDate(date: string): Promise<boolean>
  batchCreatePlanItems(req: BatchCreatePlanItemsRequest): Promise<PlanItem[]>
  fetchPlanItems(date: string): Promise<PlanItem[]>
  updatePlanItem(detailId: string, data: { status?: string; content?: string; actualStartedAt?: number | null; actualCompletedAt?: number | null; estimatedMinutes?: number; estimatedStart?: string; estimatedEnd?: string; sortOrder?: number }): Promise<PlanItemDetail>
  deletePlanItem(detailId: string): Promise<void>
  clearPlanForDate(date: string): Promise<number>
  fetchUnfinishedPlans(qs: string): Promise<PlanItem[]>
  reparentPlanItems(body: { detailIds: string[], newPlanDate: string }): Promise<void>
  getDayScript(date: string): Promise<DayScriptDocument>
  saveDayScript(date: string, body: { expectedRevision: number; document: Record<string, any> }): Promise<SaveDayScriptResult>
  confirmDayScriptProgressSync(date: string, items: Array<{ blockId: string; taskId: string }>): Promise<{ createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> }>
  getTaskContexts(status?: string): Promise<TaskProgressContext[]>
  refreshTaskContexts(taskIds?: string[]): Promise<TaskProgressContext[]>
  fetchStartOfDayOffset(): Promise<number>
  setStartOfDayOffset(offset: number): Promise<number>
  fetchLlmSettings(): Promise<LlmSettings>
  saveLlmSettings(settings: Partial<LlmSettings>): Promise<LlmSettings>
  testLlmConnection(): Promise<{ ok: boolean; latencyMs?: number; model?: string; error?: string }>
  extractMeeting(rawContent: string, mode?: 'record' | 'test'): Promise<MeetingExtractionResult>
  createMeeting(req: CreateMeetingRequest): Promise<Task>
}
