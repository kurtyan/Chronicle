import { useEffect, useState, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlanStore, getTodayDate, loadPlanItems, selectPlanItem, checkHasPlanForDate, loadStartOfDayOffset } from '@/stores/planStore'
import { useTaskStore } from '@/stores/taskStore'
import type { PlanItem } from '@/types'
import { TaskDetailWorkspace, IdleTimeIndicator, TrackingStatusIndicator } from '@/components/TaskDetailWorkspace'
import { ChevronLeft, ChevronRight, CalendarPlus } from 'lucide-react'

function formatDate(dateStr: string): string {
  const parts = dateStr.split('-').map(Number)
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

// Empty state when no plan exists
function EmptyPlanState({ date, onCreatePlan }: { date: string; onCreatePlan: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-4">
        <CalendarPlus className="w-12 h-12 text-muted-foreground mx-auto" />
        <p className="text-muted-foreground">{formatDate(date)}</p>
        <p className="text-lg">还没有今天的计划</p>
        <button
          className="px-6 py-3 bg-primary text-primary-foreground rounded-lg text-lg font-medium hover:bg-primary/90 transition"
          onClick={onCreatePlan}
        >
          Make today's plan
        </button>
      </div>
    </div>
  )
}

// Plan timeline with task detail on right
function StatusBar() {
  const currentSession = useTaskStore(s => s.currentSession)
  const tasks = useTaskStore(s => s.tasks)
  const setActiveTask = useTaskStore(s => s.setActiveTask)
  if (currentSession) {
    return (
      <div className="h-10 px-[30px] flex items-center justify-end">
        <TrackingStatusIndicator currentSession={currentSession} tasks={tasks} onNavigate={() => {
          if (currentSession.taskId) setActiveTask(currentSession.taskId)
        }} />
      </div>
    )
  }
  return (
    <div className="h-10 px-[30px] flex items-center justify-end">
      <IdleTimeIndicator />
    </div>
  )
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent || tmp.innerText || ''
}

function PlanView({ displayDate, onChangeDate }: {
  displayDate: string
  onChangeDate: (delta: number) => void
}) {
  const { planItems, selectedItemIndex, startOfDayOffset } = usePlanStore()
  const { selectedTask, entries, setActiveTask, loadTodos } = useTaskStore()
  const [highlightId, setHighlightId] = useState<string | null>(null)

  // Share panel width with BoardPage via localStorage
  const [timelineWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('chronicle_tasklist_pct')
      const pct = saved ? parseFloat(saved) : 0.3
      return Math.round(window.innerWidth * pct)
    } catch { return Math.round(window.innerWidth * 0.3) }
  })

  const selectedItem: PlanItem | undefined = planItems[selectedItemIndex]

  useEffect(() => {
    loadTodos()
  }, [loadTodos])

  // When a plan item is selected, load its task into the shared store
  useEffect(() => {
    if (selectedItem) {
      setActiveTask(selectedItem.taskId)
      setHighlightId(selectedItem.id)
      const timer = setTimeout(() => setHighlightId(null), 2500)
      return () => clearTimeout(timer)
    }
  }, [selectedItem?.id, selectedItem?.taskId])

  // Sync planStore planItems with entry changes (status/content)
  useEffect(() => {
    const entryMap = new Map<string, { status?: string; content?: string }>()
    for (const e of entries) {
      if (e.type === 'plan') entryMap.set(e.id, { status: e.planStatus, content: e.content })
    }
    if (entryMap.size === 0) return
    let changed = false
    const updated = planItems.map(item => {
      const entry = entryMap.get(item.id)
      if (!entry) return item
      const newStatus = entry.status as typeof item.planStatus | undefined
      if (newStatus && newStatus !== item.planStatus) changed = true
      if (entry.content && entry.content !== item.content) changed = true
      return { ...item, planStatus: newStatus ?? item.planStatus, content: entry.content ?? item.content }
    })
    if (changed) usePlanStore.setState({ planItems: updated })
  }, [entries])

  // Keyboard navigation for timeline — global listener, not dependent on focus
  const planItemsRef = useRef(planItems)
  const selectedIndexRef = useRef(selectedItemIndex)
  planItemsRef.current = planItems
  selectedIndexRef.current = selectedItemIndex

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const activeEl = document.activeElement
      const inEditor = activeEl?.closest('[data-rich-editor="true"]') || activeEl?.closest('[contenteditable="true"]') || activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA'
      if (inEditor) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const items = planItemsRef.current
        const idx = selectedIndexRef.current
        if (idx < items.length - 1) selectPlanItem(idx + 1)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const idx = selectedIndexRef.current
        if (idx > 0) selectPlanItem(idx - 1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Scroll container ref for auto-scroll on keyboard nav
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll selected item into view
  useEffect(() => {
    if (selectedItemIndex < 0 || !scrollRef.current) return
    const btn = scrollRef.current.querySelector(`[data-plan-index="${selectedItemIndex}"]`)
    if (btn) {
      btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedItemIndex])

  // Real-time clock for progress bar (update every 5 seconds)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [])

  const SCALE = 2.5 // px per minute, strictly linear

  // Compute progress marker pixel offset by walking timeline segments
  const progressOffset = useMemo(() => {
    if (planItems.length === 0) return null
    const dayStartMin = startOfDayOffset * 60
    const d = new Date(now)
    let nowMin = d.getHours() * 60 + d.getMinutes()
    // If before day start, treat as next day (e.g. 1:29 → 25:29)
    if (nowMin < dayStartMin) nowMin += 24 * 60
    let px = 0
    for (let i = 0; i < planItems.length; i++) {
      const item = planItems[i]
      // Break before this item
      if (i > 0) {
        const prevEnd = planItems[i - 1].estimatedEnd
        const currStart = item.estimatedStart
        if (prevEnd && currStart) {
          let pe = timeToMinutes(prevEnd)
          let cs = timeToMinutes(currStart)
          if (pe < dayStartMin) pe += 24 * 60
          if (cs < dayStartMin) cs += 24 * 60
          const bm = cs - pe
          if (bm > 0) {
            const bh = bm * SCALE
            if (nowMin >= pe && nowMin < pe + bm) {
              return px + ((nowMin - pe) / bm) * bh
            }
            if (nowMin < pe) return px
            px += bh
          }
        }
      }
      // Sub task
      const im = item.estimatedMinutes ?? 30
      const ih = im * SCALE
      let is_ = item.estimatedStart ? timeToMinutes(item.estimatedStart) : 0
      if (is_ < dayStartMin) is_ += 24 * 60
      if (nowMin >= is_ && nowMin < is_ + im) {
        return px + ((nowMin - is_) / im) * ih
      }
      if (nowMin < is_) return px
      px += ih
    }
    return px // past end of timeline
  }, [planItems, now, startOfDayOffset])

  const planStatusBadge = (status: string) => {
    switch (status) {
      case 'DONE': return 'bg-green-500/10 text-green-500'
      case 'DOING': return 'bg-blue-500/10 text-blue-500'
      case 'SKIPPED': return 'bg-muted text-muted-foreground/50'
      default: return 'bg-purple-500/10 text-purple-500'
    }
  }

  const planStatusLabel = (status: string) => {
    switch (status) {
      case 'DONE': return 'DONE'
      case 'DOING': return 'DOING'
      case 'SKIPPED': return 'SKIP'
      default: return 'PLAN'
    }
  }

  // Total timeline pixel height (same linear formula as rendering)
  const timelineHeight = useMemo(() => {
    let h = 0
    for (let i = 0; i < planItems.length; i++) {
      if (i > 0) {
        const prevEnd = planItems[i - 1].estimatedEnd
        const currStart = planItems[i].estimatedStart
        if (prevEnd && currStart) {
          const bm = timeToMinutes(currStart) - timeToMinutes(prevEnd)
          if (bm > 0) h += bm * SCALE
        }
      }
      h += (planItems[i].estimatedMinutes ?? 30) * SCALE
    }
    return Math.max(1, h)
  }, [planItems])

  return (
    <div className="flex h-full">
      {/* Left: Timeline */}
      <div style={{ width: timelineWidth, minWidth: 180, maxWidth: 500 }} className="border-r bg-card flex flex-col flex-shrink-0">
        <div className="p-3 border-b flex items-center justify-between">
          <button className="p-1 hover:bg-muted rounded" onClick={() => onChangeDate(-1)}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="font-semibold text-sm">{formatDate(displayDate)}</h2>
          <div className="flex items-center gap-1">
            <button className="p-1 hover:bg-muted rounded" onClick={() => onChangeDate(1)}>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto relative">
          <div className="relative" style={{ height: timelineHeight }}>
            {planItems.map((item, index) => {
              const breakBefore = index > 0
                ? (() => {
                    const prevEnd = planItems[index - 1].estimatedEnd
                    const currStart = item.estimatedStart
                    if (prevEnd && currStart) return timeToMinutes(currStart) - timeToMinutes(prevEnd)
                    return 0
                  })()
                : 0

              const subH = (item.estimatedMinutes ?? 30) * SCALE
              const breakH = breakBefore > 0 ? breakBefore * SCALE : 0

              return (
                <div key={item.id}>
                  {breakBefore > 0 && (
                    <div
                      className="flex items-center gap-1 px-3"
                      style={{ height: breakH }}
                    >
                      <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{breakBefore}m</span>
                      <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                    </div>
                  )}
                  <button
                    data-plan-index={index}
                    className={`text-left px-3 ml-[14px] mr-2 transition flex items-center gap-3 border-l-[3px] ${
                      index === selectedItemIndex
                        ? 'bg-muted border-l-primary shadow-sm'
                        : item.planStatus === 'DOING' ? 'bg-blue-500/5 border-l-blue-400' :
                          item.planStatus === 'DONE' ? 'bg-green-500/5 border-l-green-400' :
                          item.planStatus === 'SKIPPED' ? 'bg-muted/30 border-l-muted-foreground/30' :
                          'bg-card border-l-purple-400/60 hover:bg-muted/40'
                    }`}
                    style={{ height: subH, minHeight: 0 }}
                    onClick={() => selectPlanItem(index)}
                  >
                    {/* Time on left — matching step 2 card style */}
                    <div className="flex-shrink-0 w-12 text-center leading-tight">
                      <div className="text-[11px] font-mono text-muted-foreground">{item.estimatedStart}</div>
                      <div className="text-[9px] text-muted-foreground/50">{item.estimatedMinutes}m</div>
                      <div className="text-[11px] font-mono text-muted-foreground">{item.estimatedEnd}</div>
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{stripHtml(item.content)}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        <span className="font-mono">{item.taskId}</span>
                      </div>
                    </div>
                    {/* Status badge and duration */}
                    <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium leading-none ${planStatusBadge(item.planStatus)}`}>
                        {planStatusLabel(item.planStatus)}
                      </span>
                    </div>
                  </button>
                </div>
              )
            })}

            {/* Time progress bar — left edge */}
            {progressOffset !== null && (
              <div className="absolute left-0 top-0 bottom-0 w-[10px] pointer-events-none z-10">
                {/* Background track */}
                <div className="absolute inset-0 bg-muted-foreground/8" />
                {/* Elapsed portion */}
                <div
                  className="absolute left-0 right-0 bg-primary/40"
                  style={{ top: 0, height: progressOffset }}
                />
                {/* Current time marker — bright horizontal dash */}
                <div
                  className="absolute left-[-2px] h-[2px] bg-primary shadow-[0_0_4px_hsl(var(--primary))]"
                  style={{ top: progressOffset, width: '14px', transform: 'translateY(-50%)' }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Task Detail — same TaskDetailWorkspace component as BoardPage */}
      <div className="flex-1 flex flex-col">
        {selectedTask ? (
          <TaskDetailWorkspace highlightEntryId={highlightId ?? undefined} />
        ) : (
          <div className="flex flex-col h-full">
            <StatusBar />
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              {planItems.length > 0 ? 'Select a plan item to view task details' : 'No plan items'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function TodayPage() {
  const navigate = useNavigate()
  const { loading } = usePlanStore()
  const [hasPlan, setHasPlan] = useState<boolean | null>(null)
  const [displayDate, setDisplayDate] = useState(getTodayDate())

  useEffect(() => {
    loadStartOfDayOffset().then(() => {
      const date = getTodayDate()
      setDisplayDate(date)
      checkHasPlanForDate(date).then(setHasPlan)
    })
  }, [])

  // Load plan items when date changes
  useEffect(() => {
    if (hasPlan && displayDate) {
      loadPlanItems(displayDate)
    }
  }, [hasPlan, displayDate])

  const handleCreatePlan = () => {
    navigate('/today/plan')
  }

  const changeDate = (delta: number) => {
    const parts = displayDate.split('-').map(Number)
    const d = new Date(parts[0], parts[1] - 1, parts[2] + delta)
    const newDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    setDisplayDate(newDate)
    checkHasPlanForDate(newDate).then(setHasPlan)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {hasPlan === false && displayDate === getTodayDate() ? (
        <EmptyPlanState date={displayDate} onCreatePlan={handleCreatePlan} />
      ) : hasPlan ? (
        <PlanView displayDate={displayDate} onChangeDate={changeDate} />
      ) : (
        <>
          {/* Date bar for non-today dates */}
          <div className="border-b px-4 py-3 flex items-center justify-between">
            <button className="p-1 hover:bg-muted rounded" onClick={() => changeDate(-1)}>
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="font-semibold">{formatDate(displayDate)}</span>
            <button className="p-1 hover:bg-muted rounded" onClick={() => changeDate(1)}>
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            {hasPlan === null ? 'Loading...' : `No plan for ${formatDate(displayDate)}`}
          </div>
        </>
      )}
    </div>
  )
}
