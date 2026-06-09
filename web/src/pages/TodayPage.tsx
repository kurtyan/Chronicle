import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTaskStore } from '@/stores/taskStore'
import { TaskDetailWorkspace } from '@/components/TaskDetailWorkspace'
import { DayScriptEditor } from '@/components/DayScriptEditor'
import { confirmDayScriptProgressSync, getDayScript, saveDayScript } from '@/services/api'
import type { DayScriptBlock, DayScriptDocument, ProgressSyncConflict, Task } from '@/types'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { findActiveBlock } from '@/lib/dayScript'

function dateOffset(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(year, month - 1, day + offset)
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-')
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

function todayDate(): string {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

function getBlockTitle(block: DayScriptBlock, tasksById: Map<string, Task>): string {
  const taskTitle = block.taskIds.map((taskId) => tasksById.get(taskId)?.title).find(Boolean)
  if (taskTitle) return taskTitle
  return block.headerText || `${block.startTime}-${block.endTime}`
}

function getMinutesUntil(endTime: string, now: Date): number {
  const [endHour, endMinute] = endTime.split(':').map(Number)
  return endHour * 60 + endMinute - (now.getHours() * 60 + now.getMinutes())
}

function FocusStatusBar({ blocks, tasks, scriptDate }: { blocks: DayScriptBlock[]; tasks: Task[]; scriptDate: string }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const activeIndex = useMemo(() => scriptDate === todayDate() ? findActiveBlock(blocks, now) : -1, [blocks, now, scriptDate])
  const activeBlock = activeIndex >= 0 ? blocks[activeIndex] : null

  if (!activeBlock) {
    return <div className="truncate text-sm text-muted-foreground">No active focus block</div>
  }

  const minutesLeft = Math.max(0, getMinutesUntil(activeBlock.endTime, now))
  const title = getBlockTitle(activeBlock, tasksById)

  return (
    <div className="flex h-10 w-full min-w-0 flex-nowrap items-center justify-end gap-3 overflow-hidden rounded-xl border border-border bg-card px-4 text-right shadow-sm">
      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm font-semibold text-foreground" title={title}>{title}</span>
      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{activeBlock.startTime}-{activeBlock.endTime}</span>
      <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-foreground">{minutesLeft} min left</span>
    </div>
  )
}

export function TodayPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTaskId = searchParams.get('task')
  const [displayDate, setDisplayDate] = useState(() => searchParams.get('date') || todayDate())
  const [script, setScript] = useState<DayScriptDocument | null>(null)
  const [loadingScript, setLoadingScript] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ProgressSyncConflict[]>([])
  const [leftPanePercent, setLeftPanePercent] = useState(() => {
    const saved = Number(localStorage.getItem('chronicle_today_left_pane_percent'))
    return Number.isFinite(saved) && saved >= 25 && saved <= 75 ? saved : 50
  })
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  const tasks = useTaskStore((s) => s.tasks)
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  const loadTodos = useTaskStore((s) => s.loadTodos)
  const setActiveTask = useTaskStore((s) => s.setActiveTask)
  const loadCurrentSession = useTaskStore((s) => s.loadCurrentSession)
  const autoTakeOver = useTaskStore((s) => s.autoTakeOver)
  const doAfk = useTaskStore((s) => s.doAfk)
  const autoTakeOverInFlightRef = useRef<string | null>(null)

  useEffect(() => {
    loadTodos()
    loadCurrentSession()
  }, [loadTodos, loadCurrentSession])

  useEffect(() => {
    if (selectedTaskId) setActiveTask(selectedTaskId)
  }, [selectedTaskId, setActiveTask])

  useEffect(() => {
    if (!activeTaskId) return
    const next = new URLSearchParams(searchParams)
    next.set('task', activeTaskId)
    if (displayDate !== todayDate()) next.set('date', displayDate)
    else next.delete('date')
    setSearchParams(next, { replace: true })
  }, [activeTaskId])

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (displayDate !== todayDate()) next.set('date', displayDate)
    else next.delete('date')
    setSearchParams(next, { replace: true })
  }, [displayDate])

  useEffect(() => {
    let cancelled = false
    setLoadingScript(true)
    setLoadError(null)
    setSaveError(null)
    setScript(null)
    getDayScript(displayDate)
      .then((data) => {
        if (!cancelled) setScript(data)
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error?.message ?? 'Failed to load Day Script.')
      })
      .finally(() => {
        if (!cancelled) setLoadingScript(false)
      })
    return () => {
      cancelled = true
    }
  }, [displayDate])

  const pendingTasks = useMemo(
    () => tasks.filter((task) => task.status === 'PENDING' || task.status === 'DOING').sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks]
  )

  async function handleSave() {
    if (!script) return
    try {
      setSaveError(null)
      const previousBlocks = script.blocks
      const result = await saveDayScript(displayDate, {
        expectedRevision: script.revision,
        document: script.document,
      })
      if (result.validationErrors.length > 0) {
        const first = result.validationErrors[0]
        setSaveError(`Line ${first.lineIndex + 1}: ${first.message}`)
        return
      }
      setScript(result.script)
      setConflicts(result.conflicts)
      await loadTodos()
      if (activeTaskId) await setActiveTask(activeTaskId)
      const previouslyCompletedIds = new Set(previousBlocks.filter((block) => block.completed).map((block) => block.id))
      const newlyCompletedIds = new Set(
        result.script.blocks
          .filter((block) => block.completed && !previouslyCompletedIds.has(block.id))
          .map((block) => block.id)
      )
      if (result.createdLogs.some((item) => newlyCompletedIds.has(item.blockId))) {
        await doAfk()
      }
    } catch (error: any) {
      console.error('Failed to save Day Script:', error)
      const status = error?.response?.status
      setSaveError(status === 409 ? 'Save conflict. Reload this date before saving again.' : (error?.message ?? 'Failed to save Day Script.'))
    }
  }

  async function handleConfirmConflicts() {
    if (conflicts.length === 0) return
    const result = await confirmDayScriptProgressSync(displayDate, conflicts.map((item) => ({ blockId: item.blockId, taskId: item.taskId })))
    setConflicts([])
    if (activeTaskId) await setActiveTask(activeTaskId)
    if (result.createdLogs.length > 0) {
      await doAfk()
    }
  }

  const updatePanePercent = useCallback((nextPercent: number) => {
    const clamped = Math.min(75, Math.max(25, nextPercent))
    setLeftPanePercent(clamped)
    localStorage.setItem('chronicle_today_left_pane_percent', String(clamped))
  }, [])

  const handleDividerMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const container = splitContainerRef.current
    if (!container) return

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const bounds = container.getBoundingClientRect()
      updatePanePercent(((moveEvent.clientX - bounds.left) / bounds.width) * 100)
    }

    const handleMouseUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [updatePanePercent])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={splitContainerRef} className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 shrink-0 flex-col bg-background"
          style={{ width: `${leftPanePercent}%` }}
        >
          <div className="flex h-16 flex-nowrap items-center gap-5 border-b bg-card/60 px-6">
            <div className="flex shrink-0 items-center gap-3">
              <button className="rounded-lg border border-border p-2 hover:bg-muted" onClick={() => setDisplayDate((value) => dateOffset(value, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="whitespace-nowrap text-lg font-semibold">{formatDate(displayDate)}</div>
              <button className="rounded-lg border border-border p-2 hover:bg-muted" onClick={() => setDisplayDate((value) => dateOffset(value, 1))}>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-w-0 flex-1 items-center justify-end">
              {script ? <FocusStatusBar blocks={script.blocks} tasks={tasks} scriptDate={displayDate} /> : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5">
            {loadingScript || !script ? (
              <div className="flex min-h-[520px] flex-1 items-center justify-center rounded-2xl border border-dashed border-border px-4 py-16 text-center text-sm text-muted-foreground">
                {loadError ?? 'Loading Day Script...'}
              </div>
            ) : (
              <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
                {saveError && (
                  <div className="absolute right-3 top-3 z-20 max-w-[70%] rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 shadow">
                    {saveError}
                  </div>
                )}
                <DayScriptEditor
                  value={script.document}
                  tasks={pendingTasks}
                  scriptDate={displayDate}
                  onChange={(document) => {
                    setSaveError(null)
                    setScript((prev) => prev ? { ...prev, document } : prev)
                  }}
                  onSave={handleSave}
                  onNavigateTask={(taskId) => setActiveTask(taskId)}
                  onEditingTask={(taskId) => {
                    if (activeTaskId !== taskId) {
                      setActiveTask(taskId).catch((error) => console.error('Failed to focus task from Day Script:', error))
                    }
                    if (autoTakeOverInFlightRef.current === taskId) return
                    autoTakeOverInFlightRef.current = taskId
                    autoTakeOver(taskId)
                      .catch((error) => console.error('Failed to auto take over task from Day Script:', error))
                      .finally(() => {
                        if (autoTakeOverInFlightRef.current === taskId) autoTakeOverInFlightRef.current = null
                      })
                  }}
                />
              </div>
            )}
          </div>
        </section>

        <div
          role="separator"
          aria-label="Resize focus and task detail panels"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(leftPanePercent)}
          tabIndex={0}
          className="group relative z-20 w-px shrink-0 cursor-col-resize bg-border outline-none focus:bg-primary"
          onMouseDown={handleDividerMouseDown}
          onDoubleClick={() => updatePanePercent(50)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              updatePanePercent(leftPanePercent - 2)
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              updatePanePercent(leftPanePercent + 2)
            }
          }}
        >
          <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 transition-colors group-hover:bg-primary/15" />
          <div className="absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-primary group-focus:bg-primary" />
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TaskDetailWorkspace showTrackingStatus />
          </div>
        </section>
      </div>

      <Dialog open={conflicts.length > 0} onOpenChange={(open) => { if (!open) setConflicts([]) }}>
        <DialogContent className="max-h-[85vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Progress sync confirmation</DialogTitle>
          </DialogHeader>
          <DialogBody className="min-h-0 overflow-y-auto">
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">Some completed blocks edited previously synced progress. Confirm to append the current block progress as a new task log snapshot.</p>
              {conflicts.map((conflict) => (
                <div key={`${conflict.blockId}:${conflict.taskId}`} className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="font-medium">{conflict.taskTitle} · {conflict.startTime}-{conflict.endTime}</div>
                  <div className="mt-2 text-xs text-muted-foreground">Previously synced</div>
                  <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-background px-2 py-1" style={{ scrollbarGutter: 'stable' }}>{conflict.existingProgress || '(empty)'}</div>
                  <div className="mt-2 text-xs text-muted-foreground">Current block progress</div>
                  <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-background px-2 py-1" style={{ scrollbarGutter: 'stable' }}>{conflict.currentProgress || '(empty)'}</div>
                </div>
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            <button className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" onClick={() => setConflicts([])}>
              Later
            </button>
            <button className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90" onClick={handleConfirmConflicts}>
              Create logs
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
