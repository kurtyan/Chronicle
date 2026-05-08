import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlanStore, getTodayDate, loadPlanItems, selectPlanItem, startPlanItem, completePlanItem, checkHasPlanForDate, loadStartOfDayOffset } from '@/stores/planStore'
import { useTaskStore } from '@/stores/taskStore'
import type { PlanItem } from '@/types'
import { TaskDetailWorkspace, IdleTimeIndicator, TrackingStatusIndicator } from '@/components/TaskDetailWorkspace'
import { ChevronLeft, ChevronRight, CalendarPlus } from 'lucide-react'

function formatDate(dateStr: string): string {
  const parts = dateStr.split('-').map(Number)
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
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
  const { planItems, selectedItemIndex } = usePlanStore()
  const { selectedTask, setActiveTask, loadTodos } = useTaskStore()
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

  // Keyboard navigation for timeline — global listener, not dependent on focus
  const planItemsRef = useRef(planItems)
  const selectedIndexRef = useRef(selectedItemIndex)
  planItemsRef.current = planItems
  selectedIndexRef.current = selectedItemIndex

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const activeEl = document.activeElement
      const inEditor = activeEl?.closest('[data-rich-editor="true"]') || activeEl?.closest('[contenteditable="true"]') || activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA'
      if (inEditor) return // don't steal from editor

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

  const statusIcon = (status: string) => {
    switch (status) {
      case 'DONE': return <span className="text-green-500">✅</span>
      case 'DOING': return <span className="text-blue-500 animate-pulse">⏳</span>
      case 'SKIPPED': return <span className="text-gray-400">⏭</span>
      default: return <span className="text-muted-foreground">○</span>
    }
  }

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
        <div className="flex-1 overflow-auto">
          {planItems.map((item, index) => {
            const breakBefore = index > 0
              ? (() => {
                  const prevEnd = planItems[index - 1].estimatedEnd
                  const currStart = item.estimatedStart
                  if (prevEnd && currStart) {
                    const [ph, pm] = prevEnd.split(':').map(Number)
                    const [ch, cm] = currStart.split(':').map(Number)
                    return (ch * 60 + cm) - (ph * 60 + pm)
                  }
                  return 0
                })()
              : 0

            return (
              <div key={item.id}>
                {breakBefore > 0 && (
                  <div className="flex items-center gap-1 px-3 py-0.5">
                    <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                    <span className="text-[10px] text-muted-foreground">{breakBefore}m break</span>
                    <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                  </div>
                )}
                <button
                  className={`w-full text-left p-3 border-b hover:bg-muted/50 transition ${
                    index === selectedItemIndex ? 'bg-muted border-l-2 border-l-primary' : ''
                  }`}
                  onClick={() => selectPlanItem(index)}
                >
                  <div className="flex items-center gap-2">
                    {statusIcon(item.planStatus)}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{stripHtml(item.content)}</div>
                      <div className="text-xs text-muted-foreground flex gap-2">
                        <span>{item.estimatedStart}</span>
                        <span>{item.estimatedMinutes}m</span>
                        <span>{item.taskId}</span>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            )
          })}
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
