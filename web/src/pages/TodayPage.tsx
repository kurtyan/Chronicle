import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bot, CalendarPlus, ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { useTaskStore } from '@/stores/taskStore'
import { TaskDetailWorkspace } from '@/components/TaskDetailWorkspace'
import { DayScriptEditor } from '@/components/DayScriptEditor'
import { buildPlanTodayDraft, confirmDayScriptProgressSync, fetchStartOfDayOffset, generateDailySummary, getDayScript, saveDayScript } from '@/services/api'
import type { DailySummaryResult, DayScriptBlock, DayScriptDocument, DayScriptFocusActivity, PlanTodayDraftResult, ProgressSyncConflict, Task, TaskProgressContext } from '@/types'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { buildDayScriptActivityKey, findActiveBlock } from '@/lib/dayScript'

const TODAY_LEFT_PANE_PERCENT_KEY = 'chronicle_today_left_pane_percent'
const TODAY_LEFT_PANE_MIN_PERCENT = 12
const TODAY_LEFT_PANE_MAX_PERCENT = 88

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

function calendarDate(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function workdayDate(offsetHours: number, date = new Date()): string {
  return calendarDate(new Date(date.getTime() - offsetHours * 3600_000))
}

function activityStorageKey(date: string): string {
  return `chronicle_day_script_focus_activity:${date}`
}

function activityMapKey(blockKey: string, taskId: string): string {
  return `${blockKey}::${taskId}`
}

function loadStoredFocusActivity(date: string): Map<string, DayScriptFocusActivity> {
  try {
    const raw = localStorage.getItem(activityStorageKey(date))
    const items = raw ? JSON.parse(raw) : []
    if (!Array.isArray(items)) return new Map()
    return new Map(items
      .filter((item): item is DayScriptFocusActivity => (
        typeof item?.blockKey === 'string'
        && typeof item?.taskId === 'string'
        && Number.isFinite(item?.firstEditedAt)
      ))
      .map((item) => [activityMapKey(item.blockKey, item.taskId), item]))
  } catch {
    return new Map()
  }
}

function saveStoredFocusActivity(date: string, activity: Map<string, DayScriptFocusActivity>): void {
  const items = [...activity.values()]
  if (items.length === 0) {
    localStorage.removeItem(activityStorageKey(date))
    return
  }
  localStorage.setItem(activityStorageKey(date), JSON.stringify(items))
}

function isEmptyDoc(document: Record<string, any> | null | undefined): boolean {
  const content = Array.isArray(document?.content) ? document.content : []
  return content.length === 0 || content.every((node: any) => {
    if (node.type === 'paragraph') {
      const text = (node.content ?? []).map((child: any) => child.text ?? '').join('').trim()
      return !text
    }
    return false
  })
}

function appendDocument(base: Record<string, any>, addition: Record<string, any>): Record<string, any> {
  const baseContent = Array.isArray(base?.content) ? base.content : []
  const addContent = Array.isArray(addition?.content) ? addition.content : []
  if (addContent.length === 0) return base
  if (isEmptyDoc(base)) return { type: 'doc', content: addContent }
  const lastNode = baseContent[baseContent.length - 1]
  const separator = lastNode?.type === 'horizontalRule' ? [] : [{ type: 'horizontalRule' }]
  return { type: 'doc', content: [...baseContent, ...separator, ...addContent] }
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

function FocusStatusBar({ blocks, tasks, scriptDate, todayScriptDate }: { blocks: DayScriptBlock[]; tasks: Task[]; scriptDate: string; todayScriptDate: string }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const activeIndex = useMemo(() => scriptDate === todayScriptDate ? findActiveBlock(blocks, now) : -1, [blocks, now, scriptDate, todayScriptDate])
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

function NextStepsPanel({
  contexts,
  updatingIds,
  insertedIds,
  onInsert,
}: {
  contexts: TaskProgressContext[]
  updatingIds: Set<string>
  insertedIds: Set<string>
  onInsert: (context: TaskProgressContext) => void
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('chronicle_next_steps_panel_collapsed') === '1')

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('chronicle_next_steps_panel_collapsed', next ? '1' : '0')
  }

  if (contexts.length === 0) return null

  return (
    <div className="shrink-0 rounded-lg border border-border bg-card/95 p-3 shadow-sm">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={toggle}>
        <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Next steps</span>
        <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{contexts.length}</span>
      </button>
      {!collapsed && (
        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
          {contexts.map((context) => {
            const inserted = insertedIds.has(context.taskId)
            return (
              <div key={context.taskId} className="rounded-md border border-border/70 bg-background/80 px-2.5 py-2">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-muted-foreground" title={context.taskTitle}>{context.taskTitle}</div>
                    <div className="mt-0.5 line-clamp-2 text-sm text-foreground">{context.summary.nextStep}</div>
                  </div>
                  <button
                    className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-default disabled:opacity-50"
                    disabled={inserted}
                    onClick={() => onInsert(context)}
                  >
                    {inserted ? 'Inserted' : 'Insert'}
                  </button>
                </div>
                {updatingIds.has(context.taskId) && <div className="mt-1 text-[11px] text-blue-600">Updating summary...</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function TodayPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTaskId = searchParams.get('task')
  const explicitDateParam = searchParams.get('date')
  const [startOfDayOffset, setStartOfDayOffset] = useState(5)
  const todayScriptDate = useMemo(() => workdayDate(startOfDayOffset), [startOfDayOffset])
  const [displayDate, setDisplayDate] = useState(() => explicitDateParam || workdayDate(5))
  const [script, setScript] = useState<DayScriptDocument | null>(null)
  const [loadingScript, setLoadingScript] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ProgressSyncConflict[]>([])
  const [dailySummary, setDailySummary] = useState<DailySummaryResult | null>(null)
  const [dailySummaryError, setDailySummaryError] = useState('')
  const [dailySummaryLoading, setDailySummaryLoading] = useState(false)
  const [planDraft, setPlanDraft] = useState<PlanTodayDraftResult | null>(null)
  const [planDraftDoc, setPlanDraftDoc] = useState<Record<string, any> | null>(null)
  const [planDraftError, setPlanDraftError] = useState('')
  const [planDraftLoading, setPlanDraftLoading] = useState(false)
  const [insertedNextStepIds, setInsertedNextStepIds] = useState<Set<string>>(() => new Set())
  const [leftPanePercent, setLeftPanePercent] = useState(() => {
    const saved = Number(localStorage.getItem(TODAY_LEFT_PANE_PERCENT_KEY))
    return Number.isFinite(saved) && saved >= TODAY_LEFT_PANE_MIN_PERCENT && saved <= TODAY_LEFT_PANE_MAX_PERCENT ? saved : 50
  })
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  const tasks = useTaskStore((s) => s.tasks)
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  const loadTodos = useTaskStore((s) => s.loadTodos)
  const setActiveTask = useTaskStore((s) => s.setActiveTask)
  const loadCurrentSession = useTaskStore((s) => s.loadCurrentSession)
  const autoTakeOver = useTaskStore((s) => s.autoTakeOver)
  const doAfk = useTaskStore((s) => s.doAfk)
  const taskContexts = useTaskStore((s) => s.taskContexts)
  const taskSummaryUpdating = useTaskStore((s) => s.taskSummaryUpdating)
  const loadTaskContexts = useTaskStore((s) => s.loadTaskContexts)
  const autoTakeOverInFlightRef = useRef<string | null>(null)
  const focusActivityRef = useRef<Map<string, DayScriptFocusActivity>>(loadStoredFocusActivity(displayDate))

  useEffect(() => {
    loadTodos()
    loadCurrentSession()
    loadTaskContexts().catch((error) => console.error('Failed to load task contexts:', error))
  }, [loadTodos, loadCurrentSession, loadTaskContexts])

  useEffect(() => {
    let cancelled = false
    fetchStartOfDayOffset()
      .then((offset) => {
        if (cancelled) return
        setStartOfDayOffset(offset)
        if (!explicitDateParam) setDisplayDate(workdayDate(offset))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedTaskId) setActiveTask(selectedTaskId)
  }, [selectedTaskId, setActiveTask])

  useEffect(() => {
    if (!activeTaskId) return
    const next = new URLSearchParams(searchParams)
    next.set('task', activeTaskId)
    if (displayDate !== todayScriptDate) next.set('date', displayDate)
    else next.delete('date')
    setSearchParams(next, { replace: true })
  }, [activeTaskId, displayDate, todayScriptDate])

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (displayDate !== todayScriptDate) next.set('date', displayDate)
    else next.delete('date')
    setSearchParams(next, { replace: true })
  }, [displayDate, todayScriptDate])

  useEffect(() => {
    let cancelled = false
    focusActivityRef.current = loadStoredFocusActivity(displayDate)
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
  const nextStepContexts = useMemo(() => {
    const pendingIds = new Set(pendingTasks.map((task) => task.id))
    return Object.values(taskContexts)
      .filter((context) => pendingIds.has(context.taskId) && context.summary.nextStep.trim())
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  }, [pendingTasks, taskContexts])

  function appendNextStep(context: TaskProgressContext) {
    if (!script) return
    const linkAttrs = {
      href: `/today?task=${encodeURIComponent(context.taskId)}`,
      taskId: context.taskId,
    }
    const nextNode = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Next step ' },
        { type: 'text', text: `@${context.taskTitle}`, marks: [{ type: 'link', attrs: linkAttrs }] },
        { type: 'text', text: `: ${context.summary.nextStep}` },
      ],
    }
    const document = script.document && script.document.type === 'doc'
      ? script.document
      : { type: 'doc', content: [] }
    const content = Array.isArray(document.content) ? [...document.content] : []
    const nextContent = [...content, nextNode]
    const nextDocument = { ...document, content: nextContent }
    setScript({ ...script, document: nextDocument })
    setInsertedNextStepIds((ids) => new Set(ids).add(context.taskId))
  }

  async function handleSave() {
    if (!script) return
    try {
      setSaveError(null)
      const previousBlocks = script.blocks
      const focusActivity = [...focusActivityRef.current.values()]
      const result = await saveDayScript(displayDate, {
        expectedRevision: script.revision,
        document: script.document,
        focusActivity,
      })
      if (result.validationErrors.length > 0) {
        const first = result.validationErrors[0]
        setSaveError(`Line ${first.lineIndex + 1}: ${first.message}`)
        return
      }
      setScript(result.script)
      setConflicts(result.conflicts)
      await loadTodos()
      const createdTaskId = result.createdTasks[0]?.id
      if (createdTaskId) {
        await setActiveTask(createdTaskId)
      } else if (activeTaskId) {
        await setActiveTask(activeTaskId)
      }
      if (result.executionRecords.length > 0) {
        for (const record of result.executionRecords) {
          const block = result.script.blocks.find((item) => item.id === record.blockId)
          if (!block) continue
          const blockKey = buildDayScriptActivityKey(block, record.taskId)
          focusActivityRef.current.delete(activityMapKey(blockKey, record.taskId))
        }
        saveStoredFocusActivity(displayDate, focusActivityRef.current)
      }
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

  async function handleDailySummary() {
    setDailySummaryLoading(true)
    setDailySummaryError('')
    setDailySummary(null)
    try {
      const result = await generateDailySummary(displayDate)
      setDailySummary(result)
    } catch (error: any) {
      setDailySummaryError(error?.response?.data?.error || error?.message || 'Failed to generate daily summary.')
    } finally {
      setDailySummaryLoading(false)
    }
  }

  async function handlePlanToday() {
    setPlanDraftLoading(true)
    setPlanDraftError('')
    try {
      await loadTaskContexts()
      const result = await buildPlanTodayDraft(displayDate)
      setPlanDraft(result)
      setPlanDraftDoc(result.document)
    } catch (error: any) {
      setPlanDraftError(error?.response?.data?.error || error?.message || 'Failed to build plan.')
    } finally {
      setPlanDraftLoading(false)
    }
  }

  function applyPlanToday() {
    if (!script || !planDraftDoc) return
    setScript({ ...script, document: appendDocument(script.document, planDraftDoc) })
    setPlanDraft(null)
    setPlanDraftDoc(null)
  }

  const updatePanePercent = useCallback((nextPercent: number) => {
    const clamped = Math.min(TODAY_LEFT_PANE_MAX_PERCENT, Math.max(TODAY_LEFT_PANE_MIN_PERCENT, nextPercent))
    setLeftPanePercent(clamped)
    localStorage.setItem(TODAY_LEFT_PANE_PERCENT_KEY, String(clamped))
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
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden">
              <button
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-muted disabled:opacity-60"
                onClick={handlePlanToday}
                disabled={planDraftLoading || loadingScript || !script}
                title="Plan Today with LLM task context"
                aria-label="Plan Today with LLM task context"
              >
                {planDraftLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
              </button>
              <button
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-muted disabled:opacity-60"
                onClick={handleDailySummary}
                disabled={dailySummaryLoading || loadingScript || !script}
                title="Generate Daily Summary with LLM"
                aria-label="Generate Daily Summary with LLM"
              >
                {dailySummaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </button>
              {script ? <FocusStatusBar blocks={script.blocks} tasks={tasks} scriptDate={displayDate} todayScriptDate={todayScriptDate} /> : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5">
            {loadingScript || !script ? (
              <div className="flex min-h-[520px] flex-1 items-center justify-center rounded-2xl border border-dashed border-border px-4 py-16 text-center text-sm text-muted-foreground">
                {loadError ?? 'Loading Day Script...'}
              </div>
            ) : (
              <div className="relative flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                {saveError && (
                  <div className="absolute right-3 top-3 z-20 max-w-[70%] rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 shadow">
                    {saveError}
                  </div>
                )}
                <NextStepsPanel
                  contexts={nextStepContexts}
                  updatingIds={taskSummaryUpdating}
                  insertedIds={insertedNextStepIds}
                  onInsert={appendNextStep}
                />
                <DayScriptEditor
                  value={script.document}
                  tasks={pendingTasks}
                  scriptDate={displayDate}
                  todayScriptDate={todayScriptDate}
                  onChange={(document) => {
                    setSaveError(null)
                    setScript((prev) => prev ? { ...prev, document } : prev)
                  }}
                  onSave={handleSave}
                  onNavigateTask={(taskId) => setActiveTask(taskId)}
                  onEditingTask={({ taskId, blockKey }) => {
                    const key = activityMapKey(blockKey, taskId)
                    if (!focusActivityRef.current.has(key)) {
                      focusActivityRef.current.set(key, { blockKey, taskId, firstEditedAt: Date.now() })
                      saveStoredFocusActivity(displayDate, focusActivityRef.current)
                    }
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
          aria-valuemin={TODAY_LEFT_PANE_MIN_PERCENT}
          aria-valuemax={TODAY_LEFT_PANE_MAX_PERCENT}
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

      <Dialog open={Boolean(dailySummary) || Boolean(dailySummaryError) || dailySummaryLoading} onOpenChange={(open) => {
        if (!open && !dailySummaryLoading) {
          setDailySummary(null)
          setDailySummaryError('')
        }
      }}>
        <DialogContent className="max-h-[85vh] sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              Daily Summary
              {dailySummary?.cached && <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Cached</span>}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="min-h-0 overflow-y-auto">
            {dailySummaryLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating daily summary...
              </div>
            ) : dailySummaryError ? (
              <div className="text-sm text-destructive">{dailySummaryError}</div>
            ) : (
              <textarea
                readOnly
                value={dailySummary?.summaryMarkdown ?? ''}
                className="min-h-[520px] w-full resize-y rounded-md border bg-background p-3 font-mono text-sm leading-6 outline-none focus:ring-1 focus:ring-primary"
              />
            )}
          </DialogBody>
          <DialogFooter>
            <button className="dialog-button-secondary" onClick={() => {
              setDailySummary(null)
              setDailySummaryError('')
            }} disabled={dailySummaryLoading}>
              Close
            </button>
            <button className="dialog-button-secondary" onClick={async () => {
              setDailySummaryLoading(true)
              setDailySummaryError('')
              try {
                setDailySummary(await generateDailySummary(displayDate, { refresh: true }))
              } catch (error: any) {
                setDailySummaryError(error?.response?.data?.error || error?.message || 'Failed to regenerate daily summary.')
              } finally {
                setDailySummaryLoading(false)
              }
            }} disabled={dailySummaryLoading}>
              Regenerate
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(planDraft) || Boolean(planDraftError)} onOpenChange={(open) => {
        if (!open) {
          setPlanDraft(null)
          setPlanDraftDoc(null)
          setPlanDraftError('')
        }
      }}>
        <DialogContent className="max-h-[88vh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Plan Today</DialogTitle>
          </DialogHeader>
          <DialogBody className="min-h-0 overflow-y-auto">
            {planDraftError ? (
              <div className="text-sm text-destructive">{planDraftError}</div>
            ) : planDraftDoc ? (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  {planDraft?.sources.taskCount ?? 0} task lines · {planDraft?.sources.recommendedTaskCount ?? 0} recommendations · {planDraft?.sources.carriedBlockCount ?? 0} carried focus lines
                </div>
                <div className="min-h-[520px] rounded-lg border border-border">
                  <DayScriptEditor
                    value={planDraftDoc}
                    tasks={pendingTasks}
                    scriptDate={displayDate}
                    todayScriptDate={todayScriptDate}
                    onChange={setPlanDraftDoc}
                    onSave={() => {}}
                    onNavigateTask={(taskId) => setActiveTask(taskId)}
                    onEditingTask={() => {}}
                  />
                </div>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <button className="dialog-button-secondary" onClick={() => {
              setPlanDraft(null)
              setPlanDraftDoc(null)
              setPlanDraftError('')
            }}>
              Cancel
            </button>
            <button className="dialog-button-primary" onClick={applyPlanToday} disabled={!planDraftDoc}>
              Apply
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
