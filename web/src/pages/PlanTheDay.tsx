import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '@/stores/taskStore'
import { createTask, fetchUnfinishedPlans } from '@/services/api'
import { getTodayDate, savePlan } from '@/stores/planStore'
import type { BatchCreatePlanItem, PlanItem } from '@/types'
import { ArrowRight, ArrowLeft, GripVertical, Trash2, Save } from 'lucide-react'

function roundUpTo5Minutes(date: Date): Date {
  const ms = 5 * 60 * 1000
  return new Date(Math.ceil(date.getTime() / ms) * ms)
}

function minutesToTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

// Step 1: Edit Plan
function EditPlanStep({
  onNext,
}: {
  onNext: (items: BatchCreatePlanItem[]) => void
}) {
  const { tasks, loadTodos } = useTaskStore()
  const availableTasks = tasks.filter(t => t.status !== 'DONE' && t.status !== 'DROPPED')
  const [unfinishedPlans, setUnfinishedPlans] = useState<PlanItem[]>([])

  useEffect(() => {
    fetchUnfinishedPlans().then(setUnfinishedPlans).catch(() => {})
  }, [])

  interface PlanRow {
    id: string
    kind: 'task' | 'subtask' | 'imported-plan'
    taskId: string
    taskTitle?: string
    title?: string
    minutes?: number | null
    detailId?: string
    estimatedStart?: string
    estimatedEnd?: string
  }
  const [rows, setRows] = useState<PlanRow[]>([])

  const [editValue, setEditValue] = useState('')
  const [editMode, setEditMode] = useState<'pick' | 'title' | 'duration'>('pick')
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  const [editMinutes, setEditMinutes] = useState<number | null>(30)
  const [showNextHint, setShowNextHint] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerIndex, setPickerIndex] = useState(0)
  const editRef = useRef<HTMLInputElement>(null)
  const minutesRef = useRef<HTMLInputElement>(null)
  const pickerListRef = useRef<HTMLDivElement>(null)
  const compositionJustEnded = useRef(false)

  useEffect(() => { loadTodos() }, [loadTodos])

  useEffect(() => {
    if (editMode === 'duration' && minutesRef.current) minutesRef.current.focus()
    else editRef.current?.focus()
  }, [editMode, rows.length])

  // Show all tasks on @, filter as user types
  const filteredTasks = showPicker
    ? (pickerQuery ? availableTasks.filter(t => t.title.toLowerCase().includes(pickerQuery) || t.id.toLowerCase().includes(pickerQuery)) : availableTasks)
    : []

  // Track @ in edit value
  useEffect(() => {
    if (editValue.startsWith('@')) {
      setShowPicker(true)
      setPickerQuery(editValue.slice(1).toLowerCase())
      setPickerIndex(0)
    } else if (showPicker) {
      setShowPicker(false)
    }
  }, [editValue])

  // Auto-scroll picker to selected item
  useEffect(() => {
    if (showPicker && pickerListRef.current) {
      const active = pickerListRef.current.querySelector(`[data-picker-index="${pickerIndex}"]`)
      active?.scrollIntoView({ block: 'nearest' })
    }
  }, [pickerIndex, showPicker])

  const handleEditCompositionEnd = () => {
    compositionJustEnded.current = true
    queueMicrotask(() => { compositionJustEnded.current = false })
  }

  const selectTask = (task: typeof availableTasks[0]) => {
    if (editTaskId) {
      // Commit any in-progress subtask before switching to a new task context
      if (editValue.trim() && !editValue.startsWith('@')) {
        setRows(prev => [...prev, { id: crypto.randomUUID(), kind: 'subtask', taskId: editTaskId, title: editValue.trim(), minutes: editMinutes }])
      }
      // Add a new task row
      const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'task', taskId: task.id, taskTitle: task.title }
      setRows(prev => [...prev, newRow])
    } else {
      // First task — commit as row
      const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'task', taskId: task.id, taskTitle: task.title }
      setRows(prev => [...prev, newRow])
    }
    setEditTaskId(task.id)
    setEditValue('')
    setEditMode('title')
    setShowPicker(false)
  }

  // Commit task from left panel click or drag
  const setTaskContext = (task: typeof availableTasks[0]) => {
    if (editTaskId) {
      // Commit any in-progress subtask before switching
      if (editValue.trim() && !editValue.startsWith('@')) {
        setRows(prev => [...prev, { id: crypto.randomUUID(), kind: 'subtask', taskId: editTaskId, title: editValue.trim(), minutes: editMinutes }])
      }
      // Add a new task row
      const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'task', taskId: task.id, taskTitle: task.title }
      setRows(prev => [...prev, newRow])
    } else {
      const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'task', taskId: task.id, taskTitle: task.title }
      setRows(prev => [...prev, newRow])
    }
    setEditTaskId(task.id)
    setEditValue('')
    setEditMode('title')
  }

  const handleCreateTask = async () => {
    const title = editValue.startsWith('@') ? editValue.slice(1).trim() : editValue.trim()
    if (!title) return
    try {
      const task = await createTask({ title, type: 'TODO', priority: 'MEDIUM' })
      await useTaskStore.getState().loadTodos()
      const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'task', taskId: task.id, taskTitle: task.title }
      setRows(prev => [...prev, newRow])
      setEditTaskId(task.id)
      setEditValue('')
      setEditMode('title')
      setShowPicker(false)
    } catch {
      // task creation failed — stay in picker
    }
  }

  const commitTitle = () => {
    if (!editValue.trim() || !editTaskId) return
    setEditMode('duration')
    setEditMinutes(30)
  }

  const commitDuration = () => {
    if (!editValue.trim() || !editTaskId) return
    const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'subtask', taskId: editTaskId, title: editValue.trim(), minutes: editMinutes ?? 30 }
    setRows(prev => [...prev, newRow])
    setEditValue('')
    setEditMode('title')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return
    if (showPicker) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPickerIndex(i => Math.min(i + 1, filteredTasks.length)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setPickerIndex(i => Math.max(i - 1, 0)) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (pickerIndex === filteredTasks.length) {
          handleCreateTask()
        } else if (filteredTasks[pickerIndex]) {
          selectTask(filteredTasks[pickerIndex])
        }
      }
      else if (e.key === 'Escape') { setShowPicker(false); setEditValue('') }
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (compositionJustEnded.current) { e.preventDefault(); return }
      e.preventDefault()
      if (editTaskId && editValue.trim()) commitTitle()
    }
  }

  // @-only constraint on the first edit box (no task selected yet)
  const handleEditChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    if (!editTaskId && val.length > 0 && !val.startsWith('@')) {
      // Only accept @ input when no task is selected — block non-@ chars
      return
    }
    setEditValue(val)
  }

  const handleMinutesKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commitDuration() }
  }

  const removeRow = (id: string) => {
    setRows(prev => prev.filter(r => r.id !== id))
  }

  const editSubtask = (row: PlanRow) => {
    setEditTaskId(row.taskId)
    setEditValue(row.title || '')
    setEditMinutes(row.minutes ?? null)
    setEditMode('title')
    setShowPicker(false)
    // Remove the old row so user can re-edit it
    setRows(prev => prev.filter(r => r.id !== row.id))
  }

  const handleNext = () => {
    const items: BatchCreatePlanItem[] = []
    let order = 0
    for (const row of rows) {
      if (row.kind === 'subtask' && row.title?.trim()) {
        items.push({ taskId: row.taskId, content: row.title.trim(), estimatedMinutes: row.minutes ?? 30, estimatedStart: '', estimatedEnd: '', sortOrder: order++ })
      } else if (row.kind === 'imported-plan' && row.detailId) {
        items.push({ taskId: row.taskId, content: row.title?.trim() || '', estimatedMinutes: row.minutes ?? 30, estimatedStart: row.estimatedStart ?? '', estimatedEnd: row.estimatedEnd ?? '', sortOrder: order++, detailId: row.detailId })
      }
    }
    if (editValue.trim() && editTaskId) {
      items.push({ taskId: editTaskId, content: editValue.trim(), estimatedMinutes: editMinutes ?? 30, estimatedStart: '', estimatedEnd: '', sortOrder: order++ })
    }
    if (items.length === 0) {
      setShowNextHint(true)
      setTimeout(() => setShowNextHint(false), 3000)
      return
    }
    onNext(items)
  }

  return (
    <div className="flex h-full">
      {/* Left: Available Tasks + Unfinished Plans */}
      <div className="w-[30%] border-r bg-card p-4 flex flex-col">
        <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Tasks</h3>
        <div className="flex-1 overflow-auto space-y-1 min-h-0">
          {availableTasks.map(task => (
            <button key={task.id}
              className="w-full text-left p-2 rounded hover:bg-muted text-sm flex items-center gap-2"
              draggable onDragStart={(e) => e.dataTransfer.setData('taskId', task.id)}
              onClick={() => setTaskContext(task)}
            >
              <GripVertical className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <span className="truncate">{task.title}</span>
              <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{task.id}</span>
            </button>
          ))}
        </div>
        {unfinishedPlans.length > 0 && (
          <>
            <div className="border-t my-3" />
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Unfinished Plans</h3>
            <div className="flex-1 overflow-auto space-y-1 min-h-0">
              {unfinishedPlans.map(plan => (
                <button key={plan.detailId}
                  className="w-full text-left p-2 rounded hover:bg-muted/80 text-sm flex items-center gap-2 bg-blue-500/5"
                  draggable onDragStart={(e) => {
                    e.dataTransfer.setData('detailId', plan.detailId)
                    e.dataTransfer.setData('taskId', plan.taskId)
                  }}
                >
                  <GripVertical className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{plan.content}</span>
                  <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{plan.estimatedMinutes}m</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Right: Plan Editor */}
      <div className="flex-1 p-4 flex flex-col"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const detailId = e.dataTransfer.getData('detailId')
          const taskId = e.dataTransfer.getData('taskId')
          if (detailId) {
            // Dropped an unfinished plan item
            const plan = unfinishedPlans.find(p => p.detailId === detailId)
            if (plan) {
              const newRow: PlanRow = { id: crypto.randomUUID(), kind: 'imported-plan', taskId: plan.taskId, taskTitle: plan.taskTitle, title: plan.content, minutes: plan.estimatedMinutes, detailId: plan.detailId }
              setRows(prev => [...prev, newRow])
            }
          } else if (taskId) {
            const task = availableTasks.find(t => t.id === taskId)
            if (task) setTaskContext(task)
          }
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Edit Plan</h2>
          <button className="px-4 py-2 bg-primary text-primary-foreground rounded-md flex items-center gap-2 text-sm" onClick={handleNext}>
            Next Step <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto space-y-2">
          {/* Committed rows */}
          {rows.map(row => {
            if (row.kind === 'task') {
              return (
                <div key={row.id} className="flex items-center gap-2 py-1 group">
                  <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono">{row.taskId}</span>
                  <span className="text-sm font-medium">{row.taskTitle}</span>
                  <button className="ml-auto opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded" onClick={() => removeRow(row.id)}>
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </button>
                </div>
              )
            }
            if (row.kind === 'imported-plan') {
              return (
                <div key={row.id} className="flex gap-2 items-center group pl-6 bg-blue-500/5 rounded border border-blue-500/10">
                  <span className="text-xs text-muted-foreground/50 font-mono flex-shrink-0">{row.taskId}</span>
                  <span className="flex-1 text-sm">{row.title}</span>
                  <span className="text-xs text-muted-foreground w-16 text-right">{row.minutes} min</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 flex-shrink-0">imported</span>
                  <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded" onClick={(e) => { e.stopPropagation(); removeRow(row.id) }}>
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </button>
                </div>
              )
            }
            return (
              <div key={row.id} className="flex gap-2 items-center group pl-6 cursor-pointer hover:bg-muted/50 rounded" onClick={() => editSubtask(row)}>
                <span className="text-xs text-muted-foreground/50 font-mono flex-shrink-0">{row.taskId}</span>
                <span className="flex-1 text-sm">{row.title}</span>
                <span className="text-xs text-muted-foreground w-16 text-right">{row.minutes} min</span>
                <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded" onClick={(e) => { e.stopPropagation(); removeRow(row.id) }}>
                  <Trash2 className="w-3 h-3 text-destructive" />
                </button>
              </div>
            )
          })}

          {showNextHint && (
            <div className="text-sm text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
              {rows.length === 0
                ? 'No subtasks yet — pick a task with @, type a title, press Enter, then enter duration.'
                : 'Subtasks exist but none have titles. Make sure each subtask has content and press Enter to confirm.'}
            </div>
          )}

          {/* Active edit row — indent sub task editor to match committed rows */}
          <div className={`flex gap-2 items-center ${editTaskId ? 'pl-6' : ''}`}>
            {editMode === 'duration' ? (
              <>
                <input className="flex-1 px-2 py-1.5 border rounded text-sm bg-background cursor-pointer" value={editValue} readOnly onClick={() => setEditMode('title')} />
                <input ref={minutesRef} className="w-20 px-2 py-1.5 border rounded text-sm bg-background text-center" type="number" min={1} placeholder="min"
                  value={editMinutes ?? ''} onChange={(e) => setEditMinutes(parseInt(e.target.value) || null)} onKeyDown={handleMinutesKeyDown} />
                <span className="text-xs text-muted-foreground w-8">min</span>
              </>
            ) : (
              <div className="relative flex-1">
                <input ref={editRef}
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder={editTaskId ? "Sub-task title (Tab/Enter for duration, @ to switch task)" : "Type @ to pick a task"}
                  value={editValue} onChange={handleEditChange} onKeyDown={handleEditKeyDown} onCompositionEnd={handleEditCompositionEnd}
                />
                {/* Task picker dropdown */}
                {showPicker && (
                  <div ref={pickerListRef} className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-64 overflow-auto z-50">
                    {filteredTasks.map((task, i) => (
                      <button key={task.id}
                        data-picker-index={i}
                        className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${i === pickerIndex ? 'bg-muted' : 'hover:bg-muted'}`}
                        onClick={() => selectTask(task)}
                        onMouseEnter={() => setPickerIndex(i)}
                      >
                        <span className="truncate">{task.title}</span>
                        <span className="text-xs text-muted-foreground flex-shrink-0">{task.id}</span>
                      </button>
                    ))}
                    {filteredTasks.length === 0 && (
                      <p className="p-2 text-xs text-muted-foreground">No matching tasks</p>
                    )}
                    <button
                      data-picker-index={filteredTasks.length}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-t bg-green-500/5 text-green-600 ${filteredTasks.length === pickerIndex ? 'bg-muted' : 'hover:bg-muted'}`}
                      onClick={handleCreateTask}
                      onMouseEnter={() => setPickerIndex(filteredTasks.length)}
                    >
                      <span className="font-medium">+ Create task</span>
                      <span className="truncate text-muted-foreground">
                        {editValue.startsWith('@') && editValue.slice(1).trim() ? `"${editValue.slice(1).trim()}"` : ''}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Step 2: Schedule Plan
function ScheduleStep({
  items,
  onBack,
  onSave,
}: {
  items: BatchCreatePlanItem[]
  onBack: () => void
  onSave: (items: BatchCreatePlanItem[]) => void
}) {
  // Compute initial timeline: start from now + 10min, rounded up to 5min
  const [scheduleItems, setScheduleItems] = useState(() => {
    const base = roundUpTo5Minutes(new Date(Date.now()))
    let current = timeToMinutes(
      `${String(base.getHours()).padStart(2, '0')}:${String(base.getMinutes()).padStart(2, '0')}`
    )

    return items.map((item) => {
      const start = minutesToTime(current)
      const end = minutesToTime(current + item.estimatedMinutes)
      const result = { ...item, estimatedStart: start, estimatedEnd: end }
      current += item.estimatedMinutes
      return result
    })
  })

  // Drag — mousedown/move/up for real-time bidirectional break adjustment
  const dragState = useRef<{ index: number; startY: number; originalItems: BatchCreatePlanItem[] } | null>(null)
  const [dragging, setDragging] = useState(false)

  const handleMouseDown = (index: number, e: React.MouseEvent) => {
    if (index === 0) return // first item cannot have a break before it
    e.preventDefault()
    dragState.current = {
      index,
      startY: e.clientY,
      originalItems: [...scheduleItems],
    }
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragState.current
      if (!ds) return

      const deltaPx = e.clientY - ds.startY
      // 12px ≈ 5 minutes
      const deltaMin = Math.round(deltaPx / 12) * 5

      if (deltaMin === 0) {
        // No change from original — restore
        setScheduleItems([...ds.originalItems])
        return
      }

      // Compute the original break before the dragged item
      const prevEnd = timeToMinutes(ds.originalItems[ds.index - 1].estimatedEnd)
      const currStart = timeToMinutes(ds.originalItems[ds.index].estimatedStart)
      const originalBreak = currStart - prevEnd

      // New break = originalBreak + deltaMin, clamped to >= 0
      const newBreak = Math.max(0, originalBreak + deltaMin)

      // Compute the shift amount for items from ds.index onwards
      const breakChange = newBreak - originalBreak

      setScheduleItems(ds.originalItems.map((item, i) => {
        if (i < ds.index) return item
        const startMin = timeToMinutes(item.estimatedStart) + breakChange
        const endMin = timeToMinutes(item.estimatedEnd) + breakChange
        return {
          ...item,
          estimatedStart: minutesToTime(startMin),
          estimatedEnd: minutesToTime(endMin),
        }
      }))
    }

    const handleMouseUp = () => {
      setDragging(false)
      dragState.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging])

  // Resize — drag bottom edge of sub task to change estimated minutes
  const resizeState = useRef<{ index: number; startY: number; originalMin: number; originalItems: BatchCreatePlanItem[] } | null>(null)
  const [resizing, setResizing] = useState(false)

  const handleResizeMouseDown = (index: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const item = scheduleItems[index]
    resizeState.current = {
      index,
      startY: e.clientY,
      originalMin: item.estimatedMinutes,
      originalItems: [...scheduleItems],
    }
    setResizing(true)
  }

  useEffect(() => {
    if (!resizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const rs = resizeState.current
      if (!rs) return

      const deltaPx = e.clientY - rs.startY
      const deltaMin = Math.round(deltaPx / 12) * 5
      const newMin = Math.max(5, rs.originalMin + deltaMin) // minimum 5 minutes
      if (newMin === rs.originalMin) {
        setScheduleItems([...rs.originalItems])
        return
      }

      const minDiff = newMin - rs.originalMin
      setScheduleItems(rs.originalItems.map((item, i) => {
        if (i < rs.index) return item
        const startMin = timeToMinutes(item.estimatedStart) + (i === rs.index ? 0 : minDiff)
        const endMin = timeToMinutes(item.estimatedEnd) + minDiff + (i > rs.index ? 0 : 0)
        // For the resized item: keep start, change end (duration = newMin)
        // For subsequent items: shift both start and end by minDiff (maintain their durations and breaks)
        if (i === rs.index) {
          return { ...item, estimatedMinutes: newMin, estimatedEnd: minutesToTime(startMin + newMin) }
        }
        return {
          ...item,
          estimatedStart: minutesToTime(startMin),
          estimatedEnd: minutesToTime(endMin),
        }
      }))
    }

    const handleMouseUp = () => {
      setResizing(false)
      resizeState.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [resizing])

  const handleSave = () => {
    onSave(scheduleItems)
  }

  const handleDeleteScheduleItem = (index: number) => {
    setScheduleItems(prev => {
      const next = prev.filter((_, i) => i !== index)
      if (index === 0 || next.length === 0) return next
      // Recalculate from the item before deleted position
      let current = timeToMinutes(next[index - 1].estimatedEnd)
      return next.map((item, i) => {
        if (i < index) return item
        const start = minutesToTime(current)
        const end = minutesToTime(current + item.estimatedMinutes)
        current += item.estimatedMinutes
        return { ...item, estimatedStart: start, estimatedEnd: end }
      })
    })
  }

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center justify-between mb-4">
        <button className="flex items-center gap-2 text-sm hover:text-primary" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold">Schedule Plan ({scheduleItems.length} items)</h2>
        <button
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md flex items-center gap-2 text-sm"
          onClick={handleSave}
        >
          <Save className="w-4 h-4" /> Save Plan
        </button>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        Timeline starts at {scheduleItems[0]?.estimatedStart ?? '--'}. Drag items to add breaks between them.
      </p>

      <div className="flex-1 overflow-auto space-y-0">
        {scheduleItems.length === 0 && <div className="p-4 text-muted-foreground">No schedule items</div>}
        {scheduleItems.map((item, index) => {
          const breakBefore = index > 0
            ? timeToMinutes(item.estimatedStart) - timeToMinutes(scheduleItems[index - 1].estimatedEnd)
            : 0

          return (
            <div key={index}>
              {/* Break indicator — proportional height */}
              {breakBefore > 0 && (
                <div className="flex items-center gap-2 px-4" style={{ height: Math.max(16, breakBefore * 3) + 'px' }}>
                  <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {breakBefore} min break
                  </span>
                  <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
                </div>
              )}

              {/* Sub-task row — proportional height */}
              <div
                className="border rounded-lg mx-2 bg-card flex flex-col overflow-hidden"
                style={{ height: Math.max(40, item.estimatedMinutes * 3) + 'px' }}
              >
                <div className="flex items-center gap-3 flex-1 px-3 min-h-0">
                  <div className="flex-shrink-0 w-16 text-center">
                    <div className="text-sm font-mono text-muted-foreground">{item.estimatedStart}</div>
                    <div className="text-[10px] text-muted-foreground">to</div>
                    <div className="text-sm font-mono text-muted-foreground">{item.estimatedEnd}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{item.content}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.taskId} · {item.estimatedMinutes} min
                    </div>
                  </div>
                  <button
                    className="p-1 hover:bg-destructive/20 rounded"
                    onClick={(e) => { e.stopPropagation(); handleDeleteScheduleItem(index) }}
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </button>
                  <GripVertical
                    className={`w-4 h-4 text-muted-foreground flex-shrink-0 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    onMouseDown={(e) => handleMouseDown(index, e)}
                  />
                </div>
                {/* Resize handle — drag bottom edge to adjust duration */}
                <div
                  className="h-[6px] flex-shrink-0 bg-muted-foreground/10 hover:bg-primary/30 cursor-ns-resize transition-colors rounded-b-lg"
                  onMouseDown={(e) => handleResizeMouseDown(index, e)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function PlanTheDay() {
  const navigate = useNavigate()
  const [step, setStep] = useState<1 | 2>(1)
  const [items, setItems] = useState<BatchCreatePlanItem[]>([])

  const [scheduleKey, setScheduleKey] = useState(0)

  const handleStepOneNext = (newItems: BatchCreatePlanItem[]) => {
    setItems(newItems)
    setStep(2)
    setScheduleKey(k => k + 1)
  }

  const handleStepTwoBack = () => {
    setStep(1)
  }

  const handleSave = async (finalItems: BatchCreatePlanItem[]) => {
    const date = getTodayDate()
    try {
      await savePlan(date, finalItems)
      navigate('/today')
    } catch {
      // error already set in store
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="border-b px-4 py-3 flex items-center gap-4">
        <button className="text-sm hover:text-primary" onClick={() => navigate('/today')}>
          ← Back to Today
        </button>
        <div className="flex items-center gap-2 text-sm">
          <span className={`px-3 py-1 rounded-full ${step === 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
            1. Edit Plan
          </span>
          <span className="text-muted-foreground">→</span>
          <span className={`px-3 py-1 rounded-full ${step === 2 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
            2. Schedule
          </span>
        </div>
      </div>

      {/* Use absolute stacking to keep both steps mounted (preserves state on back) */}
      <div className="flex-1 relative overflow-hidden">
        <div className={`absolute inset-0 ${step === 1 ? 'z-10' : 'z-0 pointer-events-none opacity-0'}`}>
          <EditPlanStep onNext={handleStepOneNext} />
        </div>
        <div className={`absolute inset-0 ${step === 2 ? 'z-10' : 'z-0 pointer-events-none opacity-0'}`}>
          <ScheduleStep key={scheduleKey} items={items} onBack={handleStepTwoBack} onSave={handleSave} />
        </div>
      </div>
    </div>
  )
}
