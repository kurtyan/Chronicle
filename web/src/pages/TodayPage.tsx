import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bot, CalendarPlus, ChevronLeft, ChevronRight, Loader2, Maximize2, Plus, Sparkles, X } from 'lucide-react'
import { useTaskStore } from '@/stores/taskStore'
import { TaskDetailWorkspace } from '@/components/TaskDetailWorkspace'
import { DayScriptEditor } from '@/components/DayScriptEditor'
import { buildPlanTodayDraft, confirmDayScriptProgressSync, fetchDailySummaryCache, fetchStartOfDayOffset, fetchTodos, fetchWorkOverviewHiddenSignals, generateDailySummaryInBackground, getCarryOverDayScriptBlocks, getDayScript, hideWorkOverviewSignal, saveDayScript, submitDayScriptProgress } from '@/services/api'
import type { DailySummaryResult, DayScriptBlock, DayScriptBlockSource, DayScriptDocument, DayScriptFocusActivity, PlanTodayDraftResult, ProgressSyncConflict, Task, TaskProgressContext, WorkOverviewHidableSignalSourceType, WorkOverviewHiddenSignal } from '@/types'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { buildDayScriptActivityKey, findActiveBlock } from '@/lib/dayScript'
import { dailySummarySourceKey, useBackgroundTaskStore } from '@/stores/backgroundTaskStore'
import { recordAppError } from '@/stores/appErrorStore'
import { MarkdownView } from '@/components/MarkdownView'

const TODAY_LEFT_PANE_PERCENT_KEY = 'chronicle_today_left_pane_percent'
const TODAY_LEFT_PANE_MIN_PERCENT = 12
const TODAY_LEFT_PANE_MAX_PERCENT = 88
const OVERALL_NEXT_STEPS_COLLAPSED_KEY = 'chronicle_overall_next_steps_collapsed'

type NextStepSourceType = 'now' | 'focus' | 'explicit' | 'recommended' | 'carry_over'

type NextStepAction = {
  id: string
  taskId: string | null
  taskTitle: string
  taskStatus: string
  sourceType: NextStepSourceType
  blockSource: DayScriptBlockSource
  originScriptDate: string | null
  originBlockId: string | null
  originSource: DayScriptBlockSource | null
  signalKey: string
  canHideSignal: boolean
  text: string
  state: 'updating' | 'stale' | 'failed' | 'current' | 'pending'
  lastActivityAt: number | null
  timeLabel?: string
  inFocus: boolean
  canPlan: boolean
}

type WorkOverviewItem = {
  id: string
  taskId: string | null
  taskTitle: string
  taskStatus: string
  primaryAction: NextStepAction
  actions: NextStepAction[]
  state: NextStepAction['state']
  lastActivityAt: number | null
  inFocus: boolean
  canPlan: boolean
}

type WorkOverviewOrderState = {
  date: string
  next: number
  items: Map<string, number>
}

type SaveDraftResult = {
  ok: boolean
  current: boolean
  valid: boolean
  validationMessage?: string
}

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
  return { type: 'doc', content: [...baseContent, ...addContent] }
}

function getBlockTitle(block: DayScriptBlock, tasksById: Map<string, Task>): string {
  const taskTitle = block.taskIds.map((taskId) => tasksById.get(taskId)?.title).find(Boolean)
  if (taskTitle) return taskTitle
  return block.headerText || `${block.startTime}-${block.endTime}`
}

function getBlockActionText(block: DayScriptBlock): string {
  const header = block.headerText.trim()
  const progress = block.progressText.trim()
  if (header && progress) return `${header}: ${progress}`
  return header || progress || `${block.startTime}-${block.endTime}`
}

function normalizeActionText(text: string): string {
  return text
    .replace(/\b(next step|recommended|carry[- ]over)\b\s*:?\s*/gi, '')
    .replace(/[，。；;：:、,.!?！？()[\]{}"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function signalKeyForActionText(text: string): string {
  return normalizeActionText(text)
}

function signalKeyForCarryOverBlock(block: DayScriptBlock): string {
  return `${block.originScriptDate ?? ''}:${block.originBlockId ?? block.id}`
}

function isHidableSignalSource(sourceType: NextStepSourceType): sourceType is WorkOverviewHidableSignalSourceType {
  return sourceType === 'carry_over' || sourceType === 'explicit' || sourceType === 'recommended'
}

function hiddenSignalKey(input: { taskId: string; sourceType: WorkOverviewHidableSignalSourceType; signalKey: string }): string {
  return `${input.taskId}:${input.sourceType}:${input.signalKey}`
}

function actionTextForTask(text: string, taskTitle: string): string {
  const trimmed = text.trim()
  const mention = `@${taskTitle}`
  const mentionIndex = trimmed.indexOf(mention)
  if (mentionIndex >= 0) {
    const afterMention = trimmed.slice(mentionIndex + mention.length).trim().replace(/^:/, '').trim()
    if (afterMention) return afterMention
  }
  const colonIndex = trimmed.indexOf(':')
  return colonIndex >= 0 ? trimmed.slice(colonIndex + 1).trim() : trimmed
}

function areSimilarActions(leftText: string, rightText: string): boolean {
  const left = normalizeActionText(leftText)
  const right = normalizeActionText(rightText)
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

function getActionState(context: TaskProgressContext, updatingIds: Set<string>): NextStepAction['state'] {
  if (updatingIds.has(context.taskId)) return 'updating'
  if (context.summary.errorMessage) return 'failed'
  if (context.summary.stale) return 'stale'
  if (context.summary.summaryUpdatedAt) return 'current'
  return 'pending'
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

function OverallNextStepsBoard({
  items,
  onPlan,
  onOpen,
  onHideSignal,
  maximized = false,
  onMaximize,
  onCloseMaximized,
}: {
  items: WorkOverviewItem[]
  onPlan: (action: NextStepAction) => void
  onOpen: (action: NextStepAction) => void
  onHideSignal: (action: NextStepAction) => void
  maximized?: boolean
  onMaximize?: () => void
  onCloseMaximized?: () => void
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(OVERALL_NEXT_STEPS_COLLAPSED_KEY) === '1')
  const [openSignalMenu, setOpenSignalMenu] = useState<string | null>(null)

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem(OVERALL_NEXT_STEPS_COLLAPSED_KEY, next ? '1' : '0')
  }

  if (items.length === 0) return null

  const sourceLabel: Record<NextStepSourceType, string> = {
    now: 'Now',
    focus: 'Focus',
    explicit: 'Explicit',
    recommended: 'Recommended',
    carry_over: 'Carry-over',
  }
  const overviewLabelForItem = (item: WorkOverviewItem): string => {
    if (item.primaryAction.sourceType === 'now') return 'Now'
    if (item.primaryAction.sourceType === 'focus' || item.primaryAction.sourceType === 'carry_over') return 'Planned / carried'
    return 'Suggested'
  }
  const stateLabel: Record<NextStepAction['state'], string> = {
    updating: 'Updating',
    stale: 'Stale',
    failed: 'Failed',
    current: 'Current',
    pending: 'Pending',
  }
  const stateClass: Record<NextStepAction['state'], string> = {
    updating: 'bg-blue-500/10 text-blue-600',
    stale: 'bg-amber-500/10 text-amber-600',
    failed: 'bg-red-500/10 text-red-600',
    current: 'bg-green-500/10 text-green-600',
    pending: 'bg-muted text-muted-foreground',
  }
  const sourceActionsForItem = (item: WorkOverviewItem): NextStepAction[] => {
    const seen = new Set<NextStepSourceType>()
    const sourceActions: NextStepAction[] = []
    for (const action of item.actions) {
      if (seen.has(action.sourceType)) continue
      seen.add(action.sourceType)
      sourceActions.push(action)
    }
    return sourceActions
  }

  return (
    <div
      data-testid="overall-next-steps-board"
      className={maximized
        ? 'flex h-full min-h-0 flex-col rounded-xl border border-border bg-card p-5 shadow-2xl'
        : 'shrink-0 rounded-lg border border-border bg-card/95 p-3 shadow-sm'
      }
    >
      <div className="flex items-center justify-between gap-3">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={maximized ? undefined : toggle}>
          <span className={maximized ? 'text-base font-semibold text-foreground' : 'text-xs font-semibold uppercase tracking-normal text-muted-foreground'}>
            Work overview
          </span>
          <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{items.length}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {!maximized && onMaximize && (
            <button
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onMaximize}
              title="Maximize overall next steps"
              aria-label="Maximize overall next steps"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
          {maximized && onCloseMaximized && (
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onCloseMaximized}
              title="Close maximized overall next steps"
              aria-label="Close maximized overall next steps"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {(maximized || !collapsed) && (
        <div className={maximized ? 'mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1' : 'mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1'}>
          {items.map((item) => (
            <div
              key={item.id}
              data-next-step-action-id={item.primaryAction.id}
              data-next-step-source={item.primaryAction.sourceType}
              className={`rounded-md border border-border/70 bg-background/80 px-2.5 py-2 ${item.taskId ? 'cursor-pointer hover:bg-muted/50' : ''}`}
              onClick={() => {
                if (item.taskId) onOpen(item.primaryAction)
              }}
              role={item.taskId ? 'button' : undefined}
              aria-label={item.taskId ? `Open task ${item.taskId}` : undefined}
              tabIndex={item.taskId ? 0 : undefined}
              onKeyDown={(event) => {
                if (!item.taskId) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(item.primaryAction)
                }
              }}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{overviewLabelForItem(item)}</span>
                    <span className="truncate text-xs font-medium text-muted-foreground" title={item.taskTitle}>{item.taskTitle}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.taskStatus}</span>
                    {item.primaryAction.timeLabel && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.primaryAction.timeLabel}</span>}
                    {item.inFocus && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">In Focus</span>}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${stateClass[item.state]}`}>{stateLabel[item.state]}</span>
                    {sourceActionsForItem(item).map((action) => {
                      const menuKey = `${item.id}:${action.sourceType}:${action.signalKey}`
                      if (!action.canHideSignal) {
                        return <span key={menuKey} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceLabel[action.sourceType]}</span>
                      }
                      return (
                        <span key={menuKey} className="relative inline-flex">
                          <button
                            type="button"
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation()
                              setOpenSignalMenu((current) => current === menuKey ? null : menuKey)
                            }}
                            title={`Signal actions: ${sourceLabel[action.sourceType]}`}
                          >
                            {sourceLabel[action.sourceType]}
                          </button>
                          {openSignalMenu === menuKey && (
                            <div
                              className="absolute left-0 top-full z-50 mt-1 min-w-28 rounded-md border border-border bg-popover p-1 text-xs shadow-lg"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="block w-full rounded px-2 py-1.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
                                onClick={() => {
                                  setOpenSignalMenu(null)
                                  onHideSignal(action)
                                }}
                              >
                                Hide signal
                              </button>
                            </div>
                          )}
                        </span>
                      )
                    })}
                    {item.actions.length > 1 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.actions.length} signals</span>}
                  </div>
                  <div className={maximized ? 'mt-1 text-sm leading-6 text-foreground' : 'mt-1 line-clamp-2 text-sm text-foreground'}>{item.primaryAction.text}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {item.canPlan && (
                    <button
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted disabled:cursor-default disabled:opacity-50"
                      disabled={item.inFocus}
                      onClick={(event) => {
                        event.stopPropagation()
                        onPlan(item.primaryAction)
                      }}
                      title={item.inFocus ? 'Already in Focus' : 'Plan in Focus'}
                    >
                      <Plus className="h-3 w-3" />
                      {item.inFocus ? 'In Focus' : 'Plan'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function TodayPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTaskId = searchParams.get('task')
  const explicitDateParam = searchParams.get('date')
  const dailySummaryOpenRequest = searchParams.get('dailySummary')
  const [startOfDayOffset, setStartOfDayOffset] = useState(5)
  const todayScriptDate = useMemo(() => workdayDate(startOfDayOffset), [startOfDayOffset])
  const [displayDate, setDisplayDate] = useState(() => explicitDateParam || workdayDate(5))
  const [script, setScript] = useState<DayScriptDocument | null>(null)
  const [loadingScript, setLoadingScript] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved')
  const [scriptDirty, setScriptDirty] = useState(false)
  const [conflicts, setConflicts] = useState<ProgressSyncConflict[]>([])
  const [dailySummaryOpen, setDailySummaryOpen] = useState(false)
  const [dailySummary, setDailySummary] = useState<DailySummaryResult | null>(null)
  const [dailySummaryError, setDailySummaryError] = useState('')
  const [dailySummaryLoading, setDailySummaryLoading] = useState(false)
  const [dailySummaryShowSource, setDailySummaryShowSource] = useState(false)
  const [planDraft, setPlanDraft] = useState<PlanTodayDraftResult | null>(null)
  const [planDraftDoc, setPlanDraftDoc] = useState<Record<string, any> | null>(null)
  const [planDraftError, setPlanDraftError] = useState('')
  const [planDraftPreviewError, setPlanDraftPreviewError] = useState('')
  const [planDraftLoading, setPlanDraftLoading] = useState(false)
  const [carryOverBlocks, setCarryOverBlocks] = useState<DayScriptBlock[]>([])
  const [hiddenOverviewSignals, setHiddenOverviewSignals] = useState<WorkOverviewHiddenSignal[]>([])
  const [workOverviewTasks, setWorkOverviewTasks] = useState<Task[]>([])
  const [nextStepsMaximized, setNextStepsMaximized] = useState(false)
  const backgroundTasks = useBackgroundTaskStore((s) => s.tasks)
  const loadBackgroundTasks = useBackgroundTaskStore((s) => s.loadTasks)
  const setBackgroundPanelOpen = useBackgroundTaskStore((s) => s.setPanelOpen)
  const dailySummaryRunningTask = useMemo(() => backgroundTasks.find((task) =>
    task.type === 'daily_summary'
    && task.status === 'running'
    && task.sourceKey === dailySummarySourceKey(displayDate)
  ) ?? null, [backgroundTasks, displayDate])
  const dailySummaryFinishedTask = useMemo(() => backgroundTasks.find((task) =>
    task.type === 'daily_summary'
    && task.status === 'success'
    && task.sourceKey === dailySummarySourceKey(displayDate)
    && task.result
  ) ?? null, [backgroundTasks, displayDate])
  const dailySummaryErrorTask = useMemo(() => backgroundTasks.find((task) =>
    task.type === 'daily_summary'
    && task.status === 'error'
    && task.sourceKey === dailySummarySourceKey(displayDate)
  ) ?? null, [backgroundTasks, displayDate])
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
  const handledDailySummaryOpenRequestRef = useRef<string | null>(null)
  const focusActivityRef = useRef<Map<string, DayScriptFocusActivity>>(loadStoredFocusActivity(displayDate))
  const scriptRef = useRef<DayScriptDocument | null>(null)
  const displayDateRef = useRef(displayDate)
  const autosaveTimerRef = useRef<number | null>(null)
  const saveDraftInFlightRef = useRef<Promise<SaveDraftResult> | null>(null)
  const scriptDirtyRef = useRef(false)
  const editVersionRef = useRef(0)
  const workOverviewOrderRef = useRef<WorkOverviewOrderState>({ date: displayDate, next: 0, items: new Map() })

  useEffect(() => {
    scriptRef.current = script
  }, [script])

  useEffect(() => {
    displayDateRef.current = displayDate
  }, [displayDate])

  useEffect(() => {
    scriptDirtyRef.current = scriptDirty
  }, [scriptDirty])

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current === null) return
    window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = null
  }, [])

  const loadWorkOverviewTasks = useCallback(async () => {
    const openTasks = await fetchTodos(undefined, 'PENDING,DOING')
    setWorkOverviewTasks(openTasks)
  }, [])

  function recordDayScriptValidationError(endpoint: string, validationErrors: Array<{ lineIndex: number; message: string }>): string {
    const first = validationErrors[0]
    const message = first ? `Line ${first.lineIndex + 1}: ${first.message}` : 'Invalid Focus content.'
    recordAppError({
      endpoint,
      message,
      stack: JSON.stringify(validationErrors, null, 2),
    })
    return message
  }

  useEffect(() => {
    loadTodos()
    loadCurrentSession()
    loadWorkOverviewTasks().catch((error) => console.error('Failed to load Work overview tasks:', error))
    loadTaskContexts().catch((error) => console.error('Failed to load task contexts:', error))
  }, [loadTodos, loadCurrentSession, loadTaskContexts, loadWorkOverviewTasks])

  useEffect(() => {
    if (tasks.length === 0) return
    setWorkOverviewTasks((current) => {
      const next = new Map(current.map((task) => [task.id, task]))
      let changed = false
      for (const task of tasks) {
        if (task.status === 'PENDING' || task.status === 'DOING') {
          if (next.get(task.id) !== task) {
            next.set(task.id, task)
            changed = true
          }
        } else if (next.delete(task.id)) {
          changed = true
        }
      }
      return changed ? [...next.values()] : current
    })
  }, [tasks])

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
    if (selectedTaskId && selectedTaskId !== useTaskStore.getState().activeTaskId) void setActiveTask(selectedTaskId)
  }, [selectedTaskId, setActiveTask])

  useEffect(() => {
    if (explicitDateParam && explicitDateParam !== displayDate) {
      setDisplayDate(explicitDateParam)
    }
  }, [displayDate, explicitDateParam])

  useEffect(() => {
    if (!dailySummaryOpen || !dailySummaryFinishedTask?.result) return
    const result = dailySummaryFinishedTask.result
    if ('summaryMarkdown' in result) {
      setDailySummary(result)
      setDailySummaryLoading(false)
    }
  }, [dailySummaryFinishedTask, dailySummaryOpen])

  useEffect(() => {
    if (!dailySummaryOpen || !dailySummaryErrorTask || dailySummary || dailySummaryRunningTask) return
    setDailySummaryLoading(false)
    setDailySummaryError(dailySummaryErrorTask.error || 'Daily summary failed.')
  }, [dailySummary, dailySummaryErrorTask, dailySummaryOpen, dailySummaryRunningTask])

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (activeTaskId) next.set('task', activeTaskId)
    if (displayDate !== todayScriptDate) next.set('date', displayDate)
    else next.delete('date')
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true })
    }
  }, [activeTaskId, displayDate, searchParams, setSearchParams, todayScriptDate])

  useEffect(() => {
    let cancelled = false
    focusActivityRef.current = loadStoredFocusActivity(displayDate)
    clearAutosaveTimer()
    setScriptDirty(false)
    setSaveStatus('saved')
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
  }, [clearAutosaveTimer, displayDate])

  useEffect(() => {
    return () => clearAutosaveTimer()
  }, [clearAutosaveTimer])

  useEffect(() => {
    let cancelled = false
    getCarryOverDayScriptBlocks(displayDate)
      .then((data) => {
        if (!cancelled) setCarryOverBlocks(data)
      })
      .catch(() => {
        if (!cancelled) setCarryOverBlocks([])
      })
    return () => {
      cancelled = true
    }
  }, [displayDate])

  useEffect(() => {
    let cancelled = false
    fetchWorkOverviewHiddenSignals()
      .then((data) => {
        if (!cancelled) setHiddenOverviewSignals(data)
      })
      .catch((error) => {
        console.warn('Failed to load hidden Work overview signals:', error)
        if (!cancelled) setHiddenOverviewSignals([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!nextStepsMaximized) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNextStepsMaximized(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [nextStepsMaximized])

  const pendingTasks = useMemo(
    () => workOverviewTasks.filter((task) => task.status === 'PENDING' || task.status === 'DOING').sort((a, b) => b.updatedAt - a.updatedAt),
    [workOverviewTasks]
  )
  const workOverviewItems = useMemo(() => {
    const pendingIds = new Set(pendingTasks.map((task) => task.id))
    const tasksById = new Map([...tasks, ...workOverviewTasks].map((task) => [task.id, task]))
    const currentBlocks = script?.blocks ?? []
    const currentFocusTaskIds = new Set(currentBlocks.flatMap((block) => block.taskIds))
    const actions: NextStepAction[] = []
    const hiddenSignals = new Set(hiddenOverviewSignals.map(hiddenSignalKey))
    const sourceRank: Record<NextStepSourceType, number> = {
      now: 0,
      focus: 1,
      carry_over: 2,
      explicit: 3,
      recommended: 4,
    }

    const pushAction = (action: NextStepAction) => {
      if (!action.text.trim()) return
      if (
        action.taskId
        && action.canHideSignal
        && isHidableSignalSource(action.sourceType)
        && hiddenSignals.has(hiddenSignalKey({ taskId: action.taskId, sourceType: action.sourceType, signalKey: action.signalKey }))
      ) {
        return
      }
      actions.push(action)
    }

    const activeIndex = script && displayDate === todayScriptDate ? findActiveBlock(script.blocks, new Date()) : -1
    const activeBlock = activeIndex >= 0 ? script!.blocks[activeIndex] : null
    if (activeBlock && !activeBlock.completed) {
      const taskId = activeBlock.taskIds[0] ?? null
      const task = taskId ? tasksById.get(taskId) : null
      pushAction({
        id: `now:${activeBlock.id}:${taskId ?? 'none'}`,
        taskId,
        taskTitle: task?.title ?? getBlockTitle(activeBlock, tasksById),
        taskStatus: task?.status ?? 'FOCUS',
        sourceType: 'now',
        blockSource: activeBlock.source,
        originScriptDate: activeBlock.originScriptDate,
        originBlockId: activeBlock.originBlockId,
        originSource: activeBlock.originSource,
        signalKey: '',
        canHideSignal: false,
        text: getBlockActionText(activeBlock),
        state: 'current',
        lastActivityAt: task?.updatedAt ?? null,
        timeLabel: activeBlock.startTime && activeBlock.endTime ? `${activeBlock.startTime}-${activeBlock.endTime}` : undefined,
        inFocus: true,
        canPlan: false,
      })
    }

    for (const block of currentBlocks) {
      if (block.completed || block.id === activeBlock?.id) continue
      const taskId = block.taskIds[0] ?? null
      const task = taskId ? tasksById.get(taskId) : null
      pushAction({
        id: `focus:${block.id}:${taskId ?? 'none'}`,
        taskId,
        taskTitle: task?.title ?? getBlockTitle(block, tasksById),
        taskStatus: task?.status ?? 'FOCUS',
        sourceType: 'focus',
        blockSource: block.source,
        originScriptDate: block.originScriptDate,
        originBlockId: block.originBlockId,
        originSource: block.originSource,
        signalKey: '',
        canHideSignal: false,
        text: getBlockActionText(block),
        state: 'current',
        lastActivityAt: task?.updatedAt ?? null,
        timeLabel: block.startTime && block.endTime ? `${block.startTime}-${block.endTime}` : undefined,
        inFocus: true,
        canPlan: false,
      })
    }

    for (const context of Object.values(taskContexts)) {
      if (!pendingIds.has(context.taskId)) continue
      const nextStep = context.summary.nextStep.trim()
      const recommended = context.summary.recommendedNextStep.trim()
      const common = {
        taskId: context.taskId,
        taskTitle: context.taskTitle,
        taskStatus: context.status,
        state: getActionState(context, taskSummaryUpdating),
        lastActivityAt: context.lastActivityAt,
        timeLabel: undefined,
        inFocus: currentFocusTaskIds.has(context.taskId) || insertedNextStepIds.has(`explicit:${context.taskId}`) || insertedNextStepIds.has(`recommended:${context.taskId}`),
        canPlan: true,
        originScriptDate: null,
        originBlockId: null,
        originSource: null,
        signalKey: '',
        canHideSignal: false,
      } satisfies Omit<NextStepAction, 'id' | 'sourceType' | 'blockSource' | 'text'>
      if (nextStep) {
        pushAction({
          ...common,
          id: `explicit:${context.taskId}`,
          sourceType: 'explicit',
          blockSource: 'task_next_step',
          signalKey: signalKeyForActionText(nextStep),
          canHideSignal: true,
          text: nextStep,
        })
      } else if (recommended) {
        pushAction({
          ...common,
          id: `recommended:${context.taskId}`,
          sourceType: 'recommended',
          blockSource: 'task_recommended_next_step',
          signalKey: signalKeyForActionText(recommended),
          canHideSignal: true,
          text: recommended,
        })
      }
    }

    for (const block of carryOverBlocks) {
      if (block.completed) continue
      const taskId = block.taskIds[0] ?? null
      const task = taskId ? tasksById.get(taskId) : null
      pushAction({
        id: `carry_over:${block.id}:${taskId ?? 'none'}`,
        taskId,
        taskTitle: task?.title ?? getBlockTitle(block, tasksById),
        taskStatus: task?.status ?? 'FOCUS',
        sourceType: 'carry_over',
        blockSource: 'carry_over',
        originScriptDate: block.originScriptDate,
        originBlockId: block.originBlockId,
        originSource: block.originSource,
        signalKey: signalKeyForCarryOverBlock(block),
        canHideSignal: Boolean(taskId),
        text: getBlockActionText(block),
        state: 'current',
        lastActivityAt: task?.updatedAt ?? null,
        timeLabel: block.originScriptDate || (block.startTime && block.endTime)
          ? [block.originScriptDate ? `from ${block.originScriptDate}` : '', block.startTime && block.endTime ? `${block.startTime}-${block.endTime}` : ''].filter(Boolean).join(' · ')
          : undefined,
        inFocus: false,
        canPlan: Boolean(taskId),
      })
    }

    const items = new Map<string, WorkOverviewItem>()

    for (const action of actions) {
      const key = action.taskId ?? action.id
      const existing = items.get(key)
      if (!existing) {
        items.set(key, {
          id: key,
          taskId: action.taskId,
          taskTitle: action.taskTitle,
          taskStatus: action.taskStatus,
          primaryAction: action,
          actions: [action],
          state: action.state,
          lastActivityAt: action.lastActivityAt,
          inFocus: action.inFocus,
          canPlan: action.canPlan,
        })
        continue
      }

      const duplicateSignal = existing.actions.some((item) =>
        item.sourceType === action.sourceType
        && areSimilarActions(actionTextForTask(item.text, item.taskTitle), actionTextForTask(action.text, action.taskTitle))
      )
      if (!duplicateSignal) existing.actions.push(action)
      existing.actions.sort((a, b) => sourceRank[a.sourceType] - sourceRank[b.sourceType] || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      existing.primaryAction = existing.actions[0]
      existing.state = existing.primaryAction.state
      existing.lastActivityAt = Math.max(...existing.actions.map((item) => item.lastActivityAt ?? 0)) || null
      existing.inFocus = existing.actions.some((item) => item.inFocus)
      existing.canPlan = existing.actions.some((item) => item.canPlan)
    }

    const sortedItems = [...items.values()].sort((a, b) =>
      sourceRank[a.primaryAction.sourceType] - sourceRank[b.primaryAction.sourceType]
      || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    )
    if (workOverviewOrderRef.current.date !== displayDate) {
      workOverviewOrderRef.current = { date: displayDate, next: 0, items: new Map() }
    }
    for (const item of sortedItems) {
      if (!workOverviewOrderRef.current.items.has(item.id)) {
        workOverviewOrderRef.current.items.set(item.id, workOverviewOrderRef.current.next)
        workOverviewOrderRef.current.next += 1
      }
    }
    return sortedItems.sort((a, b) =>
      (workOverviewOrderRef.current.items.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (workOverviewOrderRef.current.items.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [carryOverBlocks, displayDate, hiddenOverviewSignals, insertedNextStepIds, pendingTasks, script, taskContexts, taskSummaryUpdating, tasks, todayScriptDate, workOverviewTasks])

  async function hideOverviewSignal(action: NextStepAction) {
    if (!action.taskId || !action.canHideSignal || !isHidableSignalSource(action.sourceType)) return
    try {
      const hidden = await hideWorkOverviewSignal({
        taskId: action.taskId,
        sourceType: action.sourceType,
        signalKey: action.signalKey,
      })
      setHiddenOverviewSignals((current) => {
        const next = current.filter((item) => hiddenSignalKey(item) !== hiddenSignalKey(hidden))
        return [hidden, ...next]
      })
    } catch (error) {
      console.error('Failed to hide Work overview signal:', error)
      setSaveError('Failed to hide Work overview signal.')
    }
  }

  function appendNextStep(action: NextStepAction) {
    if (!script) return
    if (!action.taskId) return
    const linkAttrs = {
      href: `/today?task=${encodeURIComponent(action.taskId)}`,
      taskId: action.taskId,
    }
    const prefix = action.sourceType === 'recommended'
      ? 'Recommended '
      : action.sourceType === 'carry_over'
        ? 'Carry over '
        : 'Next step '
    const nextNode = {
      type: 'paragraph',
      attrs: {
        source: action.blockSource,
        ...(action.originScriptDate ? { originScriptDate: action.originScriptDate } : {}),
        ...(action.originBlockId ? { originBlockId: action.originBlockId } : {}),
        ...(action.originSource ? { originSource: action.originSource } : {}),
      },
      content: [
        { type: 'text', text: prefix },
        { type: 'text', text: `@${action.taskTitle}`, marks: [{ type: 'link', attrs: linkAttrs }] },
        { type: 'text', text: `: ${action.text}` },
      ],
    }
    const document = script.document && script.document.type === 'doc'
      ? script.document
      : { type: 'doc', content: [] }
    const content = Array.isArray(document.content) ? [...document.content] : []
    const nextContent = [...content, nextNode]
    const nextDocument = { ...document, content: nextContent }
    setScript({ ...script, document: nextDocument })
    setInsertedNextStepIds((ids) => new Set(ids).add(action.id))
  }

  function openNextStepAction(action: NextStepAction) {
    if (!action.taskId) return
    void setActiveTask(action.taskId)
  }

  const saveDraft = useCallback(async (getCurrentDocument?: () => Record<string, any>): Promise<SaveDraftResult> => {
    if (saveDraftInFlightRef.current) return saveDraftInFlightRef.current

    const current = scriptRef.current
    if (!current) return { ok: false, current: false, valid: false }

    clearAutosaveTimer()
    const date = displayDateRef.current
    const document = current.document
    const documentSnapshot = JSON.stringify(document)
    const documentEditVersion = editVersionRef.current
    const focusActivity = [...focusActivityRef.current.values()]

    const savePromise = (async () => {
      try {
        setSaveError(null)
        setSaveStatus('saving')
        const result = await saveDayScript(date, {
          expectedRevision: current.revision,
          document,
          focusActivity,
        })
        const latest = scriptRef.current
        const liveDocument = getCurrentDocument?.()
        const latestDocument = liveDocument ?? latest?.document
        const latestSnapshot = latestDocument ? JSON.stringify(latestDocument) : ''
        const changedDuringSave = editVersionRef.current !== documentEditVersion
          || Boolean(liveDocument && scriptDirtyRef.current && latestSnapshot !== documentSnapshot)
        const savedCurrentSnapshot = !changedDuringSave
        if (result.validationErrors.length > 0) {
          const validationMessage = recordDayScriptValidationError(`PUT /api/day-scripts/${date}`, result.validationErrors)
          if (savedCurrentSnapshot) {
            setScript(result.script)
            setScriptDirty(false)
            setSaveError(null)
            setSaveStatus('saved')
          } else {
            setScript((prev) => prev ? {
              ...prev,
              ...(latestDocument ? { document: latestDocument } : {}),
              revision: result.script.revision,
              blocks: result.script.blocks,
              updatedAt: result.script.updatedAt,
            } : prev)
            setSaveStatus('unsaved')
          }
          return { ok: true, current: savedCurrentSnapshot, valid: false, validationMessage }
        }

        if (savedCurrentSnapshot) {
          setScript(result.script)
          setScriptDirty(false)
          setSaveStatus('saved')
        } else {
          setScript((prev) => prev ? {
            ...prev,
            ...(latestDocument ? { document: latestDocument } : {}),
            revision: result.script.revision,
            blocks: result.script.blocks,
            updatedAt: result.script.updatedAt,
          } : prev)
          setSaveStatus('unsaved')
        }

        setConflicts([])
        await Promise.all([loadTodos(), loadWorkOverviewTasks()])
        const createdTaskId = result.createdTasks[0]?.id
        if (createdTaskId) {
          await setActiveTask(createdTaskId)
        } else {
          const activeId = useTaskStore.getState().activeTaskId
          if (activeId) await setActiveTask(activeId)
        }
        return { ok: true, current: savedCurrentSnapshot, valid: true }
      } catch (error: any) {
        console.error('Failed to save Day Script:', error)
        const status = error?.response?.status
        const message = status === 409 ? 'Save conflict. Reload this date before saving again.' : (error?.message ?? 'Failed to save Day Script.')
        if (!error?.config) {
          recordAppError({
            endpoint: `PUT /api/day-scripts/${date}`,
            message,
            stack: error?.stack || '',
          })
        }
        setSaveError(message)
        setSaveStatus('error')
        return { ok: false, current: false, valid: false }
      }
    })()

    saveDraftInFlightRef.current = savePromise
    try {
      return await savePromise
    } finally {
      saveDraftInFlightRef.current = null
    }
  }, [clearAutosaveTimer, loadTodos, setActiveTask])

  const scheduleAutosave = useCallback(() => {
    clearAutosaveTimer()
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      void saveDraft()
    }, 10000)
  }, [clearAutosaveTimer, saveDraft])

  async function handleSave() {
    await saveDraft()
  }

  async function handleSubmitProgress(getCurrentDocument?: () => Record<string, any>) {
    const saved = await saveDraft(getCurrentDocument)
    if (!saved.ok) return
    if (!saved.current) {
      setSaveError('Focus changed while saving. Submit again after the latest draft is saved.')
      setSaveStatus('unsaved')
      return
    }
    if (!saved.valid) {
      setSaveError(saved.validationMessage ?? 'Invalid Focus content.')
      setSaveStatus('error')
      return
    }
    try {
      setSaveError(null)
      const focusActivity = [...focusActivityRef.current.values()]
      const result = await submitDayScriptProgress(displayDateRef.current, { focusActivity })
      if (result.validationErrors.length > 0) {
        const message = recordDayScriptValidationError(`POST /api/day-scripts/${displayDateRef.current}/submit-progress`, result.validationErrors)
        setSaveError(message)
        setSaveStatus('error')
        return
      }
      setScript(result.script)
      setScriptDirty(false)
      setSaveStatus('saved')
      setConflicts(result.conflicts)
      if (result.executionRecords.length > 0) {
        for (const record of result.executionRecords) {
          const block = result.script.blocks.find((item) => item.id === record.blockId)
          if (!block) continue
          const blockKey = buildDayScriptActivityKey(block, record.taskId)
          focusActivityRef.current.delete(activityMapKey(blockKey, record.taskId))
        }
        saveStoredFocusActivity(displayDateRef.current, focusActivityRef.current)
      }
      await Promise.all([loadTodos(), loadWorkOverviewTasks()])
      const createdTaskId = result.createdTasks[0]?.id
      if (createdTaskId) await setActiveTask(createdTaskId)
      else if (activeTaskId) await setActiveTask(activeTaskId)
      if (result.createdLogs.length > 0) {
        await doAfk()
      }
    } catch (error: any) {
      console.error('Failed to submit Day Script progress:', error)
      const message = error?.response?.data?.error || error?.message || 'Failed to submit Focus progress.'
      if (!error?.config) {
        recordAppError({
          endpoint: `POST /api/day-scripts/${displayDateRef.current}/submit-progress`,
          message,
          stack: error?.stack || '',
        })
      }
      setSaveError(message)
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
    setDailySummaryOpen(true)
    setDailySummaryLoading(true)
    setDailySummaryError('')
    setDailySummaryShowSource(false)
    try {
      if (scriptDirtyRef.current) {
        const saved = await saveDraft()
        if (!saved.ok || !saved.current) {
          setDailySummary(null)
          setDailySummaryError('Save the Focus draft before generating a daily summary.')
          return
        }
      }
      await loadBackgroundTasks()
      const cached = await fetchDailySummaryCache(displayDate)
      const finishedResult = dailySummaryFinishedTask?.result
      const errorTask = useBackgroundTaskStore.getState().tasks.find((task) =>
        task.type === 'daily_summary'
        && task.status === 'error'
        && task.sourceKey === dailySummarySourceKey(displayDate)
      )
      if (cached) {
        setDailySummary(cached)
      } else if (finishedResult && 'summaryMarkdown' in finishedResult) {
        setDailySummary(finishedResult)
      } else if (errorTask) {
        setDailySummary(null)
        setDailySummaryError(errorTask.error || 'Daily summary failed.')
      } else {
        setDailySummary(null)
      }
      const running = useBackgroundTaskStore.getState().tasks.some((task) =>
        task.type === 'daily_summary'
        && task.status === 'running'
        && task.sourceKey === dailySummarySourceKey(displayDate)
      )
      if (running) setDailySummaryLoading(true)
    } catch (error: any) {
      setDailySummaryError(error?.response?.data?.error || error?.message || 'Failed to load daily summary.')
    } finally {
      setDailySummaryLoading(false)
      void loadBackgroundTasks()
    }
  }

  useEffect(() => {
    if (!dailySummaryOpenRequest) return
    const requestKey = `${displayDate}:${dailySummaryOpenRequest}`
    if (handledDailySummaryOpenRequestRef.current === requestKey) return
    handledDailySummaryOpenRequestRef.current = requestKey
    void handleDailySummary()
    const next = new URLSearchParams(searchParams)
    next.delete('dailySummary')
    setSearchParams(next, { replace: true })
  }, [dailySummaryOpenRequest, displayDate])

  async function runDailySummaryInBackground() {
    setDailySummaryError('')
    try {
      if (scriptDirtyRef.current) {
        const saved = await saveDraft()
        if (!saved.ok || !saved.current) {
          setDailySummaryError('Save the Focus draft before generating a daily summary.')
          return
        }
      }
      if (!dailySummaryRunningTask) await generateDailySummaryInBackground(displayDate)
      await loadBackgroundTasks()
      setDailySummaryOpen(false)
      setBackgroundPanelOpen(true)
    } catch (error: any) {
      setDailySummaryError(error?.response?.data?.error || error?.message || 'Failed to generate daily summary.')
    }
  }

  async function handlePlanToday() {
    setPlanDraftLoading(true)
    setPlanDraftError('')
    setPlanDraftPreviewError('')
    try {
      if (scriptDirtyRef.current) {
        const saved = await saveDraft()
        if (!saved.ok || !saved.current) {
          setPlanDraftError('Save the Focus draft before building a plan.')
          return
        }
      }
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

  const shiftDisplayDate = useCallback(async (offset: number) => {
    if (scriptDirtyRef.current) {
      const saved = await saveDraft()
      if (!saved.ok || !saved.current) return
    }
    const nextDate = dateOffset(displayDate, offset)
    setDisplayDate(nextDate)
    const nextParams = new URLSearchParams(searchParams)
    if (activeTaskId) nextParams.set('task', activeTaskId)
    if (nextDate !== todayScriptDate) nextParams.set('date', nextDate)
    else nextParams.delete('date')
    if (nextParams.toString() !== searchParams.toString()) {
      setSearchParams(nextParams, { replace: true })
    }
  }, [activeTaskId, displayDate, saveDraft, searchParams, setSearchParams, todayScriptDate])

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={splitContainerRef} className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 shrink-0 flex-col bg-background"
          style={{ width: `${leftPanePercent}%` }}
        >
          <div className="flex h-16 flex-nowrap items-center gap-5 border-b bg-card/60 px-6">
            <div className="flex shrink-0 items-center gap-3">
              <button className="rounded-lg border border-border p-2 hover:bg-muted" onClick={() => shiftDisplayDate(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="whitespace-nowrap text-lg font-semibold">{formatDate(displayDate)}</div>
              <button className="rounded-lg border border-border p-2 hover:bg-muted" onClick={() => shiftDisplayDate(1)}>
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
                disabled={loadingScript || !script}
                title="Generate Daily Summary with LLM"
                aria-label="Generate Daily Summary with LLM"
              >
                {dailySummaryRunningTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
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
                {!saveError && saveStatus !== 'saved' && (
                  <div className="absolute right-3 top-3 z-20 rounded-lg border border-border bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow">
                    {saveStatus === 'saving' ? 'Saving draft...' : saveStatus === 'unsaved' ? 'Unsaved draft' : 'Save failed'}
                  </div>
                )}
                <OverallNextStepsBoard
                  items={workOverviewItems}
                  onPlan={appendNextStep}
                  onOpen={openNextStepAction}
                  onHideSignal={hideOverviewSignal}
                  onMaximize={() => setNextStepsMaximized(true)}
                />
                <DayScriptEditor
                  value={script.document}
                  blocks={script.blocks}
                  tasks={pendingTasks}
                  scriptDate={displayDate}
                  todayScriptDate={todayScriptDate}
                  onChange={(document) => {
                    setSaveError(null)
                    setSaveStatus('unsaved')
                    setScriptDirty(true)
                    scriptDirtyRef.current = true
                    editVersionRef.current += 1
                    scriptRef.current = scriptRef.current ? { ...scriptRef.current, document } : scriptRef.current
                    setScript((prev) => prev ? { ...prev, document } : prev)
                    scheduleAutosave()
                  }}
                  onSave={handleSave}
                  onSubmitProgress={handleSubmitProgress}
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
            <TaskDetailWorkspace showTrackingStatus keepCompletedTaskVisible />
          </div>
        </section>
      </div>

      {nextStepsMaximized && (
        <div
          data-testid="overall-next-steps-maximized"
          className="absolute inset-0 z-50 min-h-0 bg-background/95 p-5 backdrop-blur-sm"
        >
          <OverallNextStepsBoard
            items={workOverviewItems}
            onPlan={appendNextStep}
            onOpen={openNextStepAction}
            onHideSignal={hideOverviewSignal}
            maximized
            onCloseMaximized={() => setNextStepsMaximized(false)}
          />
        </div>
      )}

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

      <Dialog open={dailySummaryOpen} onOpenChange={(open) => {
        setDailySummaryOpen(open)
        if (!open) setDailySummaryError('')
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
            {(dailySummaryLoading || dailySummaryRunningTask) && !dailySummary ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating daily summary...
              </div>
            ) : dailySummaryError ? (
              <div className="text-sm text-destructive">{dailySummaryError}</div>
            ) : !dailySummary ? (
              <div className="text-sm text-muted-foreground">No daily summary has been generated for this date.</div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => setDailySummaryShowSource((value) => !value)}>
                    {dailySummaryShowSource ? 'Show Rendered' : 'Show Source'}
                  </button>
                </div>
                {dailySummaryShowSource ? (
                  <textarea
                    readOnly
                    value={dailySummary?.summaryMarkdown ?? ''}
                    className="min-h-[520px] w-full resize-y rounded-md border bg-background p-3 font-mono text-sm leading-6 outline-none focus:ring-1 focus:ring-primary"
                  />
                ) : (
                  <MarkdownView markdown={dailySummary?.summaryMarkdown ?? ''} className="min-h-[520px] rounded-md border bg-background p-4 text-sm leading-6" />
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            {(dailySummaryLoading || dailySummaryRunningTask) && (
              <button className="dialog-button-secondary" onClick={runDailySummaryInBackground}>
                <Sparkles className="h-4 w-4" />
                Run in Background
              </button>
            )}
            <button className="dialog-button-secondary" onClick={() => {
              setDailySummary(null)
              setDailySummaryError('')
              setDailySummaryOpen(false)
            }}>
              Close
            </button>
            <button className="dialog-button-secondary whitespace-nowrap" onClick={async () => {
              setDailySummaryError('')
              try {
                if (scriptDirtyRef.current) {
                  const saved = await saveDraft()
                  if (!saved.ok || !saved.current) {
                    setDailySummaryError('Save the Focus draft before generating a daily summary.')
                    return
                  }
                }
                await generateDailySummaryInBackground(displayDate)
                await loadBackgroundTasks()
              } catch (error: any) {
                setDailySummaryError(error?.response?.data?.error || error?.message || 'Failed to regenerate daily summary.')
              }
            }} disabled={Boolean(dailySummaryRunningTask)}>
              {dailySummaryRunningTask && <Loader2 className="h-4 w-4 animate-spin" />}
              {dailySummary ? 'Regenerate' : 'Generate'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(planDraft) || Boolean(planDraftError)} onOpenChange={(open) => {
        if (!open) {
          setPlanDraft(null)
          setPlanDraftDoc(null)
          setPlanDraftError('')
          setPlanDraftPreviewError('')
        }
      }}>
        <DialogContent className="h-[88vh] max-h-[88vh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Plan Today</DialogTitle>
          </DialogHeader>
          <DialogBody className="min-h-0 overflow-hidden">
            {planDraftError ? (
              <div className="text-sm text-destructive">{planDraftError}</div>
            ) : planDraftDoc ? (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="shrink-0 text-xs text-muted-foreground">
                  {planDraft?.sources.taskCount ?? 0} task lines · {planDraft?.sources.recommendedTaskCount ?? 0} recommendations · {planDraft?.sources.carriedBlockCount ?? 0} carried focus lines
                </div>
                {planDraftPreviewError ? (
                  <div className="shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {planDraftPreviewError}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  <DayScriptEditor
                    key={`plan-draft:${displayDate}:${planDraft?.sources.taskCount ?? 0}:${planDraft?.sources.carriedBlockCount ?? 0}`}
                    value={planDraftDoc}
                    blocks={[]}
                    tasks={pendingTasks}
                    scriptDate={displayDate}
                    todayScriptDate={todayScriptDate}
                    onChange={setPlanDraftDoc}
                    onSave={() => {}}
                    onNavigateTask={() => {}}
                    onEditingTask={() => {}}
                    onContentError={(message, error) => {
                      console.warn('Plan Today preview load failed:', error ?? message)
                      setPlanDraftPreviewError(message)
                    }}
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
              setPlanDraftPreviewError('')
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
