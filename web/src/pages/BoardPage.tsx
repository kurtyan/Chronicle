import { useState, useEffect, useRef, useCallback } from 'react'
import { useTaskStore } from '@/stores/taskStore'
import type { Task, TaskType, TaskEntry, SearchResult } from '@/types'
import { priorityColors } from '@/types'
import { useI18n } from '@/i18n/context'
import { X, AlertTriangle, Copy, Search } from 'lucide-react'
import { TodoItem } from '@/components/TodoItem'
import { RichEditor } from '@/components/RichEditor'
import { TaskEntryBlock } from '@/components/TaskEntryBlock'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { WorkSession } from '@/types'
import { highlightText } from '@/lib/highlight'

// Tauri global快捷键事件（绕过 WKWebView 拦截）
async function registerGlobalShortcutTakeover(callback: () => void) {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('global-shortcut-takeover', callback)
    return unlisten
  } catch {
    // Not in Tauri env, ignore
    return null
  }
}

const DRAFT_ID = '__draft__'

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
    tasks, loading, error, activeTaskId, entries, entryLoading, filterTypes,
    statusFilter, isTodayFilter, draftTask, currentSession, lastAfkTime,
    searchMode, searchQuery, searchResults, searchTokens,
    loadTodos, setActiveTask, updateTask, deleteTask, markDone,
    submitEntry, updateEntry, setFilterTypes, toggleFilterType, setStatusFilter, setTodayFilter,
    startDraft, commitDraft, cancelDraft,
    takeOver, doAfk, autoTakeOver, doDrop, loadCurrentSession,
    setSearchMode, doSearch,
  } = useTaskStore()

  // Load current session on mount
  useEffect(() => {
    loadCurrentSession()
  }, [])

  // Listen for Tauri global shortcut Cmd+Shift+T → Take Over
  useEffect(() => {
    let cleanup: (() => void) | undefined
    registerGlobalShortcutTakeover(async () => {
      const s = useTaskStore.getState()
      if (s.activeTaskId && s.activeTaskId !== DRAFT_ID) {
        if (s.currentSession) {
          await s.doAfk()
        }
        await s.takeOver(s.activeTaskId!)
      }
    }).then(fn => { cleanup = fn ?? undefined })
    return () => cleanup?.()
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
    const saved = localStorage.getItem('chronicle_tasklist_pct')
    const pct = saved ? parseFloat(saved) : 0.3
    return Math.round(window.innerWidth * pct)
  })
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

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

  // Log editing state (persists across task switches)
  const [logContent, setLogContent] = useState('')

  // Auto take over when log content becomes non-empty
  const prevLogEmpty = useRef(true)
  const handleLogContentChange = useCallback((html: string) => {
    const isEmpty = isHtmlEmpty(html)
    setLogContent(html)
    // Auto take over when content transitions from empty to non-empty
    if (prevLogEmpty.current && !isEmpty && activeTaskId && activeTaskId !== DRAFT_ID) {
      autoTakeOver(activeTaskId)
    }
    prevLogEmpty.current = isEmpty
  }, [activeTaskId, autoTakeOver])

  // Entry editing state
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)

  // Title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')

  // Drop dialog
  const [dropReason, setDropReason] = useState('')
  const [showDropDialog, setShowDropDialog] = useState(false)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  // Cancel confirm dialog
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

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
  const logEditorRef = useRef<HTMLDivElement>(null)
  const workspaceScrollRef = useRef<HTMLDivElement>(null)

  // Refs to access latest state without stale closures - MUST be defined before handleEscKey
  const stateRef = useRef({
    activeTaskId,
    draftTitle,
    draftBody,
    draftType,
    draftPriority,
    draftTags,
    draftDueDate,
    logContent,
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
  })
  useEffect(() => {
    stateRef.current = {
      activeTaskId,
      draftTitle,
      draftBody,
      draftType,
      draftPriority,
      draftTags,
      draftDueDate,
      logContent,
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
    }
  })

  // Extract ESC handling for reuse
  const handleEscKey = useCallback(async () => {
    const s = stateRef.current
    if (s.showDropDialog) {
      setShowDropDialog(false)
      setDropReason('')
      setDropTargetId(null)
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
    } else if (!isHtmlEmpty(s.logContent)) {
      try {
        await submitEntry(s.activeTaskId!, s.logContent.trim(), 'log')
        setLogContent('')
      } catch (err) {
        console.error('Failed to submit entry:', err)
      }
    } else {
      setLogContent('')
    }
  }, [])

  // ==================== Keyboard shortcuts ====================

  // Bind keyboard shortcuts once
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = stateRef.current
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const mod = isMac ? e.metaKey : e.ctrlKey
      const tag = (e.target as HTMLElement).tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable
      // Also consider focus within RichEditor as "input mode" (for toolbar buttons)
      const activeEl = document.activeElement
      const isInEditor = activeEl?.closest('[data-rich-editor="true"]') !== null
      const isEditing = isInput || isInEditor

      // Allow Cmd+Plus/Minus/0 for zoom to pass through
      if (mod && ['+', '-', '=', '0'].includes(e.key)) return

      // Ctrl+Enter: Submit (only when NOT editing an entry)
      if (e.ctrlKey && e.key === 'Enter' && !s.editingEntryId) {
        e.preventDefault()
        e.stopPropagation()
        if (s.activeTaskId === DRAFT_ID && s.draftTitle.trim()) {
          startDraft({ title: s.draftTitle, body: s.draftBody, type: s.draftType, priority: s.draftPriority, tags: s.draftTags.split(',').map((x: string) => x.trim()).filter(Boolean), dueDate: s.draftDueDate ? new Date(s.draftDueDate).getTime() : null })
          commitDraft().catch((err: Error) => console.error('Failed to commit draft:', err))
        } else if (s.activeTaskId && !isHtmlEmpty(s.logContent)) {
          submitEntry(s.activeTaskId, s.logContent.trim(), 'log').catch((err: Error) => console.error('Failed to submit entry:', err))
          setLogContent('')
        }
        return
      }

      // Cmd/Ctrl + S: Save/Submit (exclude Cmd+Shift+S for priority)
      if (mod && !e.shiftKey && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        if (s.activeTaskId === DRAFT_ID && s.draftTitle.trim()) {
          startDraft({ title: s.draftTitle, body: s.draftBody, type: s.draftType, priority: s.draftPriority, tags: s.draftTags.split(',').map((x: string) => x.trim()).filter(Boolean), dueDate: s.draftDueDate ? new Date(s.draftDueDate).getTime() : null })
          commitDraft().catch((err: Error) => console.error('Failed to commit draft:', err))
        } else if (s.activeTaskId && !isHtmlEmpty(s.logContent)) {
          submitEntry(s.activeTaskId, s.logContent.trim(), 'log').catch((err: Error) => console.error('Failed to submit entry:', err))
          setLogContent('')
        }
        return
      }

      // Arrow Right: focus log editor for currently selected task
      if (!isEditing && !s.showDropDialog && !s.showCancelConfirm && s.activeTaskId && s.activeTaskId !== DRAFT_ID && !s.searchMode) {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          e.stopPropagation()
          const proseMirror = document.querySelector('[data-rich-editor="true"] .ProseMirror') as HTMLElement | null
          if (proseMirror) {
            proseMirror.focus()
          }
          return
        }
      }

      // Arrow Up/Down
      if (!isEditing && !s.showDropDialog && !s.showCancelConfirm && !s.searchMode) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          const visibleTasks = s.tasks.map((t: Task) => t.id)
          if (visibleTasks.length === 0) return
          const currentIdx = s.activeTaskId ? visibleTasks.indexOf(s.activeTaskId) : -1
          let nextIdx: number
          if (s.activeTaskId === null || currentIdx === -1) {
            nextIdx = 0
          } else if (e.key === 'ArrowUp') {
            nextIdx = Math.max(0, currentIdx - 1)
          } else {
            nextIdx = Math.min(visibleTasks.length - 1, currentIdx + 1)
          }
          setActiveTask(visibleTasks[nextIdx])
          return
        }

        if (e.key === 'n') {
          e.preventDefault()
          e.stopPropagation()
          if (s.currentSession) doAfk()
          const prevTaskId = s.activeTaskId && s.activeTaskId !== DRAFT_ID ? s.activeTaskId : null
          setDraftTitle('')
          setDraftBody('')
          setDraftType('TODO')
          setDraftPriority('MEDIUM')
          setDraftTags('')
          setDraftDueDate('')
          startDraft({ title: '', body: '', type: 'TODO', priority: 'MEDIUM', tags: [], dueDate: null })
          useTaskStore.setState({ previousActiveTaskId: prevTaskId })
          setActiveTask(DRAFT_ID)
          return
        }
      }

      // Cmd+Q: AFK current session (instead of quitting app)
      if (mod && e.key === 'q') {
        e.preventDefault()
        e.stopPropagation()
        if (s.currentSession) {
          doAfk()
        }
        return
      }

      // Cmd+T: toggle Today filter
      if (mod && e.key === 't') {
        e.preventDefault()
        e.stopPropagation()
        setTodayFilter(!s.isTodayFilter)
        return
      }

      // Cmd+Shift+T: Take Over current task
      if (mod && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        e.stopPropagation()
        const s = stateRef.current
        if (s.activeTaskId && s.activeTaskId !== DRAFT_ID) {
          if (s.currentSession) {
            doAfk().then(() => takeOver(s.activeTaskId!))
          } else {
            takeOver(s.activeTaskId!)
          }
        }
        return
      }

      // Cmd+Shift+A/S/D: set priority when creating task
      if (mod && e.shiftKey && s.activeTaskId === DRAFT_ID) {
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault()
          e.stopPropagation()
          setDraftPriority('HIGH')
          return
        }
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault()
          e.stopPropagation()
          setDraftPriority('MEDIUM')
          return
        }
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault()
          e.stopPropagation()
          setDraftPriority('LOW')
          return
        }
      }

      // Cmd+R: refresh task list, active task detail, and current session
      if (mod && e.key === 'r') {
        e.preventDefault()
        e.stopPropagation()
        loadTodos()
        loadCurrentSession()
        const currentTaskId = stateRef.current.activeTaskId
        if (currentTaskId && currentTaskId !== DRAFT_ID) {
          setActiveTask(currentTaskId)
        }
        return
      }

      // Cmd+W: blur editor (when focused inside RichEditor) OR cancel done/dropped filter
      if (mod && e.key === 'w') {
        if (isInEditor) {
          e.preventDefault()
          e.stopPropagation()
          const editorEl = activeEl?.closest('[data-rich-editor="true"] .ProseMirror') as HTMLElement | null
          editorEl?.blur()
        } else if (s.statusFilter === 'DONE' || s.statusFilter === 'DROPPED') {
          e.preventDefault()
          e.stopPropagation()
          setStatusFilter(null)
          collapseWithDelay()
        }
        return
      }

      // ESC: Handle immediately (only when NOT editing an entry AND NOT in RichEditor)
      if (e.key === 'Escape' && !s.editingEntryId && !isInEditor) {
        e.preventDefault()
        e.stopPropagation()
        if (s.searchMode) {
          if (!s.searchInput) {
            setSearchMode(false)
          }
        } else {
          handleEscKey()
        }
        return
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, []) // Empty deps - bind once

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

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = taskListWidth
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const diff = ev.clientX - startX.current
      const newWidth = Math.min(500, Math.max(180, startWidth.current + diff))
      setTaskListWidth(newWidth)
    }

    const onMouseUp = () => {
      isResizing.current = false
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      // Save as percentage of current window width
      setTaskListWidth((w) => {
        const pct = w / window.innerWidth
        localStorage.setItem('chronicle_tasklist_pct', String(pct))
        return w
      })
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [taskListWidth])

  // ==================== Task actions ====================

  const isDraftActive = activeTaskId === DRAFT_ID
  const activeTask = tasks.find(t => t.id === activeTaskId) || null

  const handleDeleteTask = async (task: Task) => {
    if (confirm(t('board.deleteConfirm', { title: task.title }))) {
      await deleteTask(task.id)
    }
  }

  const handleStartTask = async () => {
    if (!activeTaskId || isDraftActive) return
    await updateTask(activeTaskId, { status: 'DOING' })
  }

  const handleCompleteTask = async () => {
    if (!activeTaskId || isDraftActive) return
    if (!isHtmlEmpty(logContent)) {
      await submitEntry(activeTaskId, logContent.trim(), 'log')
      setLogContent('')
    }
    // markDone now auto-AFKs if working on this task
    await markDone(activeTaskId)
  }

  const handleContinueTask = async () => {
    if (!activeTaskId || isDraftActive) return
    await updateTask(activeTaskId, { status: 'DOING' })
  }

  const handleDropTask = (taskId: string) => {
    setDropTargetId(taskId)
    setDropReason('')
    setShowDropDialog(true)
  }

  const handleDropConfirm = async () => {
    if (!dropTargetId || !dropReason.trim()) return
    await doDrop(dropTargetId, dropReason.trim())
    setShowDropDialog(false)
    setDropReason('')
    setDropTargetId(null)
  }

  const handleTakeOver = async () => {
    if (!activeTaskId || isDraftActive) return
    // If taking over another task, close current session
    if (currentSession) {
      await doAfk()
    }
    await takeOver(activeTaskId)
  }

  const handleAfk = async () => {
    await doAfk()
  }

  const handleTitleEdit = () => {
    if (!activeTask) return
    setTitleInput(activeTask.title)
    setEditingTitle(true)
  }

  const handleTitleSave = async () => {
    if (!activeTaskId || !titleInput.trim()) {
      setEditingTitle(false)
      return
    }
    await updateTask(activeTaskId, { title: titleInput.trim() })
    setEditingTitle(false)
  }

  const compositionJustEnded = useRef(false)
  const handleCompositionEnd = () => {
    compositionJustEnded.current = true
    setTimeout(() => { compositionJustEnded.current = false }, 200)
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return
    if (compositionJustEnded.current) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter') handleTitleSave()
    if (e.key === 'Escape') setEditingTitle(false)
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

  // ==================== Log entry submission ====================

  const handleSubmitLog = async () => {
    if (!activeTaskId || isHtmlEmpty(logContent) || isDraftActive) return
    await submitEntry(activeTaskId, logContent.trim(), 'log')
    setLogContent('')
  }

  // ==================== Render ====================

  return (
    <div className="flex h-full">
      {/* Todo List */}
      <div style={{ width: taskListWidth, minWidth: 180, maxWidth: 500 }} className="relative border-r bg-card flex flex-col flex-shrink-0">
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
            style={{ maxWidth: expandedFilter ? '260px' : '80px' }}
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
                          {r.matchType === 'task' ? t('search.matchTitle') : r.matchType === 'entry_body' ? t('search.matchBody') : t('search.matchLog')}
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
                tasks.map((task) => (
                  <div key={task.id} className="group relative">
                    <TodoItem
                      task={task}
                      isActive={task.id === activeTaskId}
                      onClick={() => setActiveTask(task.id === activeTaskId ? null : task.id)}
                    />
                    <button
                      className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-white transition"
                      onClick={(e) => { e.stopPropagation(); handleDeleteTask(task) }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))
              )}
            </>
            )}
          </>
        )}
        </div>
      </div>

      {/* Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Scenario A: No active task, no draft, or active task filtered out */}
        {(!activeTaskId || !activeTask) && !draftTask ? (
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
                      content={draftBody}
                      onChange={handleDraftBodyChange}
                      placeholder={t('task.bodyPlaceholder')}
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
                      Ctrl+S {t('task.save')}
                    </div>
                  </div>
                </div>
              </>
            ) : activeTask ? (
              /* Scenario C: Existing task active */
              <>
                {/* Fixed top section */}
                <div className="flex-shrink-0">
                  {/* Task Info Bar */}
                  <div className="h-10 px-[30px] flex items-center justify-between" data-testid="workspace-info-bar">
                    <div className="flex items-center gap-3">
                      <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                        {t(`type.${activeTask.type.toLowerCase()}`)}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        activeTask.status === 'DONE' ? 'bg-green-500/10 text-green-600' :
                        activeTask.status === 'DOING' ? 'bg-blue-500/10 text-blue-600' :
                        activeTask.status === 'DROPPED' ? 'bg-red-500/10 text-red-600' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {t(`status.${activeTask.status.toLowerCase()}`)}
                      </span>
                      {activeTask.status === 'PENDING' && (
                        <>
                          <button
                            className="text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition"
                            onClick={handleStartTask}
                          >
                            {t('workspace.start')}
                          </button>
                          <button
                            className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 transition"
                            onClick={() => handleDropTask(activeTaskId!)}
                          >
                            {t('workspace.drop')}
                          </button>
                        </>
                      )}
                      {activeTask.status === 'DOING' && (
                        <>
                          <button
                            className="text-xs px-3 py-1 rounded bg-green-500 text-white hover:bg-green-600 transition"
                            onClick={handleCompleteTask}
                          >
                            {t('workspace.complete')}
                          </button>
                          <button
                            className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 transition"
                            onClick={() => handleDropTask(activeTaskId!)}
                          >
                            {t('workspace.drop')}
                          </button>
                        </>
                      )}
                      {activeTask.status === 'DONE' && (
                        <button
                          className="text-xs px-3 py-1 rounded border border-muted text-muted-foreground hover:bg-muted transition"
                          onClick={handleContinueTask}
                        >
                          {t('workspace.redo')}
                        </button>
                      )}
                      {activeTask.status === 'DROPPED' && null /* No buttons */}
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Session status indicator */}
                      {currentSession ? (
                        <TrackingStatusIndicator
                          currentSession={currentSession}
                          tasks={tasks}
                          onNavigate={() => {
                            if (currentSession.taskId) {
                              setFilterTypes([])
                              setStatusFilter(null)
                              setActiveTask(currentSession.taskId)
                            }
                          }}
                        />
                      ) : (
                        <IdleTimeIndicator />
                      )}
                      {/* Take Over button when tracking a different task than the one being viewed */}
                      {currentSession && activeTaskId && activeTaskId !== DRAFT_ID && currentSession.taskId !== activeTaskId && (
                        <button
                          className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition"
                          onClick={handleTakeOver}
                        >
                          {t('workspace.takeOver')}
                        </button>
                      )}
                      {/* AFK button (manual fallback) */}
                      {currentSession && (
                        <button
                          className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 transition"
                          onClick={handleAfk}
                        >
                          {t('workspace.afk')}
                        </button>
                      )}
                      {/* Take Over button when no session at all */}
                      {!currentSession && (
                        <button
                          className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition"
                          onClick={handleTakeOver}
                        >
                          {t('workspace.takeOver')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Title with task ID */}
                  <div className="px-[30px] py-2 flex items-start gap-3">
                    {editingTitle ? (
                      <input
                        className="text-xl font-bold flex-1 bg-transparent border-b border-primary focus:outline-none"
                        value={titleInput}
                        onChange={(e) => {
                          setTitleInput(e.target.value)
                          if (activeTaskId) updateTask(activeTaskId, { title: e.target.value.trim() })
                        }}
                        onBlur={handleTitleSave}
                        onKeyDown={handleTitleKeyDown}
                        autoFocus
                      />
                    ) : (
                      <h1
                        className="text-xl font-bold cursor-pointer hover:text-muted-foreground transition flex-1"
                        onClick={handleTitleEdit}
                      >
                        {searchMode && searchTokens.length > 0
                          ? highlightText(activeTask.title, searchTokens)
                          : activeTask.title}
                      </h1>
                    )}
                    <div className="flex items-center gap-1 shrink-0 mt-1">
                      <span className="text-xs text-muted-foreground/60 font-mono" title={activeTask.id}>
                        {activeTask.id}
                      </span>
                      <button
                        className="opacity-50 hover:opacity-100 transition p-1 hover:bg-muted rounded"
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(activeTask.id) }}
                        title="Copy ID"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Drop dialog */}
                <Dialog open={showDropDialog} onOpenChange={(open) => { if (!open) { setShowDropDialog(false); setDropReason(''); setDropTargetId(null) } }}>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <div className="flex items-center gap-2 text-destructive">
                        <AlertTriangle className="w-5 h-5" />
                        <DialogTitle>{t('workspace.dropConfirm')}</DialogTitle>
                      </div>
                    </DialogHeader>
                    <DialogDescription className="sr-only">Drop task reason</DialogDescription>
                    <input
                      className="w-full text-sm px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                      value={dropReason}
                      onChange={(e) => setDropReason(e.target.value)}
                      placeholder={t('workspace.dropReason')}
                      autoFocus
                    />
                    <DialogFooter>
                      <button
                        className="px-4 py-2 text-sm rounded border hover:bg-muted transition"
                        onClick={() => { setShowDropDialog(false); setDropReason(''); setDropTargetId(null) }}
                      >
                        {t('task.cancel')}
                      </button>
                      <button
                        className="px-4 py-2 text-sm rounded bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50"
                        disabled={!dropReason.trim()}
                        onClick={handleDropConfirm}
                      >
                        {t('workspace.drop')}
                      </button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Cancel confirm dialog */}
                <Dialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <div className="flex items-center gap-2 text-amber-600">
                        <AlertTriangle className="w-5 h-5" />
                        <DialogTitle>{t('board.cancelWithContentConfirm')}</DialogTitle>
                      </div>
                    </DialogHeader>
                    <DialogDescription className="sr-only">Unsaved content confirmation</DialogDescription>
                    <DialogFooter>
                      <button
                        className="px-4 py-2 text-sm rounded border hover:bg-muted transition"
                        onClick={() => setShowCancelConfirm(false)}
                      >
                        {t('task.save')}
                      </button>
                      <button
                        className="px-4 py-2 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition"
                        onClick={doCancelDraft}
                      >
                        {t('entry.cancel')}
                      </button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Scrollable content */}
                <div ref={workspaceScrollRef} className="flex-1 overflow-y-auto px-[30px] pb-[10px]">
                  <div className="space-y-4 pt-2">
                    {/* Entries list */}
                    {entryLoading ? (
                      <div className="text-sm text-muted-foreground">{t('workspace.loading')}</div>
                    ) : entries.length > 0 ? (
                      <div className="space-y-4">
                        {entries.map((entry: TaskEntry) => (
                          <TaskEntryBlock
                            key={entry.id}
                            entry={entry}
                            onSave={(id, newContent) => updateEntry(activeTask.id, id, newContent)}
                            editing={editingEntryId === entry.id}
                            highlightTokens={searchMode ? searchTokens : undefined}
                            onEditingChange={(editing) => {
                              if (editing) {
                                setEditingEntryId(entry.id)
                                // Auto take over when starting to edit an entry
                                if (activeTaskId && activeTaskId !== DRAFT_ID) {
                                  autoTakeOver(activeTaskId)
                                }
                              } else {
                                setEditingEntryId(null)
                              }
                            }}
                          />
                        ))}
                      </div>
                    ) : null}

                    {/* Quick log entry — hidden when editing an entry */}
                    {activeTask.status !== 'DONE' && activeTask.status !== 'DROPPED' && !editingEntryId && (
                      <>
                        <div ref={logEditorRef}>
                          <RichEditor
                            content={logContent}
                            onChange={handleLogContentChange}
                            placeholder={t('task.logPlaceholder')}
                            variant="full"
                            onKeyDown={(e) => {
                              if (e.ctrlKey && e.key === 'Enter') {
                                e.preventDefault()
                                e.stopPropagation()
                                const s = stateRef.current
                                if (s.activeTaskId && !isHtmlEmpty(s.logContent)) {
                                  submitEntry(s.activeTaskId, s.logContent.trim(), 'log')
                                  setLogContent('')
                                }
                              }
                            }}
                          />
                        </div>
                        <button
                          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 text-sm"
                          onClick={handleSubmitLog}
                          disabled={isHtmlEmpty(logContent)}
                        >
                          {t('workspace.submitLog')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
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
