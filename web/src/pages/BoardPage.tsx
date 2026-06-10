import { useState, useEffect, useRef, useCallback } from 'react'
import { useTaskStore } from '@/stores/taskStore'
import type { Task, TaskType, SearchResult } from '@/types'
import { priorityColors } from '@/types'
import { useI18n } from '@/i18n/context'
import { X, Search, Pin, PauseCircle } from 'lucide-react'
import { TodoItem } from '@/components/TodoItem'
import { RichEditor } from '@/components/RichEditor'
import { TaskDetailWorkspace } from '@/components/TaskDetailWorkspace'
import { getNextTaskId } from '@/services/api'
import type { WorkSession } from '@/types'
import { highlightText } from '@/lib/highlight'
import { registerShortcut } from '@/shortcuts/registry'
import { MeetingExtractionDialog } from '@/components/MeetingExtractionDialog'

const DRAFT_ID = '__draft__'
const BOARD_TASK_LIST_PERCENT_KEY = 'chronicle_tasklist_pct'
const BOARD_TASK_LIST_MIN_WIDTH = 180
const BOARD_DETAIL_MIN_WIDTH = 320

// Check if HTML content is effectively empty (no visible text)
function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  // Remove HTML tags and check for remaining text
  const text = html.replace(/<[^>]*>/g, '').trim()
  // Also check for &nbsp; and other common empty HTML entities
  const decoded = text.replace(/&nbsp;/g, '').replace(/\s+/g, '')
  return decoded.length === 0
}

export function BoardPage() {
  const { t } = useI18n()
  const {
    tasks, loading, error, activeTaskId, selectedTask, entries, filterTypes,
    statusFilter, isTodayFilter, draftTask, draftTaskId, currentSession, lastAfkTime, pinnedIds,
    searchMode, searchQuery, searchResults, searchTokens,
    loadTodos, setActiveTask, updateTask, markDone, setOnHold,
    submitEntry, setFilterTypes, toggleFilterType, setStatusFilter, setTodayFilter,
    startDraft, commitDraft, cancelDraft,
    takeOver, doAfk, loadCurrentSession, loadPinnedIds, togglePinned,
    setSearchMode, doSearch,
    clearLogContentDraft,
  } = useTaskStore()

  // Load current session and pinned IDs on mount
  useEffect(() => {
    loadCurrentSession()
    loadPinnedIds()
  }, [])

  // Reload todos when filter changes
  useEffect(() => {
    loadTodos()
  }, [filterTypes, statusFilter, isTodayFilter])

  // Focus search input when search mode turns on
  useEffect(() => {
    if (searchMode) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    } else {
      setSearchInput('')
    }
  }, [searchMode])

  // Sync search input with query when results change
  useEffect(() => {
    if (searchQuery && searchMode) {
      setSearchInput(searchQuery)
    }
  }, [searchQuery, searchMode])

  // Reset selection when search results change
  useEffect(() => {
    setSearchSelectedIdx(-1)
  }, [searchResults])

  // Scroll active task into view when it changes
  useEffect(() => {
    if (!activeTaskId) return
    // Find the active task element
    const taskElement = document.querySelector(`[data-task-id="${activeTaskId}"]`) as HTMLElement | null
    if (!taskElement) return

    // Find the scrollable container (task list)
    const container = taskElement.closest('.overflow-y-auto') as HTMLElement | null
    if (!container) return

    const containerRect = container.getBoundingClientRect()
    const taskRect = taskElement.getBoundingClientRect()

    // Check if task is above the visible area
    if (taskRect.top < containerRect.top) {
      // Scroll up to show the task at the top edge
      container.scrollBy({ top: taskRect.top - containerRect.top, behavior: 'smooth' })
    }
    // Check if task is below the visible area
    else if (taskRect.bottom > containerRect.bottom) {
      // Scroll down to show the task at the bottom edge
      container.scrollBy({ top: taskRect.bottom - containerRect.bottom, behavior: 'smooth' })
    }
  }, [activeTaskId])

  // Scroll workspace content to bottom when switching to an existing task
  useEffect(() => {
    if (!activeTaskId || activeTaskId === DRAFT_ID) return
    const el = workspaceScrollRef.current
    if (!el) return
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [activeTaskId, entries])

  const [taskListWidth, setTaskListWidth] = useState(() => {
    const saved = localStorage.getItem(BOARD_TASK_LIST_PERCENT_KEY)
    const pct = saved ? parseFloat(saved) : 0.3
    return Math.round(window.innerWidth * pct)
  })
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const boardContainerRef = useRef<HTMLDivElement | null>(null)

  // Draft editing state
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftType, setDraftType] = useState<TaskType>('TODO')
  const [draftPriority, setDraftPriority] = useState<'HIGH' | 'MEDIUM' | 'LOW'>('MEDIUM')
  const [draftTags, setDraftTags] = useState('')
  const [draftDueDate, setDraftDueDate] = useState('')

  // Expanded filter bar (new + done + dropped slide)
  const [expandedFilter, setExpandedFilter] = useState(false)
  const autoCollapseRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Search input state
  const [searchInput, setSearchInput] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchSelectedIdx, setSearchSelectedIdx] = useState(-1)

  function clearAutoCollapseTimer() {
    if (autoCollapseRef.current) {
      clearTimeout(autoCollapseRef.current)
      autoCollapseRef.current = null
    }
  }

  function resetAutoCollapseTimer() {
    clearAutoCollapseTimer()
    // Only auto-collapse when no status filter is selected
    if (statusFilter === null) {
      autoCollapseRef.current = setTimeout(() => setExpandedFilter(false), 3000)
    }
  }

  // Auto-collapse only when no status filter is selected
  useEffect(() => {
    if (expandedFilter && statusFilter === null) {
      autoCollapseRef.current = setTimeout(() => setExpandedFilter(false), 3000)
    } else {
      clearAutoCollapseTimer()
    }
    return () => clearAutoCollapseTimer()
  }, [expandedFilter, statusFilter])

  // Log editing state — per-task drafts stored in useTaskStore
  // (was: const [logContent, setLogContent] = useState(''))

  // Auto take over when log content becomes non-empty

  // Entry editing state
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)

  // Drop dialog
  const [showDropDialog, setShowDropDialog] = useState(false)

  // Pin context menu
  const [pinMenu, setPinMenu] = useState<{ taskId: string; x: number; y: number } | null>(null)
  const pinMenuRef = useRef<HTMLDivElement>(null)

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!pinMenu) return
    const handleClick = (e: MouseEvent) => {
      if (pinMenuRef.current && !pinMenuRef.current.contains(e.target as Node)) {
        setPinMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pinMenu])

  // Cancel confirm dialog
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showMeetingDialog, setShowMeetingDialog] = useState(false)

  // beforeunload: ensure active session is closed via sendBeacon
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (currentSession) {
        navigator.sendBeacon('/api/afk')
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [currentSession])

  // Refs for draft editing
  const titleInputRef = useRef<HTMLInputElement>(null)
  const workspaceScrollRef = useRef<HTMLDivElement>(null)

  // Refs to access latest state without stale closures - MUST be defined before handleEscKey
  const stateRef = useRef({
    activeTaskId,
    selectedTask,
    draftTitle,
    draftBody,
    draftType,
    draftPriority,
    draftTags,
    draftDueDate,
    editingEntryId,
    showDropDialog,
    showCancelConfirm,
    tasks,
    currentSession,
    lastAfkTime,
    statusFilter,
    isTodayFilter,
    searchMode,
    searchInput,
    pinnedIds,
  })
  useEffect(() => {
    stateRef.current = {
      activeTaskId,
      selectedTask,
      draftTitle,
      draftBody,
      draftType,
      draftPriority,
      draftTags,
      draftDueDate,
      editingEntryId,
      showDropDialog,
      showCancelConfirm,
      tasks,
      currentSession,
      lastAfkTime,
      statusFilter,
      isTodayFilter,
      searchMode,
      searchInput,
      pinnedIds,
    }
  })

  // Extract ESC handling for reuse
  const handleEscKey = useCallback(async () => {
    const s = stateRef.current
    if (s.showDropDialog) {
      setShowDropDialog(false)
    } else if (s.activeTaskId === DRAFT_ID) {
      if (s.draftTitle.trim()) {
        startDraft({ title: s.draftTitle, body: s.draftBody, type: s.draftType, priority: s.draftPriority, tags: s.draftTags.split(',').map((x: string) => x.trim()).filter(Boolean), dueDate: s.draftDueDate ? new Date(s.draftDueDate).getTime() : null })
        try {
          await commitDraft()
        } catch (err) {
          console.error('Failed to commit draft:', err)
        }
      } else {
        await handleCancelDraft()
      }
    } else if (s.editingEntryId) {
      setEditingEntryId(null)
    } else {
      const storeLog = s.activeTaskId ? (useTaskStore.getState().logContentDraft[s.activeTaskId] || '') : ''
      if (!isHtmlEmpty(storeLog)) {
        try {
          await submitEntry(s.activeTaskId!, storeLog.trim(), 'log')
          clearLogContentDraft(s.activeTaskId!)
        } catch (err) {
          console.error('Failed to submit entry:', err)
        }
      } else {
        clearLogContentDraft(s.activeTaskId!)
      }
    }
  }, [])

  // ==================== Keyboard shortcuts ====================

  // Register page-level shortcuts with the centralized registry
  useEffect(() => {
    const unregisters: (() => void)[] = []

    // Helpers — match original guards exactly
    // isEditing = isInput || isInEditor
    const isEditing = () => {
      const tag = (document.activeElement as HTMLElement)?.tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement)?.isContentEditable
      const isInEditor = document.activeElement?.closest('[data-rich-editor="true"]') !== null
      return isInput || isInEditor
    }
    // notEditing = !isEditing && no dialogs && not in search
    const notEditing = () => !isEditing() && !stateRef.current.showDropDialog && !stateRef.current.showCancelConfirm && !stateRef.current.searchMode

    // Ctrl+Enter: Submit entry or commit draft
    // Original guard: !s.editingEntryId (no isEditing check)
    unregisters.push(registerShortcut({
      id: 'submit-entry',
      combo: 'ctrl+enter',
      label: 'Submit entry',
      scope: 'page',
      context: () => !stateRef.current.editingEntryId,
      handler: () => {
        const s = stateRef.current
        if (s.activeTaskId === DRAFT_ID && s.draftTitle.trim()) {
          startDraft({ title: s.draftTitle, body: s.draftBody, type: s.draftType, priority: s.draftPriority, tags: s.draftTags.split(',').map((x: string) => x.trim()).filter(Boolean), dueDate: s.draftDueDate ? new Date(s.draftDueDate).getTime() : null })
          commitDraft().catch((err: Error) => console.error('Failed to commit draft:', err))
        } else if (s.activeTaskId) {
          const storeLog = useTaskStore.getState().logContentDraft[s.activeTaskId] || ''
          if (!isHtmlEmpty(storeLog)) {
            submitEntry(s.activeTaskId, storeLog.trim(), 'log').catch((err: Error) => console.error('Failed to submit entry:', err))
            clearLogContentDraft(s.activeTaskId)
          }
        }
      },
    }))

    // Arrow Right: Focus log editor
    // Original guard: !isEditing && !showDropDialog && !showCancelConfirm && activeTaskId !== DRAFT && !searchMode
    unregisters.push(registerShortcut({
      id: 'focus-log-editor',
      combo: 'ArrowRight',
      label: 'Focus log editor',
      scope: 'page',
      context: () => {
        const s = stateRef.current
        return Boolean(notEditing() && s.activeTaskId && s.activeTaskId !== DRAFT_ID)
      },
      handler: () => {
        const proseMirror = document.querySelector('[data-rich-editor="true"] .ProseMirror') as HTMLElement | null
        proseMirror?.focus()
      },
    }))


    // Arrow Up: Navigate to previous task
    unregisters.push(registerShortcut({
      id: 'nav-up',
      combo: 'ArrowUp',
      label: 'Previous task',
      scope: 'page',
      context: notEditing,
      handler: () => {
        const s = stateRef.current
        const sorted = [...s.tasks].sort((a: Task, b: Task) => {
          const aPinned = s.pinnedIds?.has(a.id) ? 1 : 0
          const bPinned = s.pinnedIds?.has(b.id) ? 1 : 0
          return bPinned - aPinned || b.updatedAt - a.updatedAt
        }).map((t: Task) => t.id)
        if (sorted.length === 0) return
        const currentIdx = s.activeTaskId ? sorted.indexOf(s.activeTaskId) : -1
        const nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1
        setActiveTask(sorted[nextIdx])
      },
    }))

    // Arrow Down: Navigate to next task
    unregisters.push(registerShortcut({
      id: 'nav-down',
      combo: 'ArrowDown',
      label: 'Next task',
      scope: 'page',
      context: notEditing,
      handler: () => {
        const s = stateRef.current
        const sorted = [...s.tasks].sort((a: Task, b: Task) => {
          const aPinned = s.pinnedIds?.has(a.id) ? 1 : 0
          const bPinned = s.pinnedIds?.has(b.id) ? 1 : 0
          return bPinned - aPinned || b.updatedAt - a.updatedAt
        }).map((t: Task) => t.id)
        if (sorted.length === 0) return
        const currentIdx = s.activeTaskId ? sorted.indexOf(s.activeTaskId) : -1
        const nextIdx = currentIdx >= sorted.length - 1 ? sorted.length - 1 : currentIdx + 1
        setActiveTask(sorted[nextIdx])
      },
    }))

    // Cmd+N: New task
    unregisters.push(registerShortcut({
      id: 'new-task',
      combo: 'mod+n',
      label: 'New task',
      scope: 'page',
      context: notEditing,
      handler: async () => {
        const s = stateRef.current
        if (s.currentSession) doAfk()
        const prevTaskId = s.activeTaskId && s.activeTaskId !== DRAFT_ID ? s.activeTaskId : null
        // Get a real taskId from server for attachment support
        const taskId = await getNextTaskId()
        setDraftTitle('')
        setDraftBody('')
        setDraftType('TODO')
        setDraftPriority('MEDIUM')
        setDraftTags('')
        setDraftDueDate('')
        startDraft({ title: '', body: '', type: 'TODO', priority: 'MEDIUM', tags: [], dueDate: null })
        useTaskStore.setState({ previousActiveTaskId: prevTaskId, draftTaskId: taskId })
        setActiveTask(DRAFT_ID)
      },
    }))

    // Cmd+T: Toggle Today filter (no isEditing check in original)
    unregisters.push(registerShortcut({
      id: 'toggle-today',
      combo: 'mod+t',
      label: 'Toggle Today filter',
      scope: 'page',
      handler: () => setTodayFilter(!stateRef.current.isTodayFilter),
    }))

    // Cmd+Shift+T: Take Over current task
    // Original guard: activeTaskId && activeTaskId !== DRAFT (no isEditing check)
    unregisters.push(registerShortcut({
      id: 'take-over',
      combo: 'mod+shift+t',
      label: 'Take Over task',
      scope: 'page',
      context: () => {
        const s = stateRef.current
        return Boolean(s.activeTaskId && s.activeTaskId !== DRAFT_ID)
      },
      handler: async () => {
        const s = stateRef.current
        if (s.currentSession) {
          await doAfk()
        }
        takeOver(s.activeTaskId!)
      },
    }))

    // Cmd+Shift+S: Start task (when PENDING)
    unregisters.push(registerShortcut({
      id: 'start-task',
      combo: 'mod+shift+s',
      label: 'Start task',
      scope: 'page',
      context: () => {
        const s = stateRef.current
        return Boolean(s.activeTaskId && s.activeTaskId !== DRAFT_ID && s.selectedTask?.status === 'PENDING')
      },
      handler: () => {
        const s = stateRef.current
        updateTask(s.activeTaskId!, { status: 'DOING' }).catch((err: Error) => console.error('Failed to start task:', err))
      },
    }))

    // Cmd+Shift+D: Mark task done (when DOING)
    unregisters.push(registerShortcut({
      id: 'mark-done',
      combo: 'mod+shift+d',
      label: 'Mark done',
      scope: 'page',
      context: () => {
        const s = stateRef.current
        return Boolean(s.activeTaskId && s.activeTaskId !== DRAFT_ID && s.selectedTask?.status === 'DOING')
      },
      handler: () => {
        const s = stateRef.current
        markDone(s.activeTaskId!).catch((err: Error) => console.error('Failed to mark done:', err))
      },
    }))

    // Cmd+Shift+A: Set priority HIGH (in draft)
    unregisters.push(registerShortcut({
      id: 'priority-high',
      combo: 'mod+shift+a',
      label: 'Priority: High',
      scope: 'page',
      context: () => useTaskStore.getState().activeTaskId === DRAFT_ID,
      handler: () => setDraftPriority('HIGH'),
    }))

    // Cmd+Shift+S: Set priority MEDIUM (in draft)
    unregisters.push(registerShortcut({
      id: 'priority-medium',
      combo: 'mod+shift+s',
      label: 'Priority: Medium',
      scope: 'page',
      context: () => useTaskStore.getState().activeTaskId === DRAFT_ID,
      handler: () => setDraftPriority('MEDIUM'),
    }))

    // Cmd+Shift+D: Set priority LOW (in draft)
    unregisters.push(registerShortcut({
      id: 'priority-low',
      combo: 'mod+shift+d',
      label: 'Priority: Low',
      scope: 'page',
      context: () => useTaskStore.getState().activeTaskId === DRAFT_ID,
      handler: () => setDraftPriority('LOW'),
    }))

    // Escape: Handle ESC
    // Original guard: !editingEntryId && !isInEditor
    // Inside: if searchMode && !searchInput → exit search, else handleEscKey
    unregisters.push(registerShortcut({
      id: 'escape',
      combo: 'Escape',
      label: 'Escape / Cancel',
      scope: 'page',
      context: () => {
        const isInEditor = document.activeElement?.closest('[data-rich-editor="true"]') !== null
        return !stateRef.current.editingEntryId && !isInEditor
      },
      handler: () => {
        const s = stateRef.current
        if (s.searchMode && !s.searchInput) {
          setSearchMode(false)
        } else {
          handleEscKey()
        }
      },
    }))

    return () => {
      for (const unregister of unregisters) unregister()
    }
  }, []) // Empty deps - handlers use stateRef/getState()

  // ==================== Handlers ====================

  function collapseWithDelay() {
    clearAutoCollapseTimer()
    const timer = setTimeout(() => setExpandedFilter(false), 3000)
    ;(window as any).__filterCollapseTimer = timer
  }

  async function handleNewTask() {
    // If take over, AFK first
    if (currentSession) {
      try {
        await doAfk()
      } catch (err) {
        console.error('Failed to AFK:', err)
      }
    }
    // Remember previous task
    const prevTaskId = activeTaskId && activeTaskId !== DRAFT_ID ? activeTaskId : null
    // Reset draft
    setDraftTitle('')
    setDraftBody('')
    setDraftType('TODO')
    setDraftPriority('MEDIUM')
    setDraftTags('')
    setDraftDueDate('')
    startDraft({ title: '', body: '', type: 'TODO', priority: 'MEDIUM', tags: [], dueDate: null })
    // Store previous task for restoration
    useTaskStore.setState({ previousActiveTaskId: prevTaskId })
    setActiveTask(DRAFT_ID)
    // Get taskId asynchronously for attachment support (non-blocking)
    getNextTaskId().then((id) => {
      useTaskStore.setState({ draftTaskId: id })
    }).catch(() => {
      // Fallback: use DRAFT_ID if server is unavailable
      useTaskStore.setState({ draftTaskId: DRAFT_ID })
    })
  }

  async function handleCancelDraft() {
    if (!isHtmlEmpty(draftBody)) {
      setShowCancelConfirm(true)
      return
    }
    doCancelDraft()
  }

  async function doCancelDraft() {
    setShowCancelConfirm(false)
    const prevId = useTaskStore.getState().previousActiveTaskId
    cancelDraft()
    await setActiveTask(null)

    // Restore previous task (just browse, no auto take over)
    if (prevId) {
      const currentTasks = useTaskStore.getState().tasks
      const taskExists = currentTasks.find(t => t.id === prevId)
      if (taskExists) {
        await setActiveTask(prevId)
      }
    }
    useTaskStore.setState({ previousActiveTaskId: null })
  }

  // ==================== Draft sync ====================

  useEffect(() => {
    if (draftTask) {
      setDraftTitle(draftTask.title)
      setDraftBody(draftTask.body)
      setDraftType(draftTask.type)
      setDraftPriority(draftTask.priority)
      setDraftTags(draftTask.tags.join(', '))
      setDraftDueDate(draftTask.dueDate ? new Date(draftTask.dueDate).toISOString().split('T')[0] : '')
    }
  }, [draftTask])

  // ==================== Resize ====================

  const clampTaskListWidth = useCallback((width: number, containerWidth = boardContainerRef.current?.clientWidth ?? window.innerWidth) => {
    const maxWidth = Math.max(BOARD_TASK_LIST_MIN_WIDTH, containerWidth - BOARD_DETAIL_MIN_WIDTH)
    return Math.min(maxWidth, Math.max(BOARD_TASK_LIST_MIN_WIDTH, width))
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      setTaskListWidth((width) => clampTaskListWidth(width))
    }
    handleWindowResize()
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [clampTaskListWidth])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = taskListWidth
    const containerWidth = boardContainerRef.current?.clientWidth ?? window.innerWidth
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const diff = ev.clientX - startX.current
      const newWidth = clampTaskListWidth(startWidth.current + diff, containerWidth)
      setTaskListWidth(newWidth)
    }

    const onMouseUp = () => {
      isResizing.current = false
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      // Save as percentage of current window width
      setTaskListWidth((w) => {
        const clamped = clampTaskListWidth(w, containerWidth)
        const pct = clamped / containerWidth
        localStorage.setItem(BOARD_TASK_LIST_PERCENT_KEY, String(pct))
        return clamped
      })
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampTaskListWidth, taskListWidth])

  // ==================== Task actions ====================

  const isDraftActive = activeTaskId === DRAFT_ID
  const sortedTasks = [...tasks].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id) ? 1 : 0
    const bPinned = pinnedIds.has(b.id) ? 1 : 0
    return bPinned - aPinned || b.updatedAt - a.updatedAt
  })

  const handleTogglePin = async (taskId: string) => {
    await togglePinned(taskId)
    setPinMenu(null)
    loadTodos() // Refresh the list
  }

  const handleSetOnHold = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    if (task.status === 'DONE' || task.status === 'DROPPED') {
      alert(t('status.onHold') + ': 无法对已完成或已废弃的任务执行此操作')
      return
    }
    if (confirm(`确认将「${task.title}」设为搁置状态？\n\n此操作将终止当前工作记录。`)) {
      await setOnHold(taskId)
    }
    setPinMenu(null)
  }

  const handleAfk = async () => {
    await doAfk()
  }

  const compositionJustEnded = useRef(false)
  const handleCompositionEnd = () => {
    compositionJustEnded.current = true
    setTimeout(() => { compositionJustEnded.current = false }, 200)
  }

  const focusEditor = () => {
    // Try TipTap's editor instance first, then fall back to contenteditable element
    const proseMirror = document.querySelector('.ProseMirror') as HTMLElement | null
    if (proseMirror) proseMirror.focus()
  }

  const handleDraftTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ((event.nativeEvent as KeyboardEvent).isComposing) return
    if (compositionJustEnded.current) {
      event.preventDefault()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      requestAnimationFrame(() => focusEditor())
      return
    }
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault()
      focusEditor()
    }
  }

  // ==================== Draft sync helpers ====================

  const handleDraftTitleChange = (val: string) => {
    setDraftTitle(val)
    startDraft({ title: val, body: draftBody, type: draftType, priority: draftPriority, tags: draftTags.split(',').map(s => s.trim()).filter(Boolean), dueDate: draftDueDate ? new Date(draftDueDate).getTime() : null })
  }

  const handleDraftBodyChange = (val: string) => {
    setDraftBody(val)
    startDraft({ title: draftTitle, body: val, type: draftType, priority: draftPriority, tags: draftTags.split(',').map(s => s.trim()).filter(Boolean), dueDate: draftDueDate ? new Date(draftDueDate).getTime() : null })
  }

  // ==================== Render ====================

  return (
    <div ref={boardContainerRef} className="flex h-full">
      {/* Todo List */}
      <div style={{ width: taskListWidth, minWidth: BOARD_TASK_LIST_MIN_WIDTH }} className="relative border-r bg-card flex flex-col flex-shrink-0">
        {/* Resize handle overlay */}
        <div
          className="absolute inset-y-0 -right-1 w-2 cursor-col-resize z-10 hover:bg-primary/5 rounded-l"
          onMouseDown={handleResizeMouseDown}
        />
        {/* Header: filter bar or search bar */}
        {searchMode ? (
          <div className="h-10 px-3 border-b flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <input
              ref={searchInputRef}
              className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground"
              placeholder="搜索任务..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  const nextIdx = Math.min(searchSelectedIdx + 1, searchResults.length - 1)
                  setSearchSelectedIdx(nextIdx)
                  if (searchResults[nextIdx]) {
                    setActiveTask(searchResults[nextIdx].taskId)
                  }
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  const prevIdx = Math.max(searchSelectedIdx - 1, 0)
                  setSearchSelectedIdx(prevIdx)
                  if (searchResults[prevIdx]) {
                    setActiveTask(searchResults[prevIdx].taskId)
                  }
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!searchInput.trim()) return
                  doSearch(searchInput)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  return
                }
              }}
              autoFocus
            />
            <button
              className="text-xs px-2 py-0.5 rounded border border-border transition hover:bg-muted text-muted-foreground flex-shrink-0"
              onClick={() => { setSearchInput(''); setSearchMode(false) }}
            >
              {t('search.close')}
            </button>
          </div>
        ) : (
        <div className="h-10 px-3 border-b flex items-center justify-between">
          {/* Left: type buttons + Today */}
          <div className="flex items-center gap-1">
            {/* When in Today view, only show Today button */}
            {!isTodayFilter && (
              <>
                {(['TODO', 'TOREAD', 'DAILY_IMPROVE'] as TaskType[]).map((typeKey) => (
                  <button
                    key={typeKey}
                    className={`text-xs px-2 py-0.5 rounded transition ${
                      filterTypes.includes(typeKey)
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted text-muted-foreground'
                    }`}
                    onClick={() => toggleFilterType(typeKey)}
                  >
                    {t(`type.${typeKey.toLowerCase()}`)}
                  </button>
                ))}
              </>
            )}
            {isTodayFilter ? (
              <button
                className="text-xs px-2 py-0.5 rounded bg-blue-500 text-white transition"
                onClick={() => setTodayFilter(false)}
              >
                {t('task.today')}
              </button>
            ) : (
              <button
                className="text-xs px-2 py-0.5 rounded transition hover:bg-muted text-muted-foreground"
                onClick={() => setTodayFilter(true)}
              >
                {t('task.today')}
              </button>
            )}
          </div>

          {/* Status filter expansion — animated NEW | < / New-Done-Dropped */}
          <div
            className="overflow-hidden transition-all duration-300 ease-in-out ml-2"
            style={{ maxWidth: expandedFilter ? '330px' : '165px' }}
          >
            <div
              className="flex gap-1 whitespace-nowrap relative"
              onClick={() => resetAutoCollapseTimer()}
            >
              {/* Collapsed: NEW | < */}
              <span
                className={`inline-flex shrink-0 transition-opacity duration-200 ${
                  !expandedFilter ? 'opacity-100' : 'opacity-0 pointer-events-none absolute'
                }`}
              >
                <button
                  className="text-xs px-2 py-0.5 rounded-l border border-border transition hover:bg-muted text-muted-foreground whitespace-nowrap"
                  onClick={handleNewTask}
                >
                  {t('task.newLabel')}
                </button>
                <button
                  className="text-xs px-2 py-0.5 border border-l-0 border-border transition hover:bg-muted text-muted-foreground whitespace-nowrap"
                  onClick={() => setShowMeetingDialog(true)}
                >
                  Meeting
                </button>
                <button
                  className="text-xs px-1.5 py-0.5 rounded-r border border-l-0 border-border transition hover:bg-muted text-muted-foreground"
                  onClick={() => setExpandedFilter(true)}
                >
                  &lt;
                </button>
              </span>

              {/* Expanded: New | Done | Dropped */}
              <span
                className={`inline-flex shrink-0 transition-opacity duration-200 ${
                  expandedFilter ? 'opacity-100' : 'opacity-0 pointer-events-none absolute'
                }`}
              >
                <button
                  className="text-xs px-2 py-0.5 rounded transition hover:bg-muted text-muted-foreground whitespace-nowrap"
                  onClick={handleNewTask}
                >
                  {t('task.newLabel')}
                </button>
                <button
                  className="text-xs px-2 py-0.5 rounded transition hover:bg-muted text-muted-foreground whitespace-nowrap"
                  onClick={() => setShowMeetingDialog(true)}
                >
                  Meeting
                </button>
                <button
                  className={`text-xs px-2 py-0.5 rounded transition whitespace-nowrap ${
                    statusFilter === 'DONE'
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted text-muted-foreground'
                  }`}
                  onClick={() => {
                    if (statusFilter === 'DONE') {
                      setStatusFilter(null)
                      clearAutoCollapseTimer()
                      collapseWithDelay()
                    } else {
                      setStatusFilter('DONE')
                    }
                  }}
                >
                  {t('filter.done')}
                </button>
                <button
                  className={`text-xs px-2 py-0.5 rounded transition whitespace-nowrap ${
                    statusFilter === 'DROPPED'
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted text-muted-foreground'
                  }`}
                  onClick={() => {
                    if (statusFilter === 'DROPPED') {
                      setStatusFilter(null)
                      clearAutoCollapseTimer()
                      collapseWithDelay()
                    } else {
                      setStatusFilter('DROPPED')
                    }
                  }}
                >
                  {t('filter.dropped')}
                </button>
                <button
                  className={`text-xs px-2 py-0.5 rounded transition whitespace-nowrap ${
                    statusFilter === 'ON_HOLD'
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted text-muted-foreground'
                  }`}
                  onClick={() => {
                    if (statusFilter === 'ON_HOLD') {
                      setStatusFilter(null)
                      clearAutoCollapseTimer()
                      collapseWithDelay()
                    } else {
                      setStatusFilter('ON_HOLD')
                    }
                  }}
                >
                  {t('filter.onHold')}
                </button>
              </span>
            </div>
          </div>
        </div>
        )}
        {/* Task list or search results */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {searchMode ? (
            <>
              {searchResults.length === 0 && searchQuery && (
                <div className="text-sm text-muted-foreground text-center py-8">{t('search.noResults')}</div>
              )}
              {searchResults.length === 0 && !searchQuery && (
                <div className="text-sm text-muted-foreground text-center py-8">输入关键词并按回车搜索</div>
              )}
              {searchResults.map((r: SearchResult, i: number) => (
                <div
                  key={r.taskId}
                  tabIndex={0}
                  role="button"
                  className={`group relative border rounded-lg p-3 cursor-pointer transition ${
                    r.taskId === activeTaskId ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30' : i === searchSelectedIdx ? 'border-primary/30 bg-primary/5' : 'border-border hover:bg-muted/50'
                  }`}
                  onClick={() => {
                    setActiveTask(r.taskId)
                    setSearchSelectedIdx(i)
                    setFilterTypes([])
                    setStatusFilter(null)
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      setActiveTask(r.taskId)
                      setFilterTypes([])
                      setStatusFilter(null)
                    }
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${priorityColors[r.taskType === 'TODO' ? 'MEDIUM' : r.taskType === 'TOREAD' ? 'HIGH' : 'LOW']}`} />
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-medium truncate">
                        {highlightText(r.originalTitle, searchTokens)}
                      </h4>
                      <div className="flex items-center gap-1 mt-0.5">
                        {r.exactMatch && (
                          <span className="text-xs px-1 py-0.5 rounded bg-primary/10 text-primary font-medium">精确匹配</span>
                        )}
                        <span className="text-xs px-1 py-0.5 rounded bg-muted text-muted-foreground">
                          {r.matchType === 'task' ? t('search.matchTitle') : r.matchType === 'entry_body' ? t('search.matchBody') : r.matchType === 'entry_plan' ? t('search.matchPlan') : t('search.matchLog')}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`type.${r.taskType.toLowerCase()}`)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`status.${r.taskStatus.toLowerCase()}`)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
          {loading ? (
            <div className="text-sm text-muted-foreground text-center py-8">{t('board.loading')}</div>
          ) : error ? (
            <div className="text-sm text-destructive text-center py-8">{error}</div>
          ) : (
            <>
              {/* Draft entry at top */}
              {draftTask && (
                <div
                  key={DRAFT_ID}
                  className={`group relative border-dashed border-2 ${
                    isDraftActive ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-primary/30'
                  } rounded-lg p-3 cursor-pointer transition`}
                  onClick={() => setActiveTask(DRAFT_ID)}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-1 w-2 h-2 rounded-full flex-shrink-0 bg-primary/50 animate-pulse" />
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-medium text-muted-foreground">
                        {draftTitle.trim() || t('task.creating')}
                      </h4>
                    </div>
                  </div>
                </div>
              )}
              {/* Existing tasks */}
              {tasks.length === 0 && !draftTask ? (
                <div className="text-sm text-muted-foreground text-center py-8">{t('board.empty')}</div>
              ) : (
                sortedTasks.map((task) => {
                  const isPinned = pinnedIds.has(task.id)
                  return (
                  <div key={task.id} className="group relative">
                    <TodoItem
                      task={task}
                      isActive={task.id === activeTaskId}
                      pinned={isPinned}
                      onClick={() => setActiveTask(task.id === activeTaskId ? null : task.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (pinMenu?.taskId === task.id) {
                          setPinMenu(null)
                        } else {
                          setPinMenu({ taskId: task.id, x: e.clientX, y: e.clientY })
                        }
                      }}
                    />
                  </div>
                  )
                })
              )}
            </>
            )}
          </>
        )}
        </div>

        {/* Context menu — fixed position, top-left aligned with cursor */}
        {pinMenu && (
          <div
            className="fixed z-[100] bg-popover border rounded-md shadow-md py-1 min-w-[140px]"
            ref={pinMenuRef}
            style={{ left: pinMenu.x, top: pinMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full text-left text-sm px-3 py-1.5 hover:bg-muted flex items-center gap-2"
              onClick={(e) => {
                e.stopPropagation()
                handleTogglePin(pinMenu.taskId)
              }}
            >
              <Pin className="w-3.5 h-3.5" />
              {pinnedIds.has(pinMenu.taskId) ? t('task.unpin') : t('task.pin')}
            </button>
            <div className="border-t my-1" />
            <button
              className="w-full text-left text-sm px-3 py-1.5 hover:bg-muted flex items-center gap-2 text-orange-600"
              onClick={(e) => {
                e.stopPropagation()
                handleSetOnHold(pinMenu.taskId)
              }}
            >
              <PauseCircle className="w-3.5 h-3.5" />
              {t('status.onHold')}
            </button>
          </div>
        )}
      </div>

      {/* Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Scenario A: No active task, no draft, or active task filtered out */}
        {(!activeTaskId || !selectedTask) && !draftTask ? (
          <>
            {/* Top bar with tracking status */}
            <div className="flex-shrink-0 h-10 px-[30px] flex items-center justify-end">
              <div className="flex items-center gap-2">
                {currentSession ? (
                  <TrackingStatusIndicator
                    currentSession={currentSession}
                    tasks={tasks}
                    onNavigate={() => {
                      if (currentSession.taskId) {
                        // Reset filters to show all active tasks before navigating
                        setFilterTypes([])
                        setStatusFilter(null)
                        setActiveTask(currentSession.taskId)
                      }
                    }}
                  />
                ) : (
                  <IdleTimeIndicator />
                )}
                {currentSession && (
                  <button
                    className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 transition"
                    onClick={handleAfk}
                  >
                    {t('workspace.afk')}
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <p className="text-lg mb-2">{t('board.selectPrompt')}</p>
                <p className="text-sm">{t('board.selectSubtitle')}</p>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Scenario B: Draft active */}
            {isDraftActive ? (
              <>
                {/* Fixed top section */}
                <div className="flex-shrink-0">
                  {/* Info bar */}
                  <div className="h-10 px-[30px] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{t('task.creating')}</span>
                      <div className="flex gap-1">
                        {(['TODO', 'TOREAD', 'DAILY_IMPROVE'] as TaskType[]).map((typeKey) => (
                          <button
                            key={typeKey}
                            className={`text-xs px-2 py-0.5 rounded transition ${
                              draftType === typeKey ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                            onClick={() => setDraftType(typeKey)}
                          >
                            {t(`type.${typeKey.toLowerCase()}`)}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        {(['HIGH', 'MEDIUM', 'LOW'] as const).map((p) => (
                          <button
                            key={p}
                            className={`text-xs px-2 py-0.5 rounded transition ${priorityColors[p]} ${
                              draftPriority === p ? 'text-white' : 'opacity-50 hover:opacity-75'
                            }`}
                            onClick={() => setDraftPriority(p)}
                          >
                            {t(`priority.${p.toLowerCase()}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
                      onClick={handleCancelDraft}
                    >
                      <X className="w-3.5 h-3.5" />
                      {t('entry.cancel')}
                    </button>
                  </div>

                  {/* Title */}
                  <div className="px-[30px] py-2">
                    <input
                      ref={titleInputRef}
                      className="text-xl font-bold w-full bg-transparent border-b border-primary focus:outline-none"
                      value={draftTitle}
                      onChange={(e) => handleDraftTitleChange(e.target.value)}
                      onKeyDown={handleDraftTitleKeyDown}
                      onCompositionEnd={handleCompositionEnd}
                      placeholder={t('task.titlePlaceholder')}
                      autoFocus
                    />
                  </div>
                </div>

                {/* Scrollable content */}
                <div className="flex-1 overflow-y-auto px-[30px] pb-[10px]">
                  <div className="space-y-4 pt-2">
                    {/* Body editor */}
                    <RichEditor
                      key={`body-${activeTaskId ?? 'none'}`}
                      content={draftBody}
                      onChange={handleDraftBodyChange}
                      placeholder={t('task.bodyPlaceholder')}
                      taskId={draftTaskId ?? undefined}
                      onNavigateUp={() => {
                        // Focus back to title input
                        titleInputRef.current?.focus()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          handleEscKey()
                        } else if (e.ctrlKey && e.key === 'Enter') {
                          e.preventDefault()
                          e.stopPropagation()
                          if (stateRef.current.draftTitle.trim()) {
                            startDraft({ title: stateRef.current.draftTitle, body: stateRef.current.draftBody, type: stateRef.current.draftType, priority: stateRef.current.draftPriority, tags: stateRef.current.draftTags.split(',').map((x: string) => x.trim()).filter(Boolean), dueDate: stateRef.current.draftDueDate ? new Date(stateRef.current.draftDueDate).getTime() : null })
                            commitDraft().catch((err: Error) => console.error('Failed to commit draft:', err))
                          }
                        }
                      }}
                    />
                    <div className="text-xs text-muted-foreground">
                      Ctrl+Enter {t('task.save')}
                    </div>
                  </div>
                </div>
              </>
            ) : selectedTask ? (
              <TaskDetailWorkspace />
            ) : null}
          </>
        )}
      </div>
      <MeetingExtractionDialog
        open={showMeetingDialog}
        mode="record"
        onOpenChange={setShowMeetingDialog}
        onSaved={async (task) => {
          await loadTodos()
          await setActiveTask(task.id)
        }}
      />
    </div>
  )
}

// Tracking status indicator with elapsed working time
function TrackingStatusIndicator({ currentSession, tasks, onNavigate }: {
  currentSession: WorkSession
  tasks: Task[]
  onNavigate: () => void
}) {
  const { t } = useI18n()
  const trackedTask = tasks.find(tk => tk.id === currentSession.taskId)
  const titleRef = useRef<HTMLSpanElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const titleEl = titleRef.current
    const containerEl = containerRef.current
    if (!titleEl || !containerEl) return
    setIsOverflowing(titleEl.scrollWidth > containerEl.clientWidth)
  }, [trackedTask?.title])

  useEffect(() => {
    setElapsed(Date.now() - currentSession.startedAt)
    const timer = setInterval(() => setElapsed(Date.now() - currentSession.startedAt), 1000)
    return () => clearInterval(timer)
  }, [currentSession.startedAt])

  return (
    <div
      className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-600 overflow-hidden cursor-pointer hover:brightness-125 transition flex items-center gap-1.5"
      style={{ width: '32ch', maxWidth: '32ch' }}
      onClick={onNavigate}
      title={trackedTask?.title}
    >
      <span className="whitespace-nowrap shrink-0 font-mono">{t('workspace.tracking')} {formatDuration(elapsed)}</span>
      <span
        ref={containerRef}
        className="overflow-hidden min-w-0 leading-[1]"
      >
        <span
          ref={titleRef}
          className={`block whitespace-nowrap ${isOverflowing ? 'animate-marquee' : 'truncate'}`}
        >
          {trackedTask?.title ?? ''}
        </span>
      </span>
    </div>
  )
}

// Idle time indicator — shown when no session is active
function IdleTimeIndicator() {
  const { t } = useI18n()
  const lastAfkTime = useTaskStore(s => s.lastAfkTime)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (lastAfkTime == null) return
    setElapsed(Date.now() - lastAfkTime)
    const timer = setInterval(() => setElapsed(Date.now() - lastAfkTime), 1000)
    return () => clearInterval(timer)
  }, [lastAfkTime])

  if (lastAfkTime == null) {
    return (
      <span className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
        {t('workspace.notTracking')}
      </span>
    )
  }

  return (
    <span className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-600 font-mono">
      {t('workspace.idle')} {formatDuration(elapsed)}
    </span>
  )
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
