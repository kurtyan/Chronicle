import { create } from 'zustand'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, TaskType, Priority, WorkSession } from '@/types'
import * as api from '@/services/api'

export interface DraftTask {
  title: string
  body: string
  type: TaskType
  priority: Priority
  tags: string[]
  dueDate: number | null
}

interface TaskState {
  tasks: Task[]
  loading: boolean
  error: string | null
  activeTaskId: string | null
  entries: TaskEntry[]
  entryLoading: boolean
  filterTypes: TaskType[]
  statusFilter: 'DONE' | 'DROPPED' | null
  isTodayFilter: boolean
  savedFilterTypes: TaskType[]
  draftTask: DraftTask | null
  currentSession: WorkSession | null
  previousActiveTaskId: string | null

  loadTodos: () => Promise<void>
  setActiveTask: (id: string | null) => Promise<void>
  createTask: (req: CreateTaskRequest) => Promise<Task>
  updateTask: (id: string, req: UpdateTaskRequest) => Promise<Task | null>
  deleteTask: (id: string) => Promise<void>
  markDone: (id: string) => Promise<Task | null>
  submitEntry: (taskId: string, content: string, type?: 'body' | 'log') => Promise<TaskEntry>
  updateEntry: (taskId: string, entryId: string, content: string) => Promise<TaskEntry | null>
  setFilterTypes: (types: TaskType[]) => void
  toggleFilterType: (type: TaskType) => void
  setStatusFilter: (filter: 'DONE' | 'DROPPED' | null) => void
  setTodayFilter: (on: boolean) => void
  startDraft: (data: DraftTask) => void
  commitDraft: () => Promise<void>
  cancelDraft: () => void
  takeOver: (taskId: string) => Promise<WorkSession>
  doAfk: () => Promise<void>
  autoTakeOver: (taskId: string) => Promise<void>
  doDrop: (id: string, reason: string) => Promise<Task | null>
  loadCurrentSession: () => Promise<void>
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  activeTaskId: null,
  entries: [],
  entryLoading: false,
  filterTypes: [],
  statusFilter: null,
  isTodayFilter: false,
  savedFilterTypes: [],
  draftTask: null,
  currentSession: null,
  previousActiveTaskId: null,

  loadTodos: async () => {
    set({ loading: true, error: null })
    try {
      const { filterTypes, statusFilter, isTodayFilter } = get()
      let tasks: Task[]
      if (isTodayFilter) {
        tasks = await api.fetchTodayTasks()
      } else if (statusFilter === 'DONE') {
        tasks = await api.fetchTodos(undefined, 'DONE')
      } else if (statusFilter === 'DROPPED') {
        tasks = await api.fetchTodos(undefined, 'DROPPED')
      } else {
        // statusFilter === null: show non-done/non-dropped
        const typesParam = filterTypes.length > 0 ? filterTypes.join(',') : undefined
        tasks = await api.fetchTodos(typesParam, 'PENDING,DOING')
      }
      set({ tasks, loading: false })
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to load tasks', loading: false })
    }
  },

  setActiveTask: async (id) => {
    set({ activeTaskId: id, entryLoading: true })
    try {
      const entries = id ? await api.fetchTaskEntries(id) : []
      set({ entries, entryLoading: false })
    } catch {
      set({ entries: [], entryLoading: false })
    }
  },

  createTask: async (req) => {
    const task = await api.createTask(req)
    set((state) => ({ tasks: [...state.tasks, task].sort((a, b) => b.updatedAt - a.updatedAt) }))
    return task
  },

  updateTask: async (id, req) => {
    const updated = await api.updateTask(id, req)
    if (!updated) return null
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? updated : t)).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    return updated
  },

  deleteTask: async (id) => {
    await api.deleteTask(id)
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
      entries: state.activeTaskId === id ? [] : state.entries,
    }))
  },

  markDone: async (id) => {
    const { currentSession } = get()
    if (currentSession?.taskId === id) {
      await api.doAfk()
      set({ currentSession: null })
    }
    const updated = await api.markTaskDone(id)
    if (!updated) return null
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? updated : t)).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    return updated
  },

  submitEntry: async (taskId, content, type) => {
    const entry = await api.submitTaskEntry(taskId, content, type)
    set((state) => ({
      entries: [...state.entries, entry],
    }))
    return entry
  },

  updateEntry: async (taskId, entryId, content) => {
    const entry = await api.updateTaskEntry(taskId, entryId, content)
    if (!entry) return null
    set((state) => ({
      entries: state.entries.map((e) => (e.id === entryId ? entry : e)),
    }))
    return entry
  },

  setFilterTypes: (types) => set({ filterTypes: types }),

  toggleFilterType: (type) => {
    const { filterTypes } = get()
    const next = filterTypes.includes(type)
      ? filterTypes.filter((t) => t !== type)
      : [...filterTypes, type]
    set({ filterTypes: next })
  },

  setStatusFilter: (filter) => set({ statusFilter: filter }),

  setTodayFilter: (on) => {
    const { isTodayFilter, filterTypes } = get()
    if (on && !isTodayFilter) {
      // Save current filterTypes before entering Today view
      set({ isTodayFilter: true, savedFilterTypes: [...filterTypes] })
    } else if (!on && isTodayFilter) {
      // Restore previous filterTypes when exiting Today view
      set({ isTodayFilter: false, filterTypes: get().savedFilterTypes })
    }
  },

  startDraft: (data) => set({ draftTask: data }),

  commitDraft: async () => {
    const { draftTask } = get()
    if (!draftTask || !draftTask.title.trim()) return
    const task = await api.createTask({
      title: draftTask.title.trim(),
      type: draftTask.type,
      priority: draftTask.priority,
      tags: draftTask.tags,
      dueDate: draftTask.dueDate ?? undefined,
      body: draftTask.body.trim() || undefined,
    })
    // No auto-takeOver — task stays PENDING
    set((state) => ({
      tasks: [...state.tasks, task].sort((a, b) => b.updatedAt - a.updatedAt),
      draftTask: null,
      activeTaskId: task.id,
      previousActiveTaskId: null,
    }))
    // Reload entries for the new task
    const entries = await api.fetchTaskEntries(task.id)
    set({ entries })
  },

  cancelDraft: () => set({ draftTask: null }),

  takeOver: async (taskId) => {
    // If task is PENDING, update status to DOING
    const task = get().tasks.find((t) => t.id === taskId)
    if (task?.status === 'PENDING') {
      const updated = await api.updateTask(taskId, { status: 'DOING' })
      if (updated) {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        }))
      }
    }
    const session = await api.takeOverTask(taskId)
    set({ currentSession: session })
    return session
  },

  doAfk: async () => {
    await api.doAfk()
    set({ currentSession: null })
  },

  autoTakeOver: async (taskId) => {
    const { currentSession } = get()
    if (currentSession?.taskId === taskId) return

    if (currentSession) {
      await api.doAfk()
      set({ currentSession: null })
    }

    const session = await api.takeOverTask(taskId)
    set({ currentSession: session })
  },

  doDrop: async (id, reason) => {
    const task = await api.dropTaskApi(id, reason)
    if (!task) return null
    set((state) => ({
      tasks: (state.statusFilter === 'DROPPED'
        ? state.tasks.map((t) => (t.id === id ? task : t))
        : state.tasks.filter((t) => t.id !== id)
      ).sort((a, b) => b.updatedAt - a.updatedAt),
      activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
      entries: state.activeTaskId === id ? [] : state.entries,
      currentSession: state.currentSession?.taskId === id ? null : state.currentSession,
    }))
    return task
  },

  loadCurrentSession: async () => {
    try {
      const session = await api.getCurrentSession()
      set({ currentSession: session })
    } catch {
      // ignore
    }
  },
}))
