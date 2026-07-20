import { create } from 'zustand'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, TaskType, Priority, WorkSession, SearchResult, TaskProgressContext } from '@/types'
import * as api from '@/services/api'

// All UI task mutations go through this store. Serialize writes per task so a
// slower earlier response can never overwrite a later title/status update.
const taskMutationQueues = new Map<string, Promise<unknown>>()

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
  selectedTask: Task | null
  entries: TaskEntry[]
  pinnedEntry: TaskEntry | null
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
  preSearchTaskId: string | null
  // Search state
  searchMode: boolean
  searchQuery: string
  searchResults: SearchResult[]
  searchTokens: string[]
  taskContexts: Record<string, TaskProgressContext>
  taskSummaryUpdating: Set<string>

  loadTodos: () => Promise<void>
  setActiveTask: (id: string | null) => Promise<void>
  createTask: (req: CreateTaskRequest) => Promise<Task>
  updateTask: (id: string, req: UpdateTaskRequest) => Promise<Task | null>
  deleteTask: (id: string) => Promise<void>
  markDone: (id: string) => Promise<Task | null>
  setOnHold: (id: string) => Promise<Task | null>
  submitEntry: (taskId: string, content: string, type?: 'body' | 'log') => Promise<TaskEntry>
  updateEntry: (taskId: string, entryId: string, content: string, type?: 'body' | 'log') => Promise<TaskEntry | null>
  deleteEntry: (taskId: string, entryId: string) => Promise<void>
  appendToPinned: (taskId: string, content: string) => Promise<TaskEntry>
  unpinEntry: (taskId: string, entryId: string) => Promise<TaskEntry | null>
  setFilterTypes: (types: TaskType[]) => void
  toggleFilterType: (type: TaskType) => void
  setStatusFilter: (filter: 'DONE' | 'DROPPED' | 'ON_HOLD' | null) => void
  setTodayFilter: (on: boolean) => void
  startDraft: (data: DraftTask) => void
  commitDraft: () => Promise<void>
  cancelDraft: () => void
  takeOver: (taskId: string) => Promise<WorkSession>
  resumeFromAfk: (taskId: string, startedAt: number) => Promise<WorkSession>
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
  loadTaskContexts: (status?: string) => Promise<TaskProgressContext[]>
  markTaskSummaryUpdating: (taskId: string) => void
  receiveTaskSummaryContext: (context: TaskProgressContext) => void
  receiveTaskSummaryFailure: (taskId: string, error: string) => void
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  pinnedIds: new Set(),
  loading: false,
  error: null,
  activeTaskId: null,
  selectedTask: null,
  entries: [],
  pinnedEntry: null,
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
  preSearchTaskId: null,
  searchMode: false,
  searchQuery: '',
  searchResults: [],
  searchTokens: [],
  taskContexts: {},
  taskSummaryUpdating: new Set(),

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

  loadTaskContexts: async (status = 'PENDING,DOING') => {
    const contexts = await api.fetchTaskContexts(status)
    set((state) => {
      const next = { ...state.taskContexts }
      for (const context of contexts) next[context.taskId] = context
      return { taskContexts: next }
    })
    return contexts
  },

  markTaskSummaryUpdating: (taskId: string) => {
    set((state) => {
      const next = new Set(state.taskSummaryUpdating)
      next.add(taskId)
      const context = state.taskContexts[taskId]
      return {
        taskSummaryUpdating: next,
        taskContexts: context
          ? { ...state.taskContexts, [taskId]: { ...context, summary: { ...context.summary, stale: true, errorMessage: null } } }
          : state.taskContexts,
      }
    })
  },

  receiveTaskSummaryContext: (context: TaskProgressContext) => {
    set((state) => {
      const updating = new Set(state.taskSummaryUpdating)
      updating.delete(context.taskId)
      return {
        taskSummaryUpdating: updating,
        taskContexts: { ...state.taskContexts, [context.taskId]: context },
      }
    })
  },

  receiveTaskSummaryFailure: (taskId: string, error: string) => {
    set((state) => {
      const updating = new Set(state.taskSummaryUpdating)
      updating.delete(taskId)
      const context = state.taskContexts[taskId]
      return {
        taskSummaryUpdating: updating,
        taskContexts: context
          ? { ...state.taskContexts, [taskId]: { ...context, summary: { ...context.summary, stale: true, errorMessage: error } } }
          : state.taskContexts,
      }
    })
  },

  setActiveTask: async (id) => {
    set({ activeTaskId: id, entryLoading: true, pinnedEntry: null })
    try {
      const [task, entries, pinnedEntry] = id
        ? await Promise.all([api.getTaskById(id), api.fetchTaskEntries(id), api.fetchPinnedEntry(id)])
        : [null, [], null]
      // Guard against stale async result: if activeTaskId changed during fetch, skip
      if (get().activeTaskId !== id) return
      if (task) {
        set((state) => {
          const exists = state.tasks.some((t) => t.id === id)
          return {
            tasks: exists ? state.tasks.map((t) => (t.id === id ? task : t)) : state.tasks,
            selectedTask: task,
            entries,
            pinnedEntry,
            entryLoading: false,
          }
        })
      } else {
        set({ entries, pinnedEntry, entryLoading: false, selectedTask: null })
      }
    } catch {
      // An older task request may fail after the user has already selected a
      // different task. Do not clear the newer task's detail pane.
      if (get().activeTaskId !== id) return
      set({ entries: [], pinnedEntry: null, entryLoading: false, selectedTask: null })
    }
  },

  createTask: async (req) => {
    const task = await api.createTask(req)
    set((state) => ({ tasks: [...state.tasks, task].sort((a, b) => b.updatedAt - a.updatedAt) }))
    return task
  },

  updateTask: async (id, req) => {
    const previous = taskMutationQueues.get(id) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(() => api.updateTask(id, req))
    taskMutationQueues.set(id, operation)

    let updated: Task | null
    try {
      updated = await operation
    } finally {
      if (taskMutationQueues.get(id) === operation) taskMutationQueues.delete(id)
    }
    if (!updated) return null
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? updated : t)).sort((a, b) => b.updatedAt - a.updatedAt),
      selectedTask: state.activeTaskId === id ? updated : state.selectedTask,
    }))
    return updated
  },

  deleteTask: async (id) => {
    await api.deleteTask(id)
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
      selectedTask: state.activeTaskId === id ? null : state.selectedTask,
      entries: state.activeTaskId === id ? [] : state.entries,
      pinnedEntry: state.activeTaskId === id ? null : state.pinnedEntry,
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
      let nextSelectedTask: Task | null = state.selectedTask
      if (state.activeTaskId === id) {
        const oldIndex = state.tasks.findIndex(t => t.id === id)
        const nextTask = nextTasks[oldIndex] ?? nextTasks[oldIndex - 1] ?? null
        nextActiveId = nextTask?.id ?? null
        if (nextActiveId === id) {
          nextSelectedTask = updated
        } else {
          nextSelectedTask = nextTask
        }
      }
      return {
        tasks: nextTasks,
        activeTaskId: nextActiveId,
        selectedTask: nextSelectedTask,
        entries: state.activeTaskId === id && nextActiveId !== id ? [] : state.entries,
        pinnedEntry: state.activeTaskId === id && nextActiveId !== id ? null : state.pinnedEntry,
        entryLoading: state.activeTaskId === id && nextActiveId !== null && nextActiveId !== id,
      }
    })
    if (get().activeTaskId) {
      await get().setActiveTask(get().activeTaskId)
    }
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
      let nextSelectedTask: Task | null = state.selectedTask
      if (state.activeTaskId === id) {
        const oldIndex = state.tasks.findIndex(t => t.id === id)
        const nextTask = nextTasks[oldIndex] ?? nextTasks[oldIndex - 1] ?? null
        nextActiveId = nextTask?.id ?? null
        if (nextActiveId === id) {
          nextSelectedTask = updated
        } else {
          nextSelectedTask = nextTask
        }
      }
      return {
        tasks: nextTasks,
        activeTaskId: nextActiveId,
        selectedTask: nextSelectedTask,
        entries: state.activeTaskId === id && nextActiveId !== id ? [] : state.entries,
        pinnedEntry: state.activeTaskId === id && nextActiveId !== id ? null : state.pinnedEntry,
        entryLoading: state.activeTaskId === id && nextActiveId !== null && nextActiveId !== id,
      }
    })
    if (get().activeTaskId) {
      await get().setActiveTask(get().activeTaskId)
    }
    return updated
  },

  submitEntry: async (taskId, content, type) => {
    const entry = await api.submitTaskEntry(taskId, content, type)
    // Clear the draft log content for this task
    set((state) => {
      const { [taskId]: _, ...rest } = state.logContentDraft
      return { logContentDraft: rest }
    })
    // Re-fetch the task to get updated updated_at, and refresh entries + pinned
    const [updatedTask, freshEntries, freshPinned] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
      api.fetchPinnedEntry(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        pinnedEntry: freshPinned,
        tasks: nextTasks,
        selectedTask: state.activeTaskId === taskId && updatedTask ? updatedTask : state.selectedTask,
      }
    })
    return entry
  },

  updateEntry: async (taskId, entryId, content, type) => {
    const entry = await api.updateTaskEntry(taskId, entryId, content, type)
    if (!entry) return null
    // Re-fetch the task to get updated updated_at, and refresh entries + pinned
    const [updatedTask, freshEntries, freshPinned] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
      api.fetchPinnedEntry(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        pinnedEntry: freshPinned,
        tasks: nextTasks,
        selectedTask: state.activeTaskId === taskId && updatedTask ? updatedTask : state.selectedTask,
      }
    })
    return entry
  },

  deleteEntry: async (taskId, entryId) => {
    await api.deleteTaskEntry(taskId, entryId)
    // Re-fetch the task and refresh entries + pinned
    const [updatedTask, freshEntries, freshPinned] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
      api.fetchPinnedEntry(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        pinnedEntry: freshPinned,
        tasks: nextTasks,
        selectedTask: state.activeTaskId === taskId && updatedTask ? updatedTask : state.selectedTask,
      }
    })
  },

  appendToPinned: async (taskId, content) => {
    const entry = await api.appendToPinnedEntry(taskId, content)
    const [updatedTask, freshEntries, freshPinned] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
      api.fetchPinnedEntry(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        pinnedEntry: freshPinned,
        tasks: nextTasks,
        selectedTask: state.activeTaskId === taskId && updatedTask ? updatedTask : state.selectedTask,
      }
    })
    return entry
  },

  unpinEntry: async (taskId, entryId) => {
    const entry = await api.unpinEntry(taskId, entryId)
    const [updatedTask, freshEntries, freshPinned] = await Promise.all([
      api.getTaskById(taskId),
      api.fetchTaskEntries(taskId),
      api.fetchPinnedEntry(taskId),
    ])
    set((state) => {
      const nextTasks = updatedTask
        ? state.tasks.map((t) => (t.id === taskId ? updatedTask : t)).sort((a, b) => b.updatedAt - a.updatedAt)
        : state.tasks
      return {
        entries: freshEntries,
        pinnedEntry: freshPinned,
        tasks: nextTasks,
        selectedTask: state.activeTaskId === taskId && updatedTask ? updatedTask : state.selectedTask,
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
    const { draftTask, draftTaskId } = get()
    if (!draftTask || !draftTask.title.trim()) return
    const task = await api.createTask({
      title: draftTask.title.trim(),
      type: draftTask.type,
      priority: draftTask.priority,
      tags: draftTask.tags,
      dueDate: draftTask.dueDate ?? undefined,
      body: draftTask.body.trim() || undefined,
      reservedId: draftTaskId ?? undefined,
    })
    // No auto-takeOver — task stays PENDING
    set((state) => ({
      tasks: [...state.tasks, task].sort((a, b) => b.updatedAt - a.updatedAt),
      draftTask: null,
      draftTaskId: null,
      activeTaskId: task.id,
      selectedTask: task,
      previousActiveTaskId: null,
    }))
    // Reload entries for the new task
    const entries = await api.fetchTaskEntries(task.id)
    set({ entries })
  },

  cancelDraft: () => set({ draftTask: null, draftTaskId: null }),

  takeOver: async (taskId) => {
    const session = await api.takeOverTask(taskId)
    // Server now handles PENDING→DOING in takeOverTask, re-fetch updated task
    const updated = await api.getTaskById(taskId)
    if (updated) {
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        selectedTask: state.activeTaskId === taskId ? updated : state.selectedTask,
      }))
    }
    set({ currentSession: session, lastAfkTime: null })
    localStorage.removeItem('chronicle_lastAfkTime')
    return session
  },

  resumeFromAfk: async (taskId, startedAt) => {
    const session = await api.resumeTaskFromAfk(taskId, startedAt)
    const updated = await api.getTaskById(taskId)
    if (updated) {
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
        selectedTask: state.activeTaskId === taskId ? updated : state.selectedTask,
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
        selectedTask: state.activeTaskId === taskId ? updated : state.selectedTask,
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
      selectedTask: state.activeTaskId === id ? null : state.selectedTask,
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

  setSearchMode: (on) => {
    if (on) {
      const { activeTaskId } = get()
      set({ searchMode: true, preSearchTaskId: activeTaskId })
    } else {
      const { preSearchTaskId } = get()
      set({
        searchMode: false,
        searchQuery: '',
        searchResults: [],
        searchTokens: [],
        preSearchTaskId: null,
      })
      if (preSearchTaskId) {
        // Restore the task that was selected before entering search mode
        get().setActiveTask(preSearchTaskId)
      } else {
        // No task was selected before search, clear the view
        get().setActiveTask(null)
      }
    }
  },

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
