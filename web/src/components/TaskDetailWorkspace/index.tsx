import { useState, useRef, useCallback, useEffect } from 'react'
import { useTaskStore } from '@/stores/taskStore'
import { useI18n } from '@/i18n/context'
import type { TaskEntry, WorkSession, Task } from '@/types'
import { TaskEntryBlock } from '@/components/TaskEntryBlock'
import { RichEditor } from '@/components/RichEditor'
import { getTaskExtraInfoValue } from '@/services/api'
import { updatePlanItem, takeOverTask } from '@/services/api'
import { isTauriEnv } from '@/services/httpApi'
import { registerShortcut } from '@/shortcuts/registry'
import { Copy, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'

function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  const text = html.replace(/<[^>]*>/g, '').trim()
  return text.length === 0
}

interface TaskDetailWorkspaceProps {
  highlightEntryId?: string
}

export function TaskDetailWorkspace({ highlightEntryId }: TaskDetailWorkspaceProps) {
  const { t } = useI18n()
  const {
    selectedTask, entries, entryLoading, activeTaskId, tasks,
    currentSession, searchMode, searchTokens,
    updateTask, markDone, submitEntry, updateEntry,
    takeOver, doAfk, autoTakeOver, doDrop,
    setActiveTask, setLogContentDraft, clearLogContentDraft,
  } = useTaskStore()

  const logContent = activeTaskId ? (useTaskStore.getState().logContentDraft[activeTaskId] || '') : ''

  // Editing state
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [showDropDialog, setShowDropDialog] = useState(false)
  const [dropReason, setDropReason] = useState('')
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null)
  const prevLogEmpty = useRef(true)

  const DRAFT_ID = '__draft__'
  const isDraftActive = activeTaskId === DRAFT_ID

  const handleLogContentChange = useCallback((html: string) => {
    const isEmpty = isHtmlEmpty(html)
    setLogContentDraft(activeTaskId ?? '', html)
    if (prevLogEmpty.current && !isEmpty && activeTaskId && activeTaskId !== DRAFT_ID) {
      autoTakeOver(activeTaskId)
    }
    prevLogEmpty.current = isEmpty
  }, [activeTaskId, autoTakeOver, setLogContentDraft])

  const handleStartTask = async () => {
    if (!activeTaskId || isDraftActive) return
    await updateTask(activeTaskId, { status: 'DOING' })
  }

  const handleCompleteTask = async () => {
    if (!activeTaskId || isDraftActive) return
    if (!isHtmlEmpty(logContent)) {
      await submitEntry(activeTaskId, logContent.trim(), 'log')
      clearLogContentDraft(activeTaskId)
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

  const handlePlanAction = async (detailId: string, status: 'DOING' | 'DONE' | 'SKIPPED') => {
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

  const handleSubmitLog = async () => {
    if (!activeTaskId || isDraftActive) return
    const content = useTaskStore.getState().logContentDraft[activeTaskId] || ''
    if (isHtmlEmpty(content)) return
    await submitEntry(activeTaskId, content.trim(), 'log')
    clearLogContentDraft(activeTaskId)
  }

  // Save draft silently — content is already persisted in Zustand store's logContentDraft.
  // No server call needed; this just prevents accidental data loss in memory.
  const saveSilently = useCallback(async () => {
    // Draft is already in the store — no-op, keep the editor state as-is.
  }, [])

  // Auto-save draft every 30s
  useEffect(() => {
    const timer = setInterval(() => { saveSilently() }, 30000)
    return () => clearInterval(timer)
  }, [saveSilently])

  // Register task-detail keyboard shortcuts (work on both Board and Today pages)
  useEffect(() => {
    const unregisters: (() => void)[] = []

    // Ctrl+Enter: Submit entry
    unregisters.push(registerShortcut({
      id: 'submit-entry',
      combo: 'ctrl+enter',
      label: 'Submit entry',
      scope: 'page',
      handler: () => {
        const state = useTaskStore.getState()
        if (state.activeTaskId) {
          const storeLog = state.logContentDraft[state.activeTaskId] || ''
          if (!isHtmlEmpty(storeLog)) {
            submitEntry(state.activeTaskId, storeLog.trim(), 'log')
            clearLogContentDraft(state.activeTaskId)
          }
        }
      },
    }))

    // ArrowRight: Focus log editor
    unregisters.push(registerShortcut({
      id: 'focus-log-editor',
      combo: 'ArrowRight',
      label: 'Focus log editor',
      scope: 'page',
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
            {currentSession ? (
              <TrackingStatusIndicator
                currentSession={currentSession}
                tasks={tasks}
                onNavigate={() => {
                  if (currentSession.taskId) setActiveTask(currentSession.taskId)
                }}
              />
            ) : (
              <IdleTimeIndicator />
            )}
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
      </div>

      {/* Drop dialog */}
      <Dialog open={showDropDialog} onOpenChange={(open) => { if (!open) { setShowDropDialog(false); setDropReason(''); setDropTargetId(null) } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-red-100 flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <DialogTitle className="text-lg">{t('workspace.dropConfirm')}</DialogTitle>
                <p className="text-sm text-muted-foreground mt-0.5">
                  此操作将废弃任务「<span className="font-medium text-foreground">{dropTargetId ? tasks.find(t => t.id === dropTargetId)?.title : ''}</span>」，并终止当前工作记录
                </p>
              </div>
            </div>
          </DialogHeader>
          <DialogDescription className="text-sm text-muted-foreground">请说明废弃原因，以便后续追溯</DialogDescription>
          <textarea className="w-full text-sm px-3 py-2.5 border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary resize-none min-h-[80px]" value={dropReason} onChange={(e) => setDropReason(e.target.value)} placeholder="请输入废弃原因..." rows={3} autoFocus />
          <DialogFooter>
            <button className="px-5 py-2 text-sm rounded-lg border border-border hover:bg-muted transition" onClick={() => { setShowDropDialog(false); setDropReason(''); setDropTargetId(null) }}>
              {t('task.cancel')}
            </button>
            <button className="px-5 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed" disabled={!dropReason.trim()} onClick={handleDropConfirm}>
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
                  editing={editingEntryId === entry.id}
                  highlightTokens={searchMode ? searchTokens : undefined}
                  highlightPlan={entry.id === highlightEntryId}
                  taskId={selectedTask.id}
                  planStatus={entry.planStatus}
                  planDetailId={entry.planDetailId}
                  onPlanStart={(detailId) => handlePlanAction(detailId, 'DOING')}
                  onPlanComplete={(detailId) => handlePlanAction(detailId, 'DONE')}
                  onPlanSkip={(detailId) => handlePlanAction(detailId, 'SKIPPED')}
                  onEditingChange={(editing) => {
                    if (editing) {
                      setEditingEntryId(entry.id)
                      if (activeTaskId && activeTaskId !== DRAFT_ID) autoTakeOver(activeTaskId)
                      // Auto-start plan entry when editing starts
                      if (entry.type === 'plan' && entry.planDetailId && entry.planStatus === 'PLANNED') {
                        handlePlanAction(entry.planDetailId, 'DOING')
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
          {selectedTask.status !== 'DONE' && selectedTask.status !== 'DROPPED' && !editingEntryId && (
            <>
              <div>
                <RichEditor
                  key={`log-${activeTaskId ?? 'none'}`}
                  content={logContent}
                  onChange={handleLogContentChange}
                  placeholder={t('task.logPlaceholder')}
                  variant="full"
                  taskId={activeTaskId ?? undefined}
                  onKeyDown={(e) => {
                    // Cmd+S: Save draft without exiting edit mode
                    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                      e.preventDefault(); e.stopPropagation()
                      saveSilently()
                      return
                    }
                    if (e.ctrlKey && e.key === 'Enter') {
                    }
                  }}
                />
              </div>
              <button className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 text-sm" onClick={handleSubmitLog} disabled={isHtmlEmpty(logContent)}>
                {t('workspace.submitLog')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
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
