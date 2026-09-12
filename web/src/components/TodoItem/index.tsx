import { useProjectStore } from '@/stores/projectStore'
import { ProjectFeatureBoundary } from '@/components/Projects/ProjectFeatureBoundary'
import type { Task } from '@/types'
import { priorityColors } from '@/types'
import { cn } from '@/lib/utils'
import { formatTaskTime } from '@/lib/time'
import { Pin } from 'lucide-react'

interface TodoItemProps {
  task: Task
  isActive: boolean
  pinned?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

export function TodoItem({ task, isActive, pinned, onClick, onContextMenu }: TodoItemProps) {
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
      onContextMenu={onContextMenu}
    >
      <div className="flex items-start gap-2">
        {pinned && <Pin className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />}
        <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${priorityColors[task.priority]}`} />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium truncate">{task.title}</h4>
          {task.primaryMilestoneId && <ProjectFeatureBoundary resetKey={task.primaryMilestoneId} fallback={<span className="text-xs text-muted-foreground">里程碑暂时不可用</span>}><TaskMilestoneLabel milestoneId={task.primaryMilestoneId} /></ProjectFeatureBoundary>}
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-2 whitespace-nowrap" title={timeTitle}>
          {timeLabel}
        </span>
      </div>
    </button>
  )
}

function TaskMilestoneLabel({ milestoneId }: { milestoneId: string }) {
  const milestones = useProjectStore(state => state.milestones)
  const milestone = milestones.find(item => item.id === milestoneId)
  return <p className="mt-1 truncate text-xs text-primary/80">{milestone?.name || milestoneId}{milestone?.archived ? ' · 已归档' : ''}</p>
}
