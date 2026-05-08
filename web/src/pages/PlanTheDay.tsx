import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '@/stores/taskStore'
import { getTodayDate, savePlan } from '@/stores/planStore'
import type { BatchCreatePlanItem, Task } from '@/types'
import { ArrowRight, ArrowLeft, GripVertical, Plus, Trash2, Save } from 'lucide-react'

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
  const [planBlocks, setPlanBlocks] = useState<Array<{
    taskId: string
    subTasks: Array<{ content: string; estimatedMinutes: number }>
  }>>([])

  useEffect(() => {
    loadTodos()
  }, [loadTodos])

  const availableTasks = tasks.filter(t => t.status !== 'DONE' && t.status !== 'DROPPED')

  const addTaskBlock = useCallback((task: Task) => {
    setPlanBlocks(prev => {
      if (prev.some(b => b.taskId === task.id)) return prev
      return [...prev, {
        taskId: task.id,
        subTasks: [{ content: '', estimatedMinutes: 30 }],
      }]
    })
  }, [])

  const addSubTask = useCallback((blockIndex: number) => {
    setPlanBlocks(prev => prev.map((b, i) =>
      i === blockIndex
        ? { ...b, subTasks: [...b.subTasks, { content: '', estimatedMinutes: 30 }] }
        : b
    ))
  }, [])

  const updateSubTask = useCallback((blockIndex: number, subIndex: number, field: 'content' | 'estimatedMinutes', value: string | number) => {
    setPlanBlocks(prev => prev.map((b, i) =>
      i === blockIndex
        ? {
          ...b,
          subTasks: b.subTasks.map((s, j) =>
            j === subIndex ? { ...s, [field]: value } : s
          ),
        }
        : b
    ))
  }, [])

  const removeSubTask = useCallback((blockIndex: number, subIndex: number) => {
    setPlanBlocks(prev => prev.map((b, i) =>
      i === blockIndex
        ? { ...b, subTasks: b.subTasks.filter((_, j) => j !== subIndex) }
        : b
    ).filter(b => b.subTasks.length > 0))
  }, [])

  const removeBlock = useCallback((blockIndex: number) => {
    setPlanBlocks(prev => prev.filter((_, i) => i !== blockIndex))
  }, [])

  const handleNext = () => {
    // Convert to flat list of BatchCreatePlanItem
    const items: BatchCreatePlanItem[] = []
    let order = 0
    for (const block of planBlocks) {
      for (const st of block.subTasks) {
        if (st.content.trim()) {
          items.push({
            taskId: block.taskId,
            content: st.content.trim(),
            estimatedMinutes: st.estimatedMinutes,
            estimatedStart: '', // filled in step 2
            estimatedEnd: '',   // filled in step 2
            sortOrder: order++,
          })
        }
      }
    }
    if (items.length === 0) return
    onNext(items)
  }

  // Manual sort: move block up/down
  const moveBlock = (from: number, to: number) => {
    if (to < 0 || to >= planBlocks.length) return
    setPlanBlocks(prev => {
      const next = [...prev]
      ;[next[from], next[to]] = [next[to], next[from]]
      return next
    })
  }

  return (
    <div className="flex h-full">
      {/* Left: Available Tasks */}
      <div className="w-[30%] border-r bg-muted/20 p-4 flex flex-col">
        <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Tasks</h3>
        <div className="flex-1 overflow-auto space-y-1">
          {availableTasks.map(task => (
            <button
              key={task.id}
              className="w-full text-left p-2 rounded hover:bg-muted text-sm flex items-center gap-2 cursor-grab active:cursor-grabbing"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('taskId', task.id)}
              onClick={() => addTaskBlock(task)}
            >
              <GripVertical className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <span className="truncate">{task.title}</span>
              <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{task.id}</span>
            </button>
          ))}
          {availableTasks.length === 0 && (
            <p className="text-xs text-muted-foreground p-2">No available tasks</p>
          )}
        </div>
      </div>

      {/* Right: Plan Editor */}
      <div className="flex-1 p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Edit Plan</h2>
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md flex items-center gap-2 text-sm"
            onClick={handleNext}
          >
            Next Step <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div
          className="flex-1 overflow-auto space-y-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const taskId = e.dataTransfer.getData('taskId')
            const task = availableTasks.find(t => t.id === taskId)
            if (task) addTaskBlock(task)
          }}
        >
          {planBlocks.map((block, bi) => {
            const task = tasks.find(t => t.id === block.taskId)
            return (
              <div key={`${block.taskId}-${bi}`} className="border rounded-lg p-3 bg-card">
                <div className="flex items-center gap-2 mb-2">
                  <GripVertical className="w-4 h-4 text-muted-foreground cursor-grab" />
                  <span className="text-sm font-medium">Task: {task?.title ?? block.taskId}</span>
                  <span className="text-xs text-muted-foreground">{block.taskId}</span>
                  <div className="ml-auto flex gap-1">
                    <button className="p-1 hover:bg-muted rounded" onClick={() => moveBlock(bi, bi - 1)} title="Move up">
                      ↑
                    </button>
                    <button className="p-1 hover:bg-muted rounded" onClick={() => moveBlock(bi, bi + 1)} title="Move down">
                      ↓
                    </button>
                    <button className="p-1 hover:bg-destructive/20 rounded text-destructive" onClick={() => removeBlock(bi)}>
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  {block.subTasks.map((st, si) => (
                    <div key={si} className="flex gap-2 items-center">
                      <input
                        className="flex-1 px-2 py-1.5 border rounded text-sm bg-background"
                        placeholder={`Sub-task ${si + 1}...`}
                        value={st.content}
                        onChange={(e) => updateSubTask(bi, si, 'content', e.target.value)}
                      />
                      <input
                        className="w-20 px-2 py-1.5 border rounded text-sm bg-background text-center"
                        type="number"
                        min={1}
                        placeholder="min"
                        value={st.estimatedMinutes}
                        onChange={(e) => updateSubTask(bi, si, 'estimatedMinutes', parseInt(e.target.value) || 0)}
                      />
                      <span className="text-xs text-muted-foreground w-8">min</span>
                      <button
                        className="p-1 hover:bg-destructive/20 rounded text-destructive"
                        onClick={() => removeSubTask(bi, si)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  className="mt-2 text-xs text-primary hover:underline flex items-center gap-1"
                  onClick={() => addSubTask(bi)}
                >
                  <Plus className="w-3 h-3" /> Add sub-task
                </button>
              </div>
            )
          })}

          {planBlocks.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              <p>Drag tasks from the left, or click a task to add it</p>
            </div>
          )}
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
    const base = roundUpTo5Minutes(new Date(Date.now() + 10 * 60 * 1000))
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

  const handleSave = () => {
    onSave(scheduleItems)
  }

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center justify-between mb-4">
        <button className="flex items-center gap-2 text-sm hover:text-primary" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold">Schedule Plan</h2>
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
        {scheduleItems.map((item, index) => {
          const breakBefore = index > 0
            ? timeToMinutes(item.estimatedStart) - timeToMinutes(scheduleItems[index - 1].estimatedEnd)
            : 0

          return (
            <div key={index}>
              {/* Break indicator */}
              {breakBefore > 0 && (
                <div className="flex items-center gap-2 py-1 px-4">
                  <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {breakBefore} min break
                  </span>
                  <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
                </div>
              )}

              {/* Sub-task row */}
              <div
                className={`border rounded-lg p-3 mx-2 bg-card ${dragging ? 'cursor-grabbing' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-16 text-center">
                    <div className="text-sm font-mono text-muted-foreground">{item.estimatedStart}</div>
                    <div className="text-[10px] text-muted-foreground">to</div>
                    <div className="text-sm font-mono text-muted-foreground">{item.estimatedEnd}</div>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm">● {item.content}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.taskId} · {item.estimatedMinutes} min
                    </div>
                  </div>
                  <GripVertical
                    className={`w-4 h-4 text-muted-foreground ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    onMouseDown={(e) => handleMouseDown(index, e)}
                  />
                </div>
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

  const handleStepOneNext = (newItems: BatchCreatePlanItem[]) => {
    setItems(newItems)
    setStep(2)
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

      <div className="flex-1 overflow-hidden">
        {step === 1 ? (
          <EditPlanStep onNext={handleStepOneNext} />
        ) : (
          <ScheduleStep items={items} onBack={handleStepTwoBack} onSave={handleSave} />
        )}
      </div>
    </div>
  )
}
