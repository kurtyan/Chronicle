import { create } from 'zustand'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, TaskType, Priority, WorkSession, SearchResult } from '@/types'
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
  pinnedIds: Set<string>
  loading: boolean
  error: string | null
  activeTaskId: string | null
  entries: TaskEntry[]
  entryLoading: boolean
  filterTypes: TaskType[]
  statusFilter: 'DONE' | 'DROPPED' | 'ON_HOLD' | null
  isTodayFilter: boolean
  savedFilterTypes: TaskType[]
  draftTask: DraftTask | null
  draftTaskId: string | null
  logContentDraft: Record<string, string>
  currentSession: WorkSession | null
  lastAfkTime: number | null
  previousActiveTaskId: string | null
  // Search state
  searchMode: boolean
  searchQuery: string
  searchResults: SearchResult[]
  searchTokens: string[]

  loadTodos: () => Promise<void>
  setActiveTask: (id: string | null) => Promise<void>
  createTask: (req: CreateTaskRequest) => Promise<Task>
  updateTask: (id: string, req: UpdateTaskRequest) => Promise<Task | null>
  deleteTask: (id: string) => Promise<void>
  markDone: (id: string) => Promise<Task | null>
  setOnHold: (id: string) => Promise<Task | null>
  submitEntry: (taskId: string, content: string, type?: 'body' | 'log') => Promise<TaskEntry>
  updateEntry: (taskId: string, entryId: string, content: string) => Promise<TaskEntry | null>
  setFilterTypes: (types: TaskType[]) => void
  toggleFilterType: (type: TaskType) => void
  setStatusFilter: (filter: 'DONE' | 'DROPPED' | 'ON_HOLD' | null) => void
  setTodayFilter: (on: boolean) => void
  startDraft: (data: DraftTask) => void
  commitDraft: () => Promise<void>
  cancelDraft: () => void
  takeOver: (taskId: string) => Promise<WorkSession>
  doAfk: () => Promise<void>
  autoTakeOver: (taskId: string) => Promise<void>
  doDrop: (id: string, reason: string) => Promise<Task | null>
  setLogContentDraft: (taskId: string, content: string) => void
  clearLogContentDraft: (taskId: string) => void
  loadCurrentSession: () => Promise<void>
  // Search actions
  setSearchMode: (on: boolean) => void
  doSearch: (query: string) => Promise<void>
  // Pinned tasks
  loadPinnedIds: () => Promise<void>
  togglePinned: (taskId: string) => Promise<void>
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  pinnedIds: new Set(),
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
  draftTaskId: null,
  logContentDraft: {},
  currentSession: null,
  lastAfkTime: null,
  previousActiveTaskId: null,
  searchMode: false,
  searchQuery: '',
  searchResults: [],
  searchTokens: [],

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
      } else if (statusFilter === 'ON_HOLD') {
        tasks = await api.fetchTodos(undefined, 'ON_HOLD')
      } else {
        // statusFilter === null: show non-done/non-dropped with OR type filter
        let tasks: Task[]
        if (filterTypes.length === 0) {
          // All types
          tasks = await api.fetchTodos(undefined, 'PENDING,DOING')
        } else if (filterTypes.length === 1) {
          // Single type — direct call
          tasks = await api.fetchTodos(filterTypes[0], 'PENDING,DOING')
        } else {
          // Multiple types — fetch each separately and merge (OR semantics)
          const results = await Promise.all(
            filterTypes.map((type) => api.fetchTodos(type, 'PENDING,DOING'))
          )
          const merged = results.flat()
          const ids = new Set<string>()
          tasks = merged.filter((t) => {
            if (ids.has(t.id)) return false
            ids.add(t.id)
            return true
          }).sort((a, b) => b.updatedAt - a.updatedAt)
        }
        set({ tasks, loading: false })
        return
      }
      set({ tasks, loading: false })
    } catch (e: any) {
      set({ error: e.message ?? 'Failed to load tasks', loading: false })
    }
  },

  loadPinnedIds: async () => {
    try {
      const ids = await api.getPinnedTaskIds()
      set({ pinnedIds: new Set(ids) })
    } catch {
      // ignore
    }
  },

  togglePinned: async (taskId: string) => {
    const pinned = await api.togglePinned(taskId)
    set((state) => {
      const next = new Set(state.pinnedIds)
      if (pinned) next.add(taskId)
      else next.delete(taskId)
      return { pinnedIds: next }
    })
  },

  setActiveTask: async (id) => {
    set({ activeTaskId: id, entryLoading: true })
    try {
      const [task, entries] = id
        ? await Promise.all([api.getTaskById(id), api.fetchTaskEntries(id)])
        : [null, []]
      if (task) {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? task : t)),
          entries,
          entryLoading: false,
        }))
      } else {
        set({ entries, entryLoading: false })
      }
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
    set((state) => {
      const nextTasks = (state.statusFilter === 'DONE'
        ? state.tasks.map((t) => (t.id === id ? updated : t))
        : state.tasks.filter((t) => t.id !== id)
      ).sort((a, b) => b.updatedAt - a.updatedAt)
      // When task is removed from list, select the next task at the same index
      let nextActiveId = state.activeTaskId
      if (state.activeTaskId === id) {
        const oldIndex = state.tasks.findIndex(t => t.id === id)
        const nextTask = nextTasks[oldIndex] ?? nextTasks[oldIndex - 1] ?? null
        nextActiveId = nextTask?.id ?? null
      }
      return {
        tasks: nextTasks,
        activeTaskId: nextActiveId,
        entries: state.activeTaskId === id ? [] : state.entries,
      }
    })
    return updated
  },

  setOnHold: async (id) => {
    const { currentSession } = get()
    if (currentSession?.taskId === id) {
      await api.doAfk()
      set({ currentSession: null })
    }
    const updated = await api.updateTask(id, { status: 'ON_HOLD' })
    if (!updated) return null
    set((state) => {
      const nextTasks = (state.statusFilter === 'ON_HOLD'
        ? state.tasks.map((t) => (t.id === id ? updated : t))
        : state.tasks.filter((t) => t.id !== id)
      ).sort((a, b) => b.updatedAt - a.updatedAt)
      let nextActiveId = state.activeTaskId
      if (state.activeTaskId === id) {
        const oldIndex = state.tasks.findIndex(t => t.id === id)
        const nextTask = nextTasks[oldIndex] ?? nextTasks[oldIndex - 1] ?? null
        nextActiveId = nextTask?.id ?? null
      }
      return {
        tasks: nextTasks,
        activeTaskId: nextActiveId,
        entries: state.activeTaskId === id ? [] : state.entries,
      }
    })
    return updated
  },

  submitEntry: async (taskId, content, type) => {
    const entry = await api.submitTaskEntry(taskId, content, type)
    // Clear the draft log content for this task
    set((state) => {
      const { [taskId]: _, ...rest } = state.logContentDraft
      return { logContentDraft: rest }
    })
    // Re-fetch the task to get updated updated_at, and refresh entries
    const [updatedTask, freshEntries] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        tasks: nextTasks,
      }
    })
    return entry
  },

  updateEntry: async (taskId, entryId, content) => {
    const entry = await api.updateTaskEntry(taskId, entryId, content)
    if (!entry) return null
    // Re-fetch the task to get updated updated_at, and refresh entries
    const [updatedTask, freshEntries] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        tasks: nextTasks,
      }
    })
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

  setLogContentDraft: (taskId, content) => {
    set((state) => ({
      logContentDraft: { ...state.logContentDraft, [taskId]: content },
    }))
  },

  clearLogContentDraft: (taskId) => {
    set((state) => {
      const { [taskId]: _, ...rest } = state.logContentDraft
      return { logContentDraft: rest }
    })
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
    const session = await api.takeOverTask(taskId)
    // Server now handles PENDING→DOING in takeOverTask, re-fetch updated task
    const updated = await api.getTaskById(taskId)
    if (updated) {
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }))
    }
    set({ currentSession: session, lastAfkTime: null })
    localStorage.removeItem('chronicle_lastAfkTime')
    return session
  },

  doAfk: async () => {
    await api.doAfk()
    const afkTime = Date.now()
    localStorage.setItem('chronicle_lastAfkTime', String(afkTime))
    set({ currentSession: null, lastAfkTime: afkTime })
  },

  autoTakeOver: async (taskId) => {
    const { currentSession } = get()
    if (currentSession?.taskId === taskId) return

    if (currentSession) {
      await api.doAfk()
      set({ currentSession: null })
    }

    // Server handles PENDING→DOING in takeOverTask
    const session = await api.takeOverTask(taskId)
    // Re-fetch updated task for status
    const updated = await api.getTaskById(taskId)
    if (updated) {
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }))
    }
    set({ currentSession: session, lastAfkTime: null })
    localStorage.removeItem('chronicle_lastAfkTime')
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
      if (session) {
        localStorage.removeItem('chronicle_lastAfkTime')
        set({ currentSession: session, lastAfkTime: null })
      } else {
        // Restore lastAfkTime from localStorage for idle display on startup
        const stored = localStorage.getItem('chronicle_lastAfkTime')
        if (stored) {
          set({ lastAfkTime: parseInt(stored, 10) })
        }
      }
    } catch {
      // ignore
    }
  },

  setSearchMode: (on) => set({
    searchMode: on,
    ...(on ? {} : { searchQuery: '', searchResults: [], searchTokens: [] }),
  }),

  doSearch: async (query) => {
    set({ searchQuery: query })
    if (!query.trim()) {
      set({ searchResults: [], searchTokens: [] })
      return
    }
    try {
      const res = await api.searchTasks(query)
      set({ searchResults: res.results, searchTokens: res.tokens })
    } catch {
      set({ searchResults: [], searchTokens: [] })
    }
  },
}))
