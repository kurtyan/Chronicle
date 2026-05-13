import { useEffect, useState, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlanStore, getTodayDate, loadPlanItems, selectPlanItem, checkHasPlanForDate, loadStartOfDayOffset } from '@/stores/planStore'
import { useTaskStore } from '@/stores/taskStore'
import type { PlanItem, BatchCreatePlanItem } from '@/types'
import { updatePlanItem, fetchUnfinishedPlans, batchCreatePlanItems, createTask } from '@/services/api'
import { TaskDetailWorkspace, IdleTimeIndicator, TrackingStatusIndicator } from '@/components/TaskDetailWorkspace'
import { ChevronLeft, ChevronRight, CalendarPlus, GripVertical, Trash2, Check, X, Plus } from 'lucide-react'

function formatDate(dateStr: string): string {
  const parts = dateStr.split('-').map(Number)
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
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

  // --- Edit mode ---
  const [editing, setEditing] = useState(false)
  const [editedItems, setEditedItems] = useState<PlanItem[]>([])
  const [deletedDetailIds, setDeletedDetailIds] = useState<Set<string>>(new Set())
  const displayItems = editing ? editedItems : planItems

  // Drag state for break adjustment
  const dragState = useRef<{ index: number; startY: number; originalItems: PlanItem[] } | null>(null)
  const resizeState = useRef<{ index: number; startY: number; originalMin: number; originalItems: PlanItem[] } | null>(null)

  const enterEdit = () => {
    setEditedItems([...planItems])
    setDeletedDetailIds(new Set())
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditedItems([])
    setDeletedDetailIds(new Set())
    dragState.current = null
    resizeState.current = null
  }

  const saveEdit = async () => {
    try {
      for (let i = 0; i < editedItems.length; i++) {
        const item = editedItems[i]
        const prev = planItems[i]
        if (!prev || item.estimatedStart !== prev.estimatedStart || item.estimatedEnd !== prev.estimatedEnd || item.estimatedMinutes !== prev.estimatedMinutes) {
          await updatePlanItem(item.detailId, { estimatedStart: item.estimatedStart ?? undefined, estimatedEnd: item.estimatedEnd ?? undefined, estimatedMinutes: item.estimatedMinutes, sortOrder: i })
        }
      }
      for (const detailId of deletedDetailIds) {
        await updatePlanItem(detailId, { status: 'UNFINISHED' })
      }
      await loadPlanItems(displayDate)
    } catch { /* error */ }
    cancelEdit()
  }

  const deleteEditedItem = (index: number) => {
    const item = editedItems[index]
    setDeletedDetailIds(prev => new Set(prev).add(item.detailId))
    setEditedItems(prev => prev.filter((_, i) => i !== index))
  }

  // Drag/resize handlers (same pattern as PlanTheDay Step 2)
  const handleBreakMouseDown = (index: number, e: React.MouseEvent) => {
    if (index === 0 || !editing) return
    e.preventDefault()
    dragState.current = { index, startY: e.clientY, originalItems: [...editedItems] }
    window.addEventListener('mousemove', handleBreakMouseMove)
    window.addEventListener('mouseup', handleBreakMouseUp)
  }

  const handleBreakMouseMove = (e: MouseEvent) => {
    const ds = dragState.current
    if (!ds) return
    const deltaPx = e.clientY - ds.startY
    const deltaMin = Math.round(deltaPx / 12) * 5
    if (deltaMin === 0) { setEditedItems([...ds.originalItems]); return }
    const prevEnd = timeToMinutes(ds.originalItems[ds.index - 1].estimatedEnd ?? '00:00')
    const currStart = timeToMinutes(ds.originalItems[ds.index].estimatedStart ?? '00:00')
    const originalBreak = currStart - prevEnd
    const newBreak = Math.max(0, originalBreak + deltaMin)
    const breakChange = newBreak - originalBreak
    setEditedItems(ds.originalItems.map((item, i) => {
      if (i < ds.index) return item
      const startMin = timeToMinutes(item.estimatedStart ?? '00:00') + breakChange
      const endMin = timeToMinutes(item.estimatedEnd ?? '00:00') + breakChange
      return { ...item, estimatedStart: minutesToTime(startMin), estimatedEnd: minutesToTime(endMin) }
    }))
  }

  const handleBreakMouseUp = () => {
    dragState.current = null
    window.removeEventListener('mousemove', handleBreakMouseMove)
    window.removeEventListener('mouseup', handleBreakMouseUp)
  }

  const handleResizeMouseDown = (index: number, e: React.MouseEvent) => {
    if (!editing) return
    e.preventDefault(); e.stopPropagation()
    const item = editedItems[index]
    resizeState.current = { index, startY: e.clientY, originalMin: item.estimatedMinutes ?? 30, originalItems: [...editedItems] }
    window.addEventListener('mousemove', handleResizeMouseMove)
    window.addEventListener('mouseup', handleResizeMouseUp)
  }

  const handleResizeMouseMove = (e: MouseEvent) => {
    const rs = resizeState.current
    if (!rs) return
    const deltaPx = e.clientY - rs.startY
    const deltaMin = Math.round(deltaPx / 12) * 5
    const newMin = Math.max(5, rs.originalMin + deltaMin)
    if (newMin === rs.originalMin) { setEditedItems([...rs.originalItems]); return }
    const minDiff = newMin - rs.originalMin
    setEditedItems(rs.originalItems.map((item, i) => {
      if (i < rs.index) return item
      if (i === rs.index) {
        const startMin = timeToMinutes(item.estimatedStart ?? '00:00')
        return { ...item, estimatedMinutes: newMin, estimatedEnd: minutesToTime(startMin + newMin) }
      }
      const startMin = timeToMinutes(item.estimatedStart ?? '00:00') + minDiff
      const endMin = timeToMinutes(item.estimatedEnd ?? '00:00') + minDiff
      return { ...item, estimatedStart: minutesToTime(startMin), estimatedEnd: minutesToTime(endMin) }
    }))
  }

  const handleResizeMouseUp = () => {
    resizeState.current = null
    window.removeEventListener('mousemove', handleResizeMouseMove)
    window.removeEventListener('mouseup', handleResizeMouseUp)
  }

  // --- Add sub-task dialog (edit mode) ---
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [addMode, setAddMode] = useState<'new' | 'import'>('new')
  // New sub-task fields
  const [newTaskId, setNewTaskId] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newMinutes, setNewMinutes] = useState(30)
  const [showTaskPicker, setShowTaskPicker] = useState(false)
  const [taskPickerQuery, setTaskPickerQuery] = useState('')
  const newTitleRef = useRef<HTMLInputElement>(null)
  const newMinutesRef = useRef<HTMLInputElement>(null)
  // Import unfinished
  const [unfinishedPlanList, setUnfinishedPlanList] = useState<PlanItem[]>([])
  const [selectedDetailIds, setSelectedDetailIds] = useState<Set<string>>(new Set())
  const { tasks, loadTodos: loadTasksForPicker } = useTaskStore()
  const availableTasks = tasks.filter(t => t.status !== 'DONE' && t.status !== 'DROPPED')

  const openAddDialog = async () => {
    setAddMode('new')
    setNewTaskId(null)
    setNewTitle('')
    setNewMinutes(30)
    setShowTaskPicker(false)
    setTaskPickerQuery('')
    setSelectedDetailIds(new Set())
    try {
      const plans = await fetchUnfinishedPlans()
      setUnfinishedPlanList(plans)
    } catch { setUnfinishedPlanList([]) }
    await loadTasksForPicker()
    setShowAddDialog(true)
    setTimeout(() => newTitleRef.current?.focus(), 50)
  }

  const filteredTasks = showTaskPicker
    ? (taskPickerQuery ? availableTasks.filter(t => t.title.toLowerCase().includes(taskPickerQuery) || t.id.toLowerCase().includes(taskPickerQuery)) : availableTasks)
    : []

  const refreshEditItems = async () => {
    await loadPlanItems(displayDate)
    const refreshed = usePlanStore.getState().planItems
    setEditedItems([...refreshed])
    setDeletedDetailIds(new Set())
    setEditing(true)
  }

  const handleAddNewSubtask = async () => {
    if (!newTaskId || !newTitle.trim()) return
    try {
      const sortOrder = editedItems.length
      const item: BatchCreatePlanItem = { taskId: newTaskId, content: newTitle.trim(), estimatedMinutes: newMinutes, estimatedStart: '', estimatedEnd: '', sortOrder }
      await batchCreatePlanItems({ planDate: displayDate, items: [item] })
      await refreshEditItems()
    } catch { /* error */ }
    setShowAddDialog(false)
  }

  const handleImportPlans = async () => {
    if (selectedDetailIds.size === 0) return
    try {
      const items: BatchCreatePlanItem[] = []
      const nowOrder = editedItems.length
      let order = 0
      for (const plan of unfinishedPlanList) {
        if (selectedDetailIds.has(plan.detailId)) {
          items.push({ taskId: plan.taskId, content: plan.content, estimatedMinutes: plan.estimatedMinutes, estimatedStart: '', estimatedEnd: '', sortOrder: nowOrder + order++, detailId: plan.detailId })
        }
      }
      await batchCreatePlanItems({ planDate: displayDate, items })
      await refreshEditItems()
    } catch { /* error */ }
    setShowAddDialog(false)
  }

  const editTimelineHeight = useMemo(() => {
    const items = editing ? editedItems : planItems
    let h = 0
    for (let i = 0; i < items.length; i++) {
      if (i > 0) {
        const prevEnd = items[i - 1].estimatedEnd
        const currStart = items[i].estimatedStart
        if (prevEnd && currStart) { const bm = timeToMinutes(currStart) - timeToMinutes(prevEnd); if (bm > 0) h += bm * SCALE }
      }
      h += (items[i].estimatedMinutes ?? 30) * SCALE
    }
    return Math.max(1, h)
  }, [editing, editedItems, planItems])

  // Compute progress marker pixel offset by walking timeline segments
  const progressOffset = useMemo(() => {
    const items = displayItems
    if (items.length === 0) return null
    const dayStartMin = startOfDayOffset * 60
    const d = new Date(now)
    let nowMin = d.getHours() * 60 + d.getMinutes()
    if (nowMin < dayStartMin) nowMin += 24 * 60
    let px = 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (i > 0) {
        const prevEnd = items[i - 1].estimatedEnd
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
    return px
  }, [displayItems, now, startOfDayOffset])

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
            {!editing ? (
              <button className="px-3 py-1 text-xs border rounded hover:bg-muted" onClick={enterEdit}>Edit</button>
            ) : (
              <>
                <button className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded flex items-center gap-1" onClick={saveEdit}>
                  <Check className="w-3 h-3" /> Save
                </button>
                <button className="px-3 py-1 text-xs border rounded hover:bg-muted flex items-center gap-1" onClick={cancelEdit}>
                  <X className="w-3 h-3" /> Cancel
                </button>
              </>
            )}
          </div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto relative">
          <div className="relative" style={{ height: editTimelineHeight }}>
            {displayItems.map((item, index) => {
              const items = editing ? editedItems : planItems
              const breakBefore = index > 0
                ? (() => {
                    const prevEnd = items[index - 1].estimatedEnd
                    const currStart = item.estimatedStart
                    if (prevEnd && currStart) return timeToMinutes(currStart) - timeToMinutes(prevEnd)
                    return 0
                  })()
                : 0

              const subH = (item.estimatedMinutes ?? 30) * SCALE
              const breakH = breakBefore > 0 ? breakBefore * SCALE : 0

              return (
                <div key={editing ? item.detailId : item.id}>
                  {breakBefore > 0 && (
                    <div className="flex items-center gap-1 px-3" style={{ height: breakH }}>
                      <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{breakBefore}m</span>
                      <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                    </div>
                  )}
                  <div
                    data-plan-index={index}
                    className={`text-left px-3 ml-[14px] mr-2 transition flex items-center gap-3 border-l-[3px] overflow-hidden ${
                      editing ? 'border rounded-lg bg-card flex-col' :
                      (index === selectedItemIndex
                        ? 'bg-muted border-l-primary shadow-sm'
                        : item.planStatus === 'DOING' ? 'bg-blue-500/5 border-l-blue-400' :
                          item.planStatus === 'DONE' ? 'bg-green-500/5 border-l-green-400' :
                          item.planStatus === 'SKIPPED' ? 'bg-muted/30 border-l-muted-foreground/30' :
                          'bg-card border-l-purple-400/60 hover:bg-muted/40 cursor-pointer')
                    }`}
                    style={{ height: subH, minHeight: 0 }}
                    onClick={() => { if (!editing) selectPlanItem(index) }}
                  >
                    {editing ? (
                      <div className="flex items-center gap-3 w-full flex-1 min-h-0 pt-1">
                        <div className="flex-shrink-0 w-12 text-center leading-tight">
                          <div className="text-[11px] font-mono text-muted-foreground">{item.estimatedStart}</div>
                          <div className="text-[9px] text-muted-foreground/50">{item.estimatedMinutes}m</div>
                          <div className="text-[11px] font-mono text-muted-foreground">{item.estimatedEnd}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{stripHtml(item.content)}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            <span className="font-mono">{item.taskId}</span>
                          </div>
                        </div>
                        <button
                          className="p-1 hover:bg-destructive/20 rounded flex-shrink-0"
                          onClick={(e) => { e.stopPropagation(); deleteEditedItem(index) }}
                        >
                          <Trash2 className="w-3 h-3 text-destructive" />
                        </button>
                        <GripVertical
                          className="w-4 h-4 text-muted-foreground flex-shrink-0 cursor-grab"
                          onMouseDown={(e) => handleBreakMouseDown(index, e)}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="flex-shrink-0 w-12 text-center leading-tight">
                          <div className="text-[11px] font-mono text-muted-foreground">{item.estimatedStart}</div>
                          <div className="text-[9px] text-muted-foreground/50">{item.estimatedMinutes}m</div>
                          <div className="text-[11px] font-mono text-muted-foreground">{item.estimatedEnd}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{stripHtml(item.content)}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            <span className="font-mono">{item.taskId}</span>
                          </div>
                        </div>
                        <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium leading-none ${planStatusBadge(item.planStatus)}`}>
                            {planStatusLabel(item.planStatus)}
                          </span>
                        </div>
                      </>
                    )}
                    {editing && (
                      <div
                        className="h-[6px] w-full flex-shrink-0 bg-muted-foreground/10 hover:bg-primary/30 cursor-ns-resize transition-colors rounded-b-lg"
                        onMouseDown={(e) => handleResizeMouseDown(index, e)}
                      />
                    )}
                  </div>
                </div>
              )
            })}

            {/* + button for adding sub-tasks (edit mode) */}
            {editing && (
              <div className="px-3 mt-1">
                <button
                  className="w-full py-1.5 border-2 border-dashed border-muted-foreground/20 rounded-lg text-xs text-muted-foreground hover:bg-muted/50 flex items-center justify-center gap-1"
                  onClick={openAddDialog}
                >
                  <Plus className="w-3 h-3" /> Add
                </button>
              </div>
            )}

            {/* Time progress bar — left edge */}
            {!editing && progressOffset !== null && (
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

      {/* Add Sub-task Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setShowAddDialog(false)}>
          <div className="bg-popover border rounded-lg shadow-lg w-96 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-3 border-b flex items-center justify-between">
              <h3 className="font-semibold text-sm">Add to Plan</h3>
              <button className="p-1 hover:bg-muted rounded" onClick={() => setShowAddDialog(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tab switcher */}
            <div className="flex border-b">
              <button className={`flex-1 py-2 text-xs font-medium ${addMode === 'new' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'}`} onClick={() => setAddMode('new')}>
                New Sub-task
              </button>
              <button className={`flex-1 py-2 text-xs font-medium ${addMode === 'import' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'}`} onClick={() => setAddMode('import')}>
                Import ({unfinishedPlanList.length})
              </button>
            </div>

            <div className="p-3 flex-1 overflow-auto">
              {addMode === 'new' ? (
                <div className="space-y-3">
                  {/* Task picker */}
                  <div>
                    <label className="text-xs text-muted-foreground">Task</label>
                    <div className="relative">
                      {newTaskId ? (
                        <div className="flex items-center gap-2 mt-1 p-2 border rounded text-sm bg-muted/30">
                          <span className="font-mono text-xs text-muted-foreground">{newTaskId}</span>
                          <span className="flex-1 truncate">{availableTasks.find(t => t.id === newTaskId)?.title}</span>
                          <button className="p-0.5 hover:bg-muted rounded" onClick={() => { setNewTaskId(null); setShowTaskPicker(false) }}>
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="w-full text-left p-2 border rounded text-sm mt-1 hover:bg-muted"
                          onClick={() => { setShowTaskPicker(true); setTaskPickerQuery('') }}
                        >
                          Select a task...
                        </button>
                      )}
                      {showTaskPicker && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded shadow-md max-h-48 overflow-auto z-10">
                          <input
                            className="w-full px-2 py-1.5 text-sm border-b outline-none"
                            placeholder="Filter tasks..."
                            value={taskPickerQuery}
                            onChange={e => setTaskPickerQuery(e.target.value)}
                            autoFocus
                          />
                          {filteredTasks.slice(0, 20).map(t => (
                            <button
                              key={t.id}
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center gap-2"
                              onClick={() => { setNewTaskId(t.id); setShowTaskPicker(false); setTimeout(() => newTitleRef.current?.focus(), 50) }}
                            >
                              <span className="truncate">{t.title}</span>
                              <span className="text-xs text-muted-foreground flex-shrink-0">{t.id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Title */}
                  <div>
                    <label className="text-xs text-muted-foreground">Title</label>
                    <input ref={newTitleRef} className="w-full px-2 py-1.5 border rounded text-sm mt-1" placeholder="Sub-task title" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
                  </div>

                  {/* Minutes */}
                  <div>
                    <label className="text-xs text-muted-foreground">Duration (min)</label>
                    <input ref={newMinutesRef} className="w-full px-2 py-1.5 border rounded text-sm mt-1" type="number" min={5} step={5} value={newMinutes} onChange={e => setNewMinutes(parseInt(e.target.value) || 30)} />
                  </div>

                  <button className="w-full py-2 bg-primary text-primary-foreground rounded text-sm" onClick={handleAddNewSubtask} disabled={!newTaskId || !newTitle.trim()}>
                    Add
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {unfinishedPlanList.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No unfinished plans</p>
                  ) : (
                    <>
                      {unfinishedPlanList.map(plan => (
                        <label key={plan.detailId} className={`flex items-center gap-2 p-2 rounded text-sm cursor-pointer ${selectedDetailIds.has(plan.detailId) ? 'bg-primary/10' : 'hover:bg-muted'}`}>
                          <input
                            type="checkbox"
                            className="w-4 h-4"
                            checked={selectedDetailIds.has(plan.detailId)}
                            onChange={e => {
                              const next = new Set(selectedDetailIds)
                              e.target.checked ? next.add(plan.detailId) : next.delete(plan.detailId)
                              setSelectedDetailIds(next)
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs">{plan.content}</div>
                            <div className="text-[10px] text-muted-foreground">{plan.taskId} · {plan.planDate} · {plan.estimatedMinutes}m</div>
                          </div>
                        </label>
                      ))}
                      <button className="w-full py-2 bg-primary text-primary-foreground rounded text-sm" onClick={handleImportPlans} disabled={selectedDetailIds.size === 0}>
                        Import Selected ({selectedDetailIds.size})
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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
