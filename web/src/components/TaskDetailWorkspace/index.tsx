import { useState, useRef, useEffect, useCallback } from 'react'
import { useTaskStore } from '@/stores/taskStore'
import { useI18n } from '@/i18n/context'
import type { TaskEntry, WorkSession, Task, TaskProgressContext } from '@/types'
import { TaskEntryBlock } from '@/components/TaskEntryBlock'
import { getTaskExtraInfoValue, submitTaskEntry } from '@/services/api'
import { updatePlanItem, takeOverTask } from '@/services/api'
import { isTauriEnv } from '@/services/httpApi'
import { registerShortcut } from '@/shortcuts/registry'
import { Copy, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'

function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  const text = html.replace(/<[^>]*>/g, '').trim()
  return text.length === 0
}

interface TaskDetailWorkspaceProps {
  highlightEntryId?: string
  showTrackingStatus?: boolean
}

export function TaskDetailWorkspace({ highlightEntryId, showTrackingStatus = true }: TaskDetailWorkspaceProps) {
  const { t } = useI18n()
  const {
    selectedTask, entries, entryLoading, activeTaskId, tasks,
    currentSession, searchMode, searchTokens,
    updateTask, markDone, submitEntry, updateEntry, deleteEntry,
    takeOver, doAfk, autoTakeOver, doDrop,
    setActiveTask, setLogContentDraft, clearLogContentDraft,
  } = useTaskStore()
  const taskContexts = useTaskStore((s) => s.taskContexts)
  const taskSummaryUpdating = useTaskStore((s) => s.taskSummaryUpdating)
  const loadTaskContexts = useTaskStore((s) => s.loadTaskContexts)

  const logContent = activeTaskId ? (useTaskStore.getState().logContentDraft[activeTaskId] || '') : ''

  // Editing state — persisted to localStorage so it survives task switches
  const [editingEntryId, setEditingEntryId] = useState<string | null>(() => {
    if (activeTaskId) {
      return localStorage.getItem(`chronicle:editing_entry_id:${activeTaskId}`) ?? null
    }
    return null
  })
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [showDropDialog, setShowDropDialog] = useState(false)
  const [dropReason, setDropReason] = useState('')
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null)

  // Track the entry ID from silent saves (Cmd+S, auto-save) so subsequent saves
  // update the same entry instead of creating duplicate entries on every press.
  const silentEntryIdRef = useRef<Record<string, string | null>>({})

  // Serialize silent saves per taskId — each save waits for the previous one to finish
  // before checking for entry ID. Prevents race condition where two rapid Cmd+S
  // both find no entryId and create duplicate entries.
  const silentSaveLockRef = useRef<Record<string, Promise<void> | null>>({})

  const DRAFT_ID = '__draft__'
  const isDraftActive = activeTaskId === DRAFT_ID
  const activeSummaryContext = activeTaskId ? taskContexts[activeTaskId] : undefined
  const activeSummaryUpdating = activeTaskId ? taskSummaryUpdating.has(activeTaskId) : false

  useEffect(() => {
    if (!activeTaskId || isDraftActive || !selectedTask) return
    loadTaskContexts(selectedTask.status).catch((error) => console.error('Failed to load task summary:', error))
  }, [activeTaskId, isDraftActive, selectedTask?.status, loadTaskContexts])

  const scrollWorkspaceToBottom = useCallback(() => {
    const el = workspaceScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const handleStartTask = async () => {
    if (!activeTaskId || isDraftActive) return
    await updateTask(activeTaskId, { status: 'DOING' })
  }

  const handleCompleteTask = async () => {
    if (!activeTaskId || isDraftActive) return
    if (!isHtmlEmpty(logContent)) {
      // Check for existing draft entry from Cmd+S
      let existingId = silentEntryIdRef.current[activeTaskId]
      if (!existingId) {
        existingId = localStorage.getItem(`chronicle:draft_entry_id:${activeTaskId}`)
      }
      if (existingId) {
        await (await import('@/services/api')).updateTaskEntry(activeTaskId, existingId, logContent.trim())
        const { fetchTaskEntries } = await import('@/services/api')
        const freshEntries = await fetchTaskEntries(activeTaskId)
        useTaskStore.setState({ entries: freshEntries })
      } else {
        await submitEntry(activeTaskId, logContent.trim(), 'log')
      }
      clearLogContentDraft(activeTaskId)
      silentEntryIdRef.current[activeTaskId] = null
      localStorage.removeItem(`chronicle:draft_entry_id:${activeTaskId}`)
      localStorage.removeItem(`chronicle:editing_entry_id:${activeTaskId}`)
      localStorage.removeItem(`chronicle:entry_draft:${activeTaskId}:__new__`)
      if (existingId) {
        localStorage.removeItem(`chronicle:entry_draft:${activeTaskId}:${existingId}`)
      }
      setEditingEntryId(null)
    }
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
    if (currentSession) await doAfk()
    await takeOver(activeTaskId)
  }

  const handleAfk = async () => { await doAfk() }

  const handleFirstMeaningfulEdit = useCallback(() => {
    if (activeTaskId && activeTaskId !== DRAFT_ID) {
      autoTakeOver(activeTaskId)
    }
  }, [activeTaskId, autoTakeOver])

  const handlePlanAction = async (detailId: string, status: 'DOING' | 'DONE' | 'SKIPPED' | 'PLANNED') => {
    try {
      if (status === 'DOING' && selectedTask) await takeOverTask(selectedTask.id)
      await updatePlanItem(detailId, {
        status,
        actualStartedAt: status === 'DOING' ? Date.now() : undefined,
        actualCompletedAt: status === 'DONE' ? Date.now() : undefined,
      })
      if (selectedTask) await setActiveTask(selectedTask.id)
    } catch { /* ignore */ }
  }

  const handleTitleEdit = () => {
    if (!selectedTask) return
    setTitleInput(selectedTask.title)
    setEditingTitle(true)
  }

  const handleTitleSave = async () => {
    if (!activeTaskId || !titleInput.trim()) { setEditingTitle(false); return }
    await updateTask(activeTaskId, { title: titleInput.trim() })
    setEditingTitle(false)
  }

  const compositionJustEnded = useRef(false)
  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return
    if (compositionJustEnded.current) { e.preventDefault(); return }
    if (e.key === 'Enter') handleTitleSave()
    if (e.key === 'Escape') setEditingTitle(false)
  }

  const handleClaudeSession = async () => {
    if (!activeTaskId) return
    const conversationId = await getTaskExtraInfoValue(activeTaskId, 'claude_conversation_id')
    const cmd = conversationId
      ? `cd ~/IdeaProjects && claude -r ${conversationId}`
      : `cd ~/IdeaProjects && claude 'chronicle taskId: ${activeTaskId}'`
    if (isTauriEnv) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('run_terminal_command', { command: cmd })
        return
      } catch { /* fallback */ }
    }
    await navigator.clipboard.writeText(cmd)
    alert(`Copied to clipboard:\n${cmd}`)
  }

  // Submit entry from the new-entry editor
  const handleSubmitLog = async (content?: string) => {
    if (!activeTaskId || isDraftActive) return
    const toSubmit = content ?? useTaskStore.getState().logContentDraft[activeTaskId] ?? ''
    if (isHtmlEmpty(toSubmit)) return

    // Check if there's already a draft entry from Cmd+S
    let existingId = silentEntryIdRef.current[activeTaskId]
    if (!existingId) {
      existingId = localStorage.getItem(`chronicle:draft_entry_id:${activeTaskId}`)
    }

    if (existingId) {
      // Update the existing draft entry instead of creating a new one
      await (await import('@/services/api')).updateTaskEntry(activeTaskId, existingId, toSubmit.trim())
      // Re-fetch entries so the entry becomes visible
      const { fetchTaskEntries } = await import('@/services/api')
      const freshEntries = await fetchTaskEntries(activeTaskId)
      useTaskStore.setState({ entries: freshEntries })
    } else {
      // No prior draft — create new entry
      await submitEntry(activeTaskId, toSubmit.trim(), 'log')
    }

    clearLogContentDraft(activeTaskId)
    silentEntryIdRef.current[activeTaskId] = null
    localStorage.removeItem(`chronicle:draft_entry_id:${activeTaskId}`)
    localStorage.removeItem(`chronicle:editing_entry_id:${activeTaskId}`)
    localStorage.removeItem(`chronicle:entry_draft:${activeTaskId}:__new__`)
    if (existingId) {
      localStorage.removeItem(`chronicle:entry_draft:${activeTaskId}:${existingId}`)
    }
    setEditingEntryId(null)
  }

  // Save new entry draft silently and refresh entries without broadcasting SSE noise.
  // Entry ID is tracked in localStorage so subsequent saves update the same entry.
  // Uses a per-taskId lock to serialize saves and prevent race conditions.
  const handleSilentSave = useCallback(async (content: string) => {
    if (!activeTaskId || isDraftActive) return
    if (isHtmlEmpty(content)) return

    const chain = silentSaveLockRef.current[activeTaskId] ?? Promise.resolve()
    silentSaveLockRef.current[activeTaskId] = chain.then(async () => {
      try {
        let existingId = silentEntryIdRef.current[activeTaskId]
        const lsId = localStorage.getItem(`chronicle:draft_entry_id:${activeTaskId}`)
        if (!existingId) {
          existingId = lsId
          if (existingId) silentEntryIdRef.current[activeTaskId] = existingId
        }
        if (existingId) {
          await (await import('@/services/api')).updateTaskEntry(activeTaskId, existingId, content)
        } else {
          const entry = await submitTaskEntry(activeTaskId, content, 'log', true /* silent */)
          silentEntryIdRef.current[activeTaskId] = entry.id
          localStorage.setItem(`chronicle:draft_entry_id:${activeTaskId}`, entry.id)
          // New entry creation updated task.updated_at — refresh list so task re-sorts to top
          await useTaskStore.getState().loadTodos()
        }
        const freshEntries = await (await import('@/services/api')).fetchTaskEntries(activeTaskId)
        useTaskStore.setState({ entries: freshEntries })
      } catch (err) {
        console.error('Silent save failed:', err)
      }
    })
    return silentSaveLockRef.current[activeTaskId]
  }, [activeTaskId, isDraftActive])

  // Restore editing state from localStorage when task changes
  useEffect(() => {
    if (activeTaskId) {
      // Priority: draft entry ID (Cmd+S new entry) > editing entry ID (existing entry edit)
      const draftId = localStorage.getItem(`chronicle:draft_entry_id:${activeTaskId}`)
      const editingId = localStorage.getItem(`chronicle:editing_entry_id:${activeTaskId}`)
      setEditingEntryId(draftId ?? editingId)
    } else {
      setEditingEntryId(null)
    }
  }, [activeTaskId])

  useEffect(() => {
    if (!activeTaskId || activeTaskId === DRAFT_ID || entryLoading) return

    const animationFrame = window.requestAnimationFrame(scrollWorkspaceToBottom)
    const delayedScroll = window.setTimeout(scrollWorkspaceToBottom, 80)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(delayedScroll)
    }
  }, [activeTaskId, entryLoading, entries, scrollWorkspaceToBottom])

  // Register task-detail keyboard shortcuts (work on both Board and Today pages)
  useEffect(() => {
    const unregisters: (() => void)[] = []

    // Ctrl+Enter: Submit entry
    unregisters.push(registerShortcut({
      id: 'submit-entry',
      combo: 'ctrl+enter',
      label: 'Submit entry',
      scope: 'page',
      handler: async () => {
        const state = useTaskStore.getState()
        if (state.activeTaskId) {
          const storeLog = state.logContentDraft[state.activeTaskId] || ''
          if (!isHtmlEmpty(storeLog)) {
            // Check for existing draft entry from Cmd+S
            let existingId = silentEntryIdRef.current[state.activeTaskId]
            if (!existingId) {
              existingId = localStorage.getItem(`chronicle:draft_entry_id:${state.activeTaskId}`)
            }
            if (existingId) {
              await (await import('@/services/api')).updateTaskEntry(state.activeTaskId, existingId, storeLog.trim())
              const freshEntries = await (await import('@/services/api')).fetchTaskEntries(state.activeTaskId)
              useTaskStore.setState({ entries: freshEntries })
            } else {
              await submitEntry(state.activeTaskId, storeLog.trim(), 'log')
            }
            clearLogContentDraft(state.activeTaskId)
            silentEntryIdRef.current[state.activeTaskId] = null
            localStorage.removeItem(`chronicle:draft_entry_id:${state.activeTaskId}`)
            localStorage.removeItem(`chronicle:editing_entry_id:${state.activeTaskId}`)
            localStorage.removeItem(`chronicle:entry_draft:${state.activeTaskId}:__new__`)
            if (existingId) {
              localStorage.removeItem(`chronicle:entry_draft:${state.activeTaskId}:${existingId}`)
            }
            setEditingEntryId(null)
          }
        }
      },
    }))

    // ArrowRight: Focus log editor (only when not already editing)
    unregisters.push(registerShortcut({
      id: 'focus-log-editor',
      combo: 'ArrowRight',
      label: 'Focus log editor',
      scope: 'page',
      context: () => {
        const tag = (document.activeElement as HTMLElement)?.tagName
        const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement)?.isContentEditable
        const isInEditor = document.activeElement?.closest('[data-rich-editor="true"]') !== null
        return !(isInput || isInEditor)
      },
      handler: () => {
        const proseMirror = document.querySelector('[data-rich-editor="true"] .ProseMirror') as HTMLElement | null
        proseMirror?.focus()
      },
    }))

    // Cmd+Shift+T: Take Over
    unregisters.push(registerShortcut({
      id: 'take-over',
      combo: 'mod+shift+t',
      label: 'Take Over task',
      scope: 'page',
      context: () => {
        const s = useTaskStore.getState()
        return Boolean(s.activeTaskId && s.activeTaskId !== '__draft__')
      },
      handler: async () => {
        const s = useTaskStore.getState()
        if (s.currentSession) await doAfk()
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
        const s = useTaskStore.getState()
        return Boolean(s.activeTaskId && s.activeTaskId !== '__draft__' && s.selectedTask?.status === 'PENDING')
      },
      handler: () => {
        const s = useTaskStore.getState()
        updateTask(s.activeTaskId!, { status: 'DOING' })
      },
    }))

    // Cmd+Shift+D: Mark done (when DOING)
    unregisters.push(registerShortcut({
      id: 'mark-done',
      combo: 'mod+shift+d',
      label: 'Mark done',
      scope: 'page',
      context: () => {
        const s = useTaskStore.getState()
        return Boolean(s.activeTaskId && s.activeTaskId !== '__draft__' && s.selectedTask?.status === 'DOING')
      },
      handler: () => {
        const s = useTaskStore.getState()
        markDone(s.activeTaskId!)
      },
    }))

    return () => unregisters.forEach(fn => fn())
  }, [])

  if (!selectedTask) return null

  return (
    <>
      {/* Fixed top section */}
      <div className="flex-shrink-0">
        {/* Task Info Bar */}
        <div className="h-10 px-[30px] flex items-center justify-between" data-testid="workspace-info-bar">
          <div className="flex items-center gap-3">
            <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
              {t(`type.${selectedTask.type.toLowerCase()}`)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded ${
              selectedTask.status === 'DONE' ? 'bg-green-500/10 text-green-600' :
              selectedTask.status === 'DOING' ? 'bg-blue-500/10 text-blue-600' :
              selectedTask.status === 'DROPPED' ? 'bg-red-500/10 text-red-600' :
              selectedTask.status === 'ON_HOLD' ? 'bg-orange-500/10 text-orange-600' :
              'bg-muted text-muted-foreground'
            }`}>
              {t(`status.${selectedTask.status.toLowerCase()}`)}
            </span>
            {selectedTask.status === 'PENDING' && (
              <>
                <button className="text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition" onClick={handleStartTask}>
                  {t('workspace.start')}
                </button>
                <button className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 transition" onClick={() => handleDropTask(activeTaskId!)}>
                  {t('workspace.drop')}
                </button>
              </>
            )}
            {selectedTask.status === 'DOING' && (
              <>
                <button className="text-xs px-3 py-1 rounded bg-green-500 text-white hover:bg-green-600 transition" onClick={handleCompleteTask}>
                  {t('workspace.complete')}
                </button>
                <button className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 transition" onClick={() => handleDropTask(activeTaskId!)}>
                  {t('workspace.drop')}
                </button>
              </>
            )}
            {selectedTask.status === 'DONE' && (
              <button className="text-xs px-3 py-1 rounded border border-muted text-muted-foreground hover:bg-muted transition" onClick={handleContinueTask}>
                {t('workspace.redo')}
              </button>
            )}
            {selectedTask.status === 'DROPPED' && null}
            {selectedTask.status === 'ON_HOLD' && (
              <>
                <button className="text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition" onClick={handleContinueTask}>
                  {t('workspace.continue')}
                </button>
                <button className="text-xs px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 transition" onClick={() => handleDropTask(activeTaskId!)}>
                  {t('workspace.drop')}
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {showTrackingStatus ? (
              currentSession ? (
                <TrackingStatusIndicator
                  currentSession={currentSession}
                  tasks={tasks}
                  onNavigate={() => {
                    if (currentSession.taskId) setActiveTask(currentSession.taskId)
                  }}
                />
              ) : (
                <IdleTimeIndicator />
              )
            ) : null}
            {currentSession && activeTaskId && activeTaskId !== DRAFT_ID && currentSession.taskId !== activeTaskId && (
              <button className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition" onClick={handleTakeOver}>
                {t('workspace.takeOver')}
              </button>
            )}
            {currentSession && (
              <button className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 transition" onClick={handleAfk}>
                {t('workspace.afk')}
              </button>
            )}
            {!currentSession && (
              <button className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition" onClick={handleTakeOver}>
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
              onChange={(e) => { setTitleInput(e.target.value); if (activeTaskId) updateTask(activeTaskId, { title: e.target.value.trim() }) }}
              onBlur={handleTitleSave}
              onKeyDown={handleTitleKeyDown}
              autoFocus
            />
          ) : (
            <h1 className="text-xl font-bold cursor-pointer hover:text-muted-foreground transition flex-1" onClick={handleTitleEdit}>
              {selectedTask.title}
            </h1>
          )}
          <div className="flex items-center gap-1 shrink-0 mt-1">
            <span className="text-xs text-muted-foreground/60 font-mono" title={selectedTask.id}>{selectedTask.id}</span>
            <button className="opacity-50 hover:opacity-100 transition p-1 hover:bg-muted rounded" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(selectedTask.id) }} title="Copy ID">
              <Copy className="w-3 h-3" />
            </button>
            <button className="opacity-50 hover:opacity-100 transition p-1 hover:bg-muted rounded text-xs font-medium" onClick={(e) => { e.stopPropagation(); handleClaudeSession() }} title={t('workspace.claude')}>
              {t('workspace.claude')}
            </button>
          </div>
        </div>
        {activeTaskId && !isDraftActive && (
          <div className="px-[30px] pb-2">
            <TaskSummaryWidget context={activeSummaryContext} updating={activeSummaryUpdating} />
          </div>
        )}
      </div>

      {/* Drop dialog */}
      <Dialog open={showDropDialog} onOpenChange={(open) => { if (!open) { setShowDropDialog(false); setDropReason(''); setDropTargetId(null) } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-destructive/10">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <DialogTitle>{t('workspace.dropConfirm')}</DialogTitle>
                <p className="text-sm text-muted-foreground mt-0.5">
                  此操作将废弃任务「<span className="font-medium text-foreground">{dropTargetId ? tasks.find(t => t.id === dropTargetId)?.title : ''}</span>」，并终止当前工作记录
                </p>
              </div>
            </div>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <DialogDescription>请说明废弃原因，以便后续追溯</DialogDescription>
            <textarea className="dialog-textarea min-h-[100px]" value={dropReason} onChange={(e) => setDropReason(e.target.value)} placeholder="请输入废弃原因..." rows={3} autoFocus />
          </DialogBody>
          <DialogFooter>
            <button className="dialog-button-secondary" onClick={() => { setShowDropDialog(false); setDropReason(''); setDropTargetId(null) }}>
              {t('task.cancel')}
            </button>
            <button className="dialog-button-danger" disabled={!dropReason.trim()} onClick={handleDropConfirm}>
              {t('workspace.drop')}
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
                  onSave={(id, newContent) => updateEntry(selectedTask.id, id, newContent)}
                  onDelete={(id) => deleteEntry(selectedTask.id, id)}
                  editing={editingEntryId === entry.id}
                  highlightTokens={searchMode ? searchTokens : undefined}
                  highlightPlan={entry.id === highlightEntryId}
                  taskId={selectedTask.id}
                  planStatus={entry.planStatus}
                  planDetailId={entry.planDetailId}
                  onPlanStart={(detailId) => handlePlanAction(detailId, 'DOING')}
                  onPlanComplete={(detailId) => handlePlanAction(detailId, 'DONE')}
                  onPlanSkip={(detailId) => handlePlanAction(detailId, 'SKIPPED')}
                  onPlanRevert={(detailId) => handlePlanAction(detailId, 'PLANNED')}
                  onDeletePlan={async () => {
                    await deleteEntry(selectedTask.id, entry.id)
                  }}
                  onFirstMeaningfulEdit={handleFirstMeaningfulEdit}
                  onEditingChange={(editing) => {
                    if (editing) {
                      setEditingEntryId(entry.id)
                      if (activeTaskId && activeTaskId !== DRAFT_ID) {
                        localStorage.setItem(`chronicle:editing_entry_id:${activeTaskId}`, entry.id)
                      }
                      // Auto-start plan entry when editing starts
                      if (entry.type === 'plan' && entry.planDetailId && entry.planStatus === 'PLANNED') {
                        handlePlanAction(entry.planDetailId, 'DOING')
                      }
                    } else {
                      setEditingEntryId(null)
                      if (activeTaskId) {
                        localStorage.removeItem(`chronicle:editing_entry_id:${activeTaskId}`)
                        localStorage.removeItem(`chronicle:entry_draft:${activeTaskId}:${entry.id}`)
                        // If this was a draft entry from Cmd+S, clear all draft-specific state
                        const draftId = silentEntryIdRef.current[activeTaskId]
                          ?? localStorage.getItem(`chronicle:draft_entry_id:${activeTaskId}`)
                        if (draftId === entry.id) {
                          silentEntryIdRef.current[activeTaskId] = null
                          localStorage.removeItem(`chronicle:draft_entry_id:${activeTaskId}`)
                          localStorage.removeItem(`chronicle:entry_draft:${activeTaskId}:__new__`)
                          clearLogContentDraft(activeTaskId)
                        }
                      }
                    }
                  }}
                />
              ))}
            </div>
          ) : null}

          {/* Quick log entry — hidden when editing an entry */}
          {selectedTask.status !== 'DONE' && selectedTask.status !== 'DROPPED' && !editingEntryId && (
            <TaskEntryBlock
              isNewEntry
              onChange={(content) => { if (activeTaskId) setLogContentDraft(activeTaskId, content) }}
              onSubmit={handleSubmitLog}
              onSilentSave={handleSilentSave}
              onFirstMeaningfulEdit={handleFirstMeaningfulEdit}
              initialContent={logContent}
              taskId={activeTaskId ?? undefined}
              onSave={() => {}}
            />
          )}
        </div>
      </div>
    </>
  )
}

function TaskSummaryWidget({ context, updating }: { context?: TaskProgressContext; updating: boolean }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('chronicle_task_summary_collapsed') === '1')
  const [expanded, setExpanded] = useState(false)
  const summary = context?.summary
  const latestProgress = summary?.latestProgress || 'Summary pending.'
  const nextStep = summary?.nextStep.trim() ?? ''
  const canExpand = latestProgress.length > 160 || nextStep.length > 120 || latestProgress.includes('\n') || nextStep.includes('\n')
  const stateLabel = updating
    ? 'Updating'
    : summary?.errorMessage
      ? 'Failed'
      : summary?.stale
        ? 'Stale'
        : summary?.summaryUpdatedAt
          ? 'Current'
          : 'Pending'
  const stateClass = updating
    ? 'bg-blue-500/10 text-blue-600'
    : summary?.errorMessage
      ? 'bg-red-500/10 text-red-600'
      : summary?.stale
        ? 'bg-amber-500/10 text-amber-600'
        : 'bg-green-500/10 text-green-600'

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('chronicle_task_summary_collapsed', next ? '1' : '0')
  }

  useEffect(() => {
    setExpanded(false)
  }, [context?.taskId, latestProgress, nextStep])

  return (
    <div className="ml-auto w-full max-w-[560px] rounded-lg border border-border bg-card/95 px-3 py-2 shadow-sm">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={toggle}>
        <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Task summary</span>
        <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${stateClass}`}>{stateLabel}</span>
      </button>
      {!collapsed && (
        <div className="mt-2 grid gap-2 text-sm">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">Progress</div>
            <div className={`${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'} text-foreground`}>{latestProgress}</div>
          </div>
          {nextStep && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">Next step</div>
              <div className={`${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'} text-foreground`}>{nextStep}</div>
            </div>
          )}
          {canExpand && (
            <button
              type="button"
              className="w-fit text-xs font-medium text-primary hover:underline"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
          {summary?.errorMessage && <div className="text-xs text-red-600">{summary.errorMessage}</div>}
        </div>
      )}
    </div>
  )
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function TrackingStatusIndicator({ currentSession, tasks, onNavigate }: {
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
    <div className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-600 overflow-hidden cursor-pointer hover:brightness-125 transition flex items-center gap-1.5" style={{ width: '32ch', maxWidth: '32ch' }} onClick={onNavigate} title={trackedTask?.title}>
      <span className="whitespace-nowrap shrink-0 font-mono">{t('workspace.tracking')} {formatDuration(elapsed)}</span>
      <span ref={containerRef} className="overflow-hidden min-w-0 leading-[1]">
        <span ref={titleRef} className={`block whitespace-nowrap ${isOverflowing ? 'animate-marquee' : 'truncate'}`}>
          {trackedTask?.title ?? ''}
        </span>
      </span>
    </div>
  )
}

export function IdleTimeIndicator() {
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
    return <span className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground">{t('workspace.notTracking')}</span>
  }
  return <span className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-600 font-mono">{t('workspace.idle')} {formatDuration(elapsed)}</span>
}
