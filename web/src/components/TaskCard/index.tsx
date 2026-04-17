import { X, Tag, Calendar } from 'lucide-react'
import type { Task, Priority } from '@/types'
import { priorityColors } from '@/types'
import { format } from 'date-fns'
import { useI18n } from '@/i18n/context'

interface TaskCardProps {
  task: Task
  onClick: () => void
  onDelete: () => void
}

export function TaskCard({ task, onClick, onDelete }: TaskCardProps) {
  const { t, dateLocale } = useI18n()
  const priorityBadge = (p: Priority) => t(`priority.${p.toLowerCase()}`)

  return (
    <div
      className={`p-3 rounded-lg border bg-card cursor-pointer hover:shadow-md transition group relative ${priorityColors[task.priority]} border-l-4`}
      onClick={onClick}
    >
      <button
        className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-white transition"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
      >
        <X className="w-3 h-3" />
      </button>
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${priorityColors[task.priority]} text-white`}>
          {priorityBadge(task.priority)}
        </span>
      </div>
      <h4 className="font-medium text-sm mb-2 line-clamp-2">{task.title}</h4>
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-xs px-1.5 py-0.5 bg-muted rounded flex items-center gap-0.5">
              <Tag className="w-2.5 h-2.5" />
              {tag}
            </span>
          ))}
          {task.tags.length > 3 && (
            <span className="text-xs text-muted-foreground">+{task.tags.length - 3}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t(`type.${task.type.toLowerCase()}`)}</span>
        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {format(new Date(task.createdAt), 'MM-dd', { locale: dateLocale })}
        </span>
      </div>
    </div>
  )
}
