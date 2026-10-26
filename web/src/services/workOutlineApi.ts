import { withClientId } from './httpApi'
import { translateCurrent } from '@/i18n/runtime'
import type { Task, CreateTaskRequest } from '@/types'
import type { OutlineDocument, WorkOutline, SaveOutlineResult } from '../../../shared/workOutlineTypes'
export type { OutlineDocument, OutlineLine } from '../../../shared/workOutlineTypes'

export interface CreateOutlineTaskResult {
  task: Task; epoch: string; rowId: string; outlineRevision: number; updatedAt: number
  bindingPatch: { rowId: string; taskId: string; label: string }
}
export type { TaskDaysResponse, TaskDayDetails } from '../../../shared/taskDailySummaryTypes'
import type { TaskDaysResponse, TaskDayDetails } from '../../../shared/taskDailySummaryTypes'

export async function outlineRequest<T>(method: 'get' | 'post' | 'put', url: string, body?: unknown): Promise<T> {
  const { data } = await (await withClientId()).request<T>({ method, url, ...(method === 'get' ? { params: body } : { data: body }) })
  return data
}
export const workOutlineApi = {
  load: () => outlineRequest<WorkOutline>('get', '/api/work-outlines/default'),
  save: (id: string, document: OutlineDocument, expectedRevision: number, mutationId: string, expectedEpoch: string) =>
    outlineRequest<SaveOutlineResult>('put', `/api/work-outlines/${encodeURIComponent(id)}`, { document, expectedRevision, mutationId, expectedEpoch }),
  createTask: (id: string, rowId: string, task: CreateTaskRequest, expectedRevision: number, idempotencyKey: string, expectedEpoch: string) =>
    outlineRequest<CreateOutlineTaskResult>('post', `/api/work-outlines/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}/task`, { task, expectedRevision, idempotencyKey, expectedEpoch }),
  days: (taskIds: string[], fromDate?: string, toDate?: string) => outlineRequest<TaskDaysResponse>('post', '/api/task-days/query', { taskIds, ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}), includeTotals: true }),
  day: (taskId: string, date: string, cursor?: string) => outlineRequest<TaskDayDetails>('get', `/api/tasks/${encodeURIComponent(taskId)}/days/${date}`, cursor ? { cursor } : undefined),
  refresh: (taskId: string, date: string) => outlineRequest<{ jobId?: string; status?: string }>('post', `/api/tasks/${encodeURIComponent(taskId)}/days/${date}/summary-refresh`),
}

export function outlineError(error: unknown): string {
  const value = error as { response?: { data?: { error?: unknown } }; message?: unknown }
  return typeof value?.response?.data?.error === 'string' ? value.response.data.error
    : typeof value?.message === 'string' ? value.message : translateCurrent('outline.error.generic')
}
