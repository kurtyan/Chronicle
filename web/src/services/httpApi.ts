import axios from 'axios'
import type { AxiosInstance } from 'axios'
import type { ApiInterface } from './apiTypes'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, TaskLogDraft, WorkSession, SearchResult, TaskExtraInfo, AfkEvent, PlanItem, PlanItemDetail, BatchCreatePlanItemsRequest, LlmSettings, MeetingExtractionResult, CreateMeetingRequest, DayScriptDocument, SaveDayScriptResult, TaskProgressContext, TaskSummaryTestResult, DayScriptFocusActivity, DayScriptExecutionRecord, DailySummaryResult, PlanTodayDraftResult } from '@/types'

// Server base URL:
// - Tauri: reads server URL from config via native command (defaults to http://localhost:8080)
// - Web served by the server: uses relative path, works on whatever port the server uses.
// - Dev mode (Vite): relative path, proxied to localhost:8080 by Vite.
// Tauri v2 with withGlobalTauri: true exposes window.__TAURI__
export const isTauriEnv = typeof window !== 'undefined' && !!(window as any).__TAURI__

// Unique client ID — used to avoid echoing own SSE events back
export const clientId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`

let clientPromise: Promise<AxiosInstance> | null = null
export let apiBase = ''

function getClient(): Promise<AxiosInstance> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (isTauriEnv) {
        // Dev mode: devUrl http://localhost → Vite proxies /api to server
        // Production: tauri:// protocol → use configured server URL
        const protocol = window.location.protocol
        if (protocol === 'http:' || protocol === 'https:') {
          apiBase = ''
          return axios.create({ baseURL: '' })
        }
        const { invoke } = await import('@tauri-apps/api/core')
        const serverUrl = await invoke('get_server_url').catch(() => 'http://localhost:8080') as string
        apiBase = serverUrl
        return axios.create({ baseURL: serverUrl })
      }
      apiBase = ''
      return axios.create({ baseURL: '' })
    })()
  }
  return clientPromise
}

let interceptorAdded = false

// Expose client resolution for SSE to wait on
export async function ensureApiReady(): Promise<string> {
  await getClient()
  return apiBase
}

// Axios interceptor to attach X-Client-Id header
async function withClientId(): Promise<AxiosInstance> {
  const client = await getClient()
  if (!interceptorAdded) {
    client.interceptors.request.use((config) => {
      config.headers['X-Client-Id'] = clientId
      return config
    })
    interceptorAdded = true
  }
  return client
}

export const httpApi: ApiInterface = {
  async fetchTodos(type?: string, status?: string): Promise<Task[]> {
    const params: Record<string, string> = {}
    if (status) params.status = status
    else params.status = 'PENDING,DOING'
    if (type) params.type = type
    const { data } = await (await withClientId()).get<Task[]>('/api/tasks', { params })
    return data
  },

  async getNextTaskId(): Promise<string> {
    const { data } = await (await withClientId()).get<{ id: string }>('/api/tasks/next-id')
    return data.id
  },

  async getTaskById(id: string): Promise<Task | null> {
    const { data } = await (await withClientId()).get<Task>(`/api/tasks/${id}`)
    return data
  },

  async createTask(req: CreateTaskRequest): Promise<Task> {
    const { data } = await (await withClientId()).post<Task>('/api/tasks', req)
    return data
  },

  async updateTask(id: string, req: UpdateTaskRequest): Promise<Task | null> {
    const { data } = await (await withClientId()).put<Task>(`/api/tasks/${id}`, req)
    return data
  },

  async deleteTask(id: string): Promise<void> {
    await (await withClientId()).delete(`/api/tasks/${id}`)
  },

  async markTaskDone(id: string): Promise<Task | null> {
    const { data } = await (await withClientId()).put<Task>(`/api/tasks/${id}/done`)
    return data
  },

  async fetchTaskEntries(taskId: string): Promise<TaskEntry[]> {
    const { data } = await (await withClientId()).get<TaskEntry[]>(`/api/tasks/${taskId}/logs`)
    return data
  },

  async submitTaskEntry(taskId: string, content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry> {
    const { data } = await (await withClientId()).post<TaskEntry>(`/api/tasks/${taskId}/logs`, { content, type, silent })
    return data
  },

  async submitTaskEntries(taskIds: string[], content: string, type?: 'body' | 'log', silent?: boolean): Promise<TaskEntry[]> {
    const { data } = await (await withClientId()).post<TaskEntry[]>('/api/tasks/logs/batch', { taskIds, content, type, silent })
    return data
  },

  async updateTaskEntry(taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
    const { data } = await (await withClientId()).put<TaskEntry>(`/api/tasks/${taskId}/logs/${entryId}`, { content })
    return data
  },

  async deleteTaskEntry(taskId: string, entryId: string): Promise<void> {
    await (await withClientId()).delete(`/api/tasks/${taskId}/logs/${entryId}`)
  },

  async fetchTaskLogDraft(taskId: string): Promise<TaskLogDraft | null> {
    const { data } = await (await withClientId()).get<TaskLogDraft | null>(`/api/tasks/${taskId}/log-draft`)
    return data
  },

  async saveTaskLogDraft(taskId: string, content: string): Promise<TaskLogDraft | null> {
    const { data } = await (await withClientId()).put<TaskLogDraft | null>(`/api/tasks/${taskId}/log-draft`, { content })
    return data
  },

  async deleteTaskLogDraft(taskId: string): Promise<void> {
    await (await withClientId()).delete(`/api/tasks/${taskId}/log-draft`)
  },

  async takeOverTask(taskId: string): Promise<WorkSession> {
    const { data } = await (await withClientId()).post<WorkSession>(`/api/tasks/${taskId}/takeover`)
    return data
  },

  async doAfk(): Promise<void> {
    await (await withClientId()).post('/api/afk')
  },

  async getCurrentSession(): Promise<WorkSession | null> {
    const { data } = await (await withClientId()).get<WorkSession | null>('/api/sessions/current')
    return data
  },

  async fetchSessions(start: number, end: number): Promise<WorkSession[]> {
    const { data } = await (await withClientId()).get<WorkSession[]>('/api/sessions', { params: { start, end } })
    return data
  },

  async dropTask(taskId: string, reason: string): Promise<Task | null> {
    const { data } = await (await withClientId()).post<Task>(`/api/tasks/${taskId}/drop`, { reason })
    return data
  },

  async fetchTodayTasks(): Promise<Task[]> {
    const { data } = await (await withClientId()).get<Task[]>('/api/tasks/today')
    return data
  },

  async fetchTodayReport(): Promise<{
    totalToday: number
    completedToday: number
    inProgress: number
    tasks: Task[]
  }> {
    const { data } = await (await withClientId()).get('/api/reports/today')
    return data
  },

  async fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }> {
    const { data } = await (await withClientId()).get('/api/reports/summary')
    return data
  },

  async fetchRangeStats(start: number, end: number): Promise<{
    total: number
    completed: number
    inProgress: number
  }> {
    const { data } = await (await withClientId()).get('/api/reports/range-stats', { params: { start, end } })
    return data
  },

  async searchTasks(query: string, limit = 50): Promise<{
    results: SearchResult[]
    tokens: string[]
    total: number
  }> {
    const { data } = await (await withClientId()).get('/api/search', {
      params: { q: query, limit }
    })
    return data
  },

  // Task Extra Info
  async getTaskExtraInfo(taskId: string): Promise<TaskExtraInfo[]> {
    const { data } = await (await withClientId()).get<TaskExtraInfo[]>(`/api/tasks/${taskId}/extra-info`)
    return data
  },

  async getTaskExtraInfoValue(taskId: string, key: string): Promise<string | null> {
    const { data } = await (await withClientId()).get<{ value: string | null }>(`/api/tasks/${taskId}/extra-info/${key}`)
    return data.value
  },

  async setTaskExtraInfo(taskId: string, key: string, value: string): Promise<TaskExtraInfo> {
    const { data } = await (await withClientId()).put<TaskExtraInfo>(`/api/tasks/${taskId}/extra-info/${key}`, { value })
    return data
  },

  async deleteTaskExtraInfo(taskId: string, key: string): Promise<boolean> {
    const { data } = await (await withClientId()).delete<{ ok: boolean }>(`/api/tasks/${taskId}/extra-info/${key}`)
    return data.ok
  },

  async togglePinned(taskId: string): Promise<boolean> {
    const { data } = await (await withClientId()).post<{ pinned: boolean }>(`/api/tasks/${taskId}/pin`)
    return data.pinned
  },

  async getPinnedTaskIds(): Promise<string[]> {
    const { data } = await (await withClientId()).get<{ ids: string[] }>('/api/tasks/pinned')
    return data.ids
  },

  // AFK Events
  async createAfkEvent(reason: string, triggeredAt: number, userNote?: string): Promise<AfkEvent> {
    const { data } = await (await withClientId()).post<AfkEvent>('/api/afk-events', { reason, triggeredAt, userNote })
    return data
  },

  async updateAfkEvent(id: string, userNote: string): Promise<AfkEvent | null> {
    const { data } = await (await withClientId()).put<AfkEvent>(`/api/afk-events/${id}`, { userNote })
    return data
  },

  async getAfkEvents(start?: number, end?: number): Promise<AfkEvent[]> {
    const params: Record<string, number> = {}
    if (start !== undefined) params.start = start
    if (end !== undefined) params.end = end
    const { data } = await (await withClientId()).get<AfkEvent[]>('/api/afk-events', { params })
    return data
  },

  async fetchReportTasks(params: { start: number; end: number; filter: string; page?: number; pageSize?: number }) {
    const { data } = await (await withClientId()).get('/api/reports/tasks', {
      params: {
        start: params.start,
        end: params.end,
        filter: params.filter,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 50,
      },
    })
    return data
  },

  // Plan Items
  async hasPlanForDate(date: string): Promise<boolean> {
    const { data } = await (await withClientId()).get<{ hasPlan: boolean }>('/api/plan-items/has-plan', { params: { date } })
    return data.hasPlan
  },

  async batchCreatePlanItems(req: BatchCreatePlanItemsRequest): Promise<PlanItem[]> {
    const { data } = await (await withClientId()).post<PlanItem[]>('/api/plan-items/batch', req)
    return data
  },

  async fetchPlanItems(date: string): Promise<PlanItem[]> {
    const { data } = await (await withClientId()).get<PlanItem[]>('/api/plan-items', { params: { date } })
    return data
  },

  async updatePlanItem(detailId: string, body: { status?: string; content?: string; actualStartedAt?: number | null; actualCompletedAt?: number | null; estimatedMinutes?: number; estimatedStart?: string; estimatedEnd?: string; sortOrder?: number }): Promise<PlanItemDetail> {
    const { data } = await (await withClientId()).put<PlanItemDetail>(`/api/plan-items/${detailId}`, body)
    return data
  },

  async deletePlanItem(detailId: string): Promise<void> {
    await (await withClientId()).delete(`/api/plan-items/${detailId}`)
  },

  async clearPlanForDate(date: string): Promise<number> {
    const { data } = await (await withClientId()).delete<{ cleared: number }>('/api/plan-items', { params: { date } })
    return data.cleared
  },

  async fetchUnfinishedPlans(qs: string): Promise<PlanItem[]> {
    const { data } = await (await withClientId()).get<PlanItem[]>(`/api/plans/unfinished${qs}`)
    return data
  },

  async reparentPlanItems(body: { detailIds: string[], newPlanDate: string }): Promise<void> {
    await (await withClientId()).post('/api/plans/reparent', body)
  },

  async getDayScript(date: string): Promise<DayScriptDocument> {
    const { data } = await (await withClientId()).get<DayScriptDocument>(`/api/day-scripts/${encodeURIComponent(date)}`)
    return data
  },

  async saveDayScript(date: string, body: { expectedRevision: number; document: Record<string, any>; focusActivity?: DayScriptFocusActivity[] }): Promise<SaveDayScriptResult> {
    const { data } = await (await withClientId()).put<SaveDayScriptResult>(`/api/day-scripts/${encodeURIComponent(date)}`, body)
    return data
  },

  async confirmDayScriptProgressSync(date: string, items: Array<{ blockId: string; taskId: string }>): Promise<{ createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> }> {
    const { data } = await (await withClientId()).post(`/api/day-scripts/${encodeURIComponent(date)}/confirm-progress-sync`, { items })
    return data
  },

  async getDayScriptExecutionRecords(date: string, filters?: { taskId?: string; start?: number; end?: number }): Promise<DayScriptExecutionRecord[]> {
    const { data } = await (await withClientId()).get<DayScriptExecutionRecord[]>(`/api/day-scripts/${encodeURIComponent(date)}/execution-records`, { params: filters })
    return data
  },

  async generateDailySummary(date: string, body: { refresh?: boolean; mode?: 'record' | 'test' } = {}): Promise<DailySummaryResult> {
    const { data } = await (await withClientId()).post<DailySummaryResult>(`/api/day-scripts/${encodeURIComponent(date)}/daily-summary`, body)
    return data
  },

  async buildPlanTodayDraft(date: string): Promise<PlanTodayDraftResult> {
    const { data } = await (await withClientId()).post<PlanTodayDraftResult>(`/api/day-scripts/${encodeURIComponent(date)}/plan-today-draft`)
    return data
  },

  async getTaskContexts(status?: string): Promise<TaskProgressContext[]> {
    const params = status ? { status } : undefined
    const { data } = await (await withClientId()).get<TaskProgressContext[]>('/api/task-context', { params })
    return data
  },

  async refreshTaskContexts(taskIds?: string[]): Promise<TaskProgressContext[]> {
    const { data } = await (await withClientId()).post<TaskProgressContext[]>('/api/task-context/summarize', { taskIds })
    return data
  },

  async testTaskSummaryPrompt(taskId: string): Promise<TaskSummaryTestResult> {
    const { data } = await (await withClientId()).post<TaskSummaryTestResult>('/api/task-context/test-summary', { taskId })
    return data
  },

  async fetchStartOfDayOffset(): Promise<number> {
    const { data } = await (await withClientId()).get<{ offset: number }>('/api/settings/start-of-day-offset')
    return data.offset
  },

  async setStartOfDayOffset(offset: number): Promise<number> {
    const { data } = await (await withClientId()).put<{ offset: number }>('/api/settings/start-of-day-offset', { offset })
    return data.offset
  },

  async fetchLlmSettings(): Promise<LlmSettings> {
    const { data } = await (await withClientId()).get<LlmSettings>('/api/settings/llm')
    return data
  },

  async saveLlmSettings(settings: Partial<LlmSettings>): Promise<LlmSettings> {
    const { data } = await (await withClientId()).put<LlmSettings>('/api/settings/llm', settings)
    return data
  },

  async testLlmConnection(): Promise<{ ok: boolean; latencyMs?: number; model?: string; error?: string }> {
    const { data } = await (await withClientId()).post('/api/settings/llm/test-connection')
    return data
  },

  async extractMeeting(rawContent: string, mode: 'record' | 'test' = 'record'): Promise<MeetingExtractionResult> {
    const { data } = await (await withClientId()).post<MeetingExtractionResult>('/api/meetings/extract', { rawContent, mode })
    return data
  },

  async createMeeting(req: CreateMeetingRequest): Promise<Task> {
    const { data } = await (await withClientId()).post<Task>('/api/meetings', req)
    return data
  },
}
