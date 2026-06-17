import type { ApiInterface } from './apiTypes'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, TaskLogDraft, WorkSession, SearchResult, TaskExtraInfo, AfkEvent, PlanItem, PlanItemDetail, BatchCreatePlanItemsRequest, LlmSettings, MeetingExtractionResult, CreateMeetingRequest, DayScriptDocument, SaveDayScriptResult, SubmitDayScriptProgressResult, TaskProgressContext, TaskSummaryTestResult, DayScriptFocusActivity, DayScriptExecutionRecord, DailySummaryResult, DailySummaryCacheResult, PlanTodayDraftResult, BackgroundTask, BackgroundTaskStatus } from '@/types'

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
export async function getNextTaskId(): Promise<string> {
  return (await getApi()).getNextTaskId()
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
export async function submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry> {
  return (await getApi()).submitTaskEntry(taskId, content, type, silent)
}
export async function submitTaskEntries(taskIds: string[], content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry[]> {
  return (await getApi()).submitTaskEntries(taskIds, content, type, silent)
}
export async function updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
  return (await getApi()).updateTaskEntry(taskId, entryId, content)
}
export async function deleteTaskEntry(taskId: string, entryId: string): Promise<void> {
  return (await getApi()).deleteTaskEntry(taskId, entryId)
}
export async function fetchTaskLogDraft(taskId: string): Promise<TaskLogDraft | null> {
  return (await getApi()).fetchTaskLogDraft(taskId)
}
export async function saveTaskLogDraft(taskId: string, content: string): Promise<TaskLogDraft | null> {
  return (await getApi()).saveTaskLogDraft(taskId, content)
}
export async function deleteTaskLogDraft(taskId: string): Promise<void> {
  return (await getApi()).deleteTaskLogDraft(taskId)
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

// Task Extra Info
export async function getTaskExtraInfo(taskId: string): Promise<TaskExtraInfo[]> {
  return (await getApi()).getTaskExtraInfo(taskId)
}
export async function getTaskExtraInfoValue(taskId: string, key: string): Promise<string | null> {
  return (await getApi()).getTaskExtraInfoValue(taskId, key)
}
export async function setTaskExtraInfo(taskId: string, key: string, value: string): Promise<TaskExtraInfo> {
  return (await getApi()).setTaskExtraInfo(taskId, key, value)
}
export async function deleteTaskExtraInfo(taskId: string, key: string): Promise<boolean> {
  return (await getApi()).deleteTaskExtraInfo(taskId, key)
}
export async function togglePinned(taskId: string): Promise<boolean> {
  return (await getApi()).togglePinned(taskId)
}
export async function getPinnedTaskIds(): Promise<string[]> {
  return (await getApi()).getPinnedTaskIds()
}

// AFK Events
export async function createAfkEvent(reason: string, triggeredAt: number, userNote?: string): Promise<AfkEvent> {
  return (await getApi()).createAfkEvent(reason, triggeredAt, userNote)
}
export async function updateAfkEventApi(id: string, userNote: string): Promise<AfkEvent | null> {
  return (await getApi()).updateAfkEvent(id, userNote)
}
export async function getAfkEvents(start?: number, end?: number): Promise<AfkEvent[]> {
  return (await getApi()).getAfkEvents(start, end)
}

export async function fetchReportTasks(params: { start: number; end: number; filter: string; page?: number; pageSize?: number }) {
  return (await getApi()).fetchReportTasks(params)
}

// Plan Items
export async function hasPlanForDate(date: string): Promise<boolean> {
  return (await getApi()).hasPlanForDate(date)
}
export async function batchCreatePlanItems(req: BatchCreatePlanItemsRequest): Promise<PlanItem[]> {
  return (await getApi()).batchCreatePlanItems(req)
}
export async function fetchPlanItems(date: string): Promise<PlanItem[]> {
  return (await getApi()).fetchPlanItems(date)
}
export async function updatePlanItem(detailId: string, data: { status?: string; content?: string; actualStartedAt?: number | null; actualCompletedAt?: number | null; estimatedMinutes?: number; estimatedStart?: string; estimatedEnd?: string; sortOrder?: number }): Promise<PlanItemDetail> {
  return (await getApi()).updatePlanItem(detailId, data)
}
export async function deletePlanItem(detailId: string): Promise<void> {
  return (await getApi()).deletePlanItem(detailId)
}
export async function clearPlanForDate(date: string): Promise<number> {
  return (await getApi()).clearPlanForDate(date)
}
export async function fetchUnfinishedPlans(beforeDate?: string): Promise<PlanItem[]> {
  const qs = beforeDate ? `?before=${encodeURIComponent(beforeDate)}` : ''
  return (await getApi()).fetchUnfinishedPlans(qs)
}
export async function reparentPlanItems(detailIds: string[], newPlanDate: string): Promise<void> {
  return (await getApi()).reparentPlanItems({ detailIds, newPlanDate })
}
export async function getDayScript(date: string): Promise<DayScriptDocument> {
  return (await getApi()).getDayScript(date)
}
export async function saveDayScript(date: string, body: { expectedRevision: number; document: Record<string, any>; focusActivity?: DayScriptFocusActivity[] }): Promise<SaveDayScriptResult> {
  return (await getApi()).saveDayScript(date, body)
}
export async function submitDayScriptProgress(date: string, body?: { focusActivity?: DayScriptFocusActivity[] }): Promise<SubmitDayScriptProgressResult> {
  return (await getApi()).submitDayScriptProgress(date, body)
}
export async function confirmDayScriptProgressSync(date: string, items: Array<{ blockId: string; taskId: string }>): Promise<{ createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> }> {
  return (await getApi()).confirmDayScriptProgressSync(date, items)
}
export async function getDayScriptExecutionRecords(date: string, filters?: { taskId?: string; start?: number; end?: number }): Promise<DayScriptExecutionRecord[]> {
  return (await getApi()).getDayScriptExecutionRecords(date, filters)
}
export async function generateDailySummary(date: string, body?: { refresh?: boolean; mode?: 'record' | 'test' }): Promise<DailySummaryResult> {
  return (await getApi()).generateDailySummary(date, body)
}
export async function fetchDailySummaryCache(date: string): Promise<DailySummaryCacheResult | null> {
  return (await getApi()).fetchDailySummaryCache(date)
}
export async function generateDailySummaryInBackground(date: string): Promise<BackgroundTask> {
  return (await getApi()).generateDailySummaryInBackground(date)
}
export async function buildPlanTodayDraft(date: string): Promise<PlanTodayDraftResult> {
  return (await getApi()).buildPlanTodayDraft(date)
}
export async function fetchTaskContexts(status = 'PENDING,DOING'): Promise<TaskProgressContext[]> {
  return (await getApi()).getTaskContexts(status)
}
export async function refreshTaskContexts(taskIds?: string[]): Promise<TaskProgressContext[]> {
  return (await getApi()).refreshTaskContexts(taskIds)
}
export async function testTaskSummaryPrompt(taskId: string): Promise<TaskSummaryTestResult> {
  return (await getApi()).testTaskSummaryPrompt(taskId)
}

// Start of day offset
export async function fetchStartOfDayOffset(): Promise<number> {
  return (await getApi()).fetchStartOfDayOffset()
}
export async function setStartOfDayOffset(offset: number): Promise<number> {
  return (await getApi()).setStartOfDayOffset(offset)
}
export async function fetchLlmSettings(): Promise<LlmSettings> {
  return (await getApi()).fetchLlmSettings()
}
export async function saveLlmSettings(settings: Partial<LlmSettings>): Promise<LlmSettings> {
  return (await getApi()).saveLlmSettings(settings)
}
export async function testLlmConnection(): Promise<{ ok: boolean; latencyMs?: number; model?: string; error?: string }> {
  return (await getApi()).testLlmConnection()
}
export async function extractMeeting(rawContent: string, mode?: 'record' | 'test'): Promise<MeetingExtractionResult> {
  return (await getApi()).extractMeeting(rawContent, mode)
}
export async function extractMeetingInBackground(rawContent: string, mode: 'record' | 'test', draftHash: string): Promise<BackgroundTask> {
  return (await getApi()).extractMeetingInBackground(rawContent, mode, draftHash)
}
export async function createMeeting(req: CreateMeetingRequest): Promise<Task> {
  return (await getApi()).createMeeting(req)
}
export async function fetchBackgroundTasks(options?: { status?: BackgroundTaskStatus | 'all'; includeDismissed?: boolean; limit?: number }): Promise<BackgroundTask[]> {
  return (await getApi()).fetchBackgroundTasks(options)
}
export async function fetchBackgroundTask(id: string): Promise<BackgroundTask> {
  return (await getApi()).fetchBackgroundTask(id)
}
export async function markBackgroundTaskRead(id: string): Promise<BackgroundTask> {
  return (await getApi()).markBackgroundTaskRead(id)
}
export async function dismissBackgroundTask(id: string): Promise<BackgroundTask> {
  return (await getApi()).dismissBackgroundTask(id)
}
export async function consumeBackgroundTask(id: string, meta: Record<string, unknown>): Promise<BackgroundTask> {
  return (await getApi()).consumeBackgroundTask(id, meta)
}
