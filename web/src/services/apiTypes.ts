import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, TaskLogDraft, AgentConversation, WorkSession, SearchResult, TaskExtraInfo, AfkEvent, LlmSettings, MeetingExtractionResult, CreateMeetingRequest, DayScriptBlock, DayScriptDocument, SaveDayScriptResult, SubmitDayScriptProgressResult, TaskProgressContext, TaskSummaryTestResult, DayScriptFocusActivity, DayScriptExecutionRecord, DailySummaryResult, DailySummaryCacheResult, PlanTodayDraftResult, BackgroundTask, BackgroundTaskStatus, WorkOverviewHiddenSignal, WorkOverviewHidableSignalSourceType, Note, CreateNoteRequest, UpdateNoteRequest, NoteSearchResult, GlobalSearchResponse } from '@/types'

export interface ApiInterface {
  fetchTodos(type?: string, status?: string): Promise<Task[]>
  reserveTaskId(): Promise<string>
  getTaskById(id: string): Promise<Task | null>
  createTask(req: CreateTaskRequest): Promise<Task>
  updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null>
  deleteTask(id: string): Promise<void>
  markTaskDone(id: string): Promise<Task | null>
  fetchTaskEntries(taskId: string): Promise<TaskEntry[]>
  submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry>
  submitTaskEntries(taskIds: string[], content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry[]>
  fetchTaskAgentConversations(taskId: string): Promise<AgentConversation[]>
  updateTaskEntry(taskId: string, entryId: string, content: string, type?: 'body' | 'log'): Promise<TaskEntry | null>
  deleteTaskEntry(taskId: string, entryId: string): Promise<void>
  fetchPinnedEntry(taskId: string): Promise<TaskEntry | null>
  appendToPinnedEntry(taskId: string, content: string): Promise<TaskEntry>
  unpinEntry(taskId: string, entryId: string): Promise<TaskEntry | null>
  fetchTaskLogDraft(taskId: string): Promise<TaskLogDraft | null>
  saveTaskLogDraft(taskId: string, content: string): Promise<TaskLogDraft | null>
  deleteTaskLogDraft(taskId: string): Promise<void>
  takeOverTask(taskId: string): Promise<WorkSession>
  resumeTaskFromAfk(taskId: string, startedAt: number): Promise<WorkSession>
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
  searchAll(query: string, limit?: number): Promise<GlobalSearchResponse>
  searchNotes(query: string, limit?: number): Promise<{
    results: NoteSearchResult[]
    tokens: string[]
    total: number
  }>
  fetchNotes(options?: { includeArchived?: boolean; query?: string; limit?: number }): Promise<Note[]>
  getNoteById(id: string): Promise<Note | null>
  createNote(req: CreateNoteRequest): Promise<Note>
  updateNote(id: string, req: UpdateNoteRequest): Promise<Note | null>
  archiveNote(id: string): Promise<Note | null>
  unarchiveNote(id: string): Promise<Note | null>
  deleteNote(id: string): Promise<void>
  appendToNote(id: string, contentHtml: string, source?: { taskId?: string; entryId?: string; label?: string }): Promise<Note>
  createNoteFromTask(taskId: string): Promise<Note>
  addTaskEntryToNote(taskId: string, entryId: string, noteId?: string): Promise<Note>
  fetchTaskNotes(taskId: string): Promise<Note[]>
  fetchNoteTasks(noteId: string): Promise<Task[]>
  // Task Extra Info
  getTaskExtraInfo(taskId: string): Promise<TaskExtraInfo[]>
  getTaskExtraInfoValue(taskId: string, key: string): Promise<string | null>
  setTaskExtraInfo(taskId: string, key: string, value: string): Promise<TaskExtraInfo>
  deleteTaskExtraInfo(taskId: string, key: string): Promise<boolean>
  togglePinned(taskId: string): Promise<boolean>
  getPinnedTaskIds(): Promise<string[]>
  // AFK Events
  createAfkEvent(reason: string, triggeredAt: number, userNote?: string, submittedAt?: number): Promise<AfkEvent>
  updateAfkEvent(id: string, userNote: string): Promise<AfkEvent | null>
  getAfkEvents(start?: number, end?: number): Promise<AfkEvent[]>
  // Report tasks
  fetchReportTasks(params: { start: number; end: number; filter: string; page?: number; pageSize?: number }): Promise<{
    items: any[]
    total: number
    hasMore: boolean
  }>
  getDayScript(date: string): Promise<DayScriptDocument>
  getCarryOverDayScriptBlocks(date: string): Promise<DayScriptBlock[]>
  saveDayScript(date: string, body: { expectedRevision: number; document: Record<string, any>; focusActivity?: DayScriptFocusActivity[] }): Promise<SaveDayScriptResult>
  submitDayScriptProgress(date: string, body?: { focusActivity?: DayScriptFocusActivity[] }): Promise<SubmitDayScriptProgressResult>
  rescheduleDayScriptFocus(date: string, body: { expectedRevision: number; sortOrders: number[] }): Promise<{ script: DayScriptDocument; changed: boolean }>
  confirmDayScriptProgressSync(date: string, items: Array<{ blockId: string; taskId: string }>): Promise<{ createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> }>
  getDayScriptExecutionRecords(date: string, filters?: { taskId?: string; start?: number; end?: number }): Promise<DayScriptExecutionRecord[]>
  generateDailySummary(date: string, body?: { refresh?: boolean; mode?: 'record' | 'test' }): Promise<DailySummaryResult>
  fetchDailySummaryCache(date: string): Promise<DailySummaryCacheResult | null>
  generateDailySummaryInBackground(date: string): Promise<BackgroundTask>
  buildPlanTodayDraft(date: string): Promise<PlanTodayDraftResult>
  fetchWorkOverviewHiddenSignals(): Promise<WorkOverviewHiddenSignal[]>
  hideWorkOverviewSignal(input: { taskId: string; sourceType: WorkOverviewHidableSignalSourceType; signalKey: string }): Promise<WorkOverviewHiddenSignal>
  getTaskContexts(status?: string): Promise<TaskProgressContext[]>
  refreshTaskContexts(taskIds?: string[]): Promise<TaskProgressContext[]>
  testTaskSummaryPrompt(taskId: string): Promise<TaskSummaryTestResult>
  fetchStartOfDayOffset(): Promise<number>
  setStartOfDayOffset(offset: number): Promise<number>
  fetchLlmSettings(): Promise<LlmSettings>
  saveLlmSettings(settings: Partial<LlmSettings>): Promise<LlmSettings>
  testLlmConnection(): Promise<{ ok: boolean; latencyMs?: number; model?: string; error?: string }>
  extractMeeting(rawContent: string, mode?: 'record' | 'test'): Promise<MeetingExtractionResult>
  extractMeetingInBackground(rawContent: string, mode: 'record' | 'test', draftHash: string): Promise<BackgroundTask>
  createMeeting(req: CreateMeetingRequest): Promise<Task>
  fetchBackgroundTasks(options?: { status?: BackgroundTaskStatus | 'all'; includeDismissed?: boolean; limit?: number }): Promise<BackgroundTask[]>
  fetchBackgroundTask(id: string): Promise<BackgroundTask>
  markBackgroundTaskRead(id: string): Promise<BackgroundTask>
  dismissBackgroundTask(id: string): Promise<BackgroundTask>
  consumeBackgroundTask(id: string, meta: Record<string, unknown>): Promise<BackgroundTask>
}
