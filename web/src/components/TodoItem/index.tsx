import type { Task } from '@/types'
import { priorityColors } from '@/types'
import { cn } from '@/lib/utils'
import { formatTaskTime } from '@/lib/time'

interface TodoItemProps {
  task: Task
  isActive: boolean
  onClick: () => void
}

export function TodoItem({ task, isActive, onClick }: TodoItemProps) {
  const timeLabel = formatTaskTime(task.createdAt)
  const timeTitle = new Date(task.createdAt).toLocaleString()

  return (
    <button
      data-task-id={task.id}
      className={cn(
        'w-full text-left p-3 rounded-lg border transition group relative',
        isActive
          ? 'bg-primary/10 border-primary/50 ring-1 ring-primary/30'
          : 'bg-card hover:bg-muted/50 border-border'
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${priorityColors[task.priority]}`} />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium truncate">{task.title}</h4>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-2 whitespace-nowrap" title={timeTitle}>
          {timeLabel}
        </span>
      </div>
    </button>
  )
}
