import { create } from 'zustand'
import { consumeBackgroundTask, dismissBackgroundTask, fetchBackgroundTasks, markBackgroundTaskRead } from '@/services/api'
import type { BackgroundTask, BackgroundTaskStatus, BackgroundTaskType } from '@/types'

export type { BackgroundTask, BackgroundTaskStatus, BackgroundTaskType }

export interface BackgroundTaskToast {
  id: string
  taskId: string
  title: string
  status: 'success' | 'error'
  createdAt: number
}

export const BACKGROUND_TASK_TOAST_TTL_MS = 3000
export const BACKGROUND_TASK_MAX_TOASTS = 5

interface BackgroundTaskState {
  tasks: BackgroundTask[]
  panelOpen: boolean
  selectedTaskId: string | null
  statusFilter: BackgroundTaskStatus | 'all'
  toasts: BackgroundTaskToast[]
  loading: boolean
  loadTasks: (options?: { includeDismissed?: boolean }) => Promise<void>
  upsertTask: (task: BackgroundTask, options?: { notify?: boolean }) => void
  setTasks: (tasks: BackgroundTask[]) => void
  setPanelOpen: (open: boolean) => void
  setStatusFilter: (status: BackgroundTaskStatus | 'all') => void
  selectTask: (id: string | null) => void
  markRead: (id: string) => Promise<void>
  dismissTask: (id: string) => Promise<void>
  consumeTask: (id: string, meta: Record<string, unknown>) => Promise<void>
  removeToast: (id: string) => void
}

function sortTasks(tasks: BackgroundTask[]): BackgroundTask[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
}

function shouldNotify(previous: BackgroundTask | undefined, next: BackgroundTask): boolean {
  if (next.dismissedAt) return false
  if (next.status !== 'success' && next.status !== 'error') return false
  return !previous || previous.status === 'running'
}

function sortToasts(toasts: BackgroundTaskToast[]): BackgroundTaskToast[] {
  return [...toasts].sort((a, b) => b.createdAt - a.createdAt)
}

function addToast(current: BackgroundTaskToast[], toast: BackgroundTaskToast): BackgroundTaskToast[] {
  const now = Date.now()
  const activeToasts = current.filter((item) => now - item.createdAt < BACKGROUND_TASK_TOAST_TTL_MS && item.id !== toast.id)
  return sortToasts([toast, ...activeToasts]).slice(0, BACKGROUND_TASK_MAX_TOASTS)
}

export function dailySummarySourceKey(date: string): string {
  return `daily_summary:${date}`
}

export function meetingExtractSourceKey(mode: 'record' | 'test', draftHash: string): string {
  return `meeting_extract:${mode}:${draftHash}`
}

export function taskSummarySourceKey(taskId: string): string {
  return `task_summary:${taskId}`
}

export const useBackgroundTaskStore = create<BackgroundTaskState>((set, get) => ({
  tasks: [],
  panelOpen: false,
  selectedTaskId: null,
  statusFilter: 'all',
  toasts: [],
  loading: false,

  loadTasks: async ({ includeDismissed = false } = {}) => {
    set({ loading: true })
    try {
      const tasks = await fetchBackgroundTasks({ status: 'all', includeDismissed, limit: 100 })
      set({ tasks: sortTasks(tasks), loading: false })
    } catch {
      set({ loading: false })
    }
  },

  upsertTask: (task, options = {}) => set((state) => {
    const previous = state.tasks.find((item) => item.id === task.id)
    if (task.dismissedAt) {
      return {
        tasks: state.tasks.filter((item) => item.id !== task.id),
        selectedTaskId: state.selectedTaskId === task.id ? null : state.selectedTaskId,
        toasts: state.toasts.filter((toast) => toast.taskId !== task.id),
      }
    }
    const tasks = sortTasks([task, ...state.tasks.filter((item) => item.id !== task.id)])
    const toast = options.notify && shouldNotify(previous, task)
      ? {
          id: `${task.id}:${task.status}:${task.updatedAt}`,
          taskId: task.id,
          title: task.title,
          status: task.status as 'success' | 'error',
          createdAt: Date.now(),
        }
      : null
    return {
      tasks,
      toasts: toast ? addToast(state.toasts, toast) : state.toasts,
    }
  }),

  setTasks: (tasks) => set({ tasks: sortTasks(tasks) }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),

  markRead: async (id) => {
    const task = await markBackgroundTaskRead(id)
    get().upsertTask(task)
  },

  dismissTask: async (id) => {
    await dismissBackgroundTask(id)
    set((state) => ({
      tasks: state.tasks.filter((item) => item.id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
      toasts: state.toasts.filter((toast) => toast.taskId !== id),
    }))
  },

  consumeTask: async (id, meta) => {
    const task = await consumeBackgroundTask(id, meta)
    get().upsertTask(task)
  },

  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))
