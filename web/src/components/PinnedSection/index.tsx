import { useState } from 'react'
import { useI18n } from '@/i18n/context'
import type { TaskEntry } from '@/types'
import { TaskEntryBlock } from '@/components/TaskEntryBlock'
import { Pin, Pencil, PinOff, ChevronDown, ChevronUp } from 'lucide-react'
import { highlightHtml } from '@/lib/highlight'
import DOMPurify from 'dompurify'

interface PinnedSectionProps {
  entry: TaskEntry
  taskId: string
  onUpdate: (entryId: string, content: string) => Promise<void>
  onUnpin: (entryId: string) => Promise<void>
  highlightTokens?: string[]
  highlightActive?: boolean
}

function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  const text = html.replace(/<[^>]*>/g, '').trim()
  return text.length === 0
}

export function PinnedSection({ entry, taskId, onUpdate, onUnpin, highlightTokens, highlightActive = false }: PinnedSectionProps) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('chronicle_pinned_collapsed') === '1')

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('chronicle_pinned_collapsed', next ? '1' : '0')
  }

  const handleSave = async (id: string, content: string) => {
    if (isHtmlEmpty(content)) return
    await onUpdate(id, content.trim())
    setEditing(false)
  }

  const handleUnpin = async () => {
    await onUnpin(entry.id)
  }

  return (
    <div
      data-task-entry-id={entry.id}
      className={`ml-auto w-full max-w-[560px] rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 shadow-sm ${highlightActive ? 'ring-1 ring-primary animate-highlight-flash' : ''}`}
    >
      <div className="flex w-full items-center justify-between gap-3">
        <button
          className="flex items-center gap-1.5 text-left"
          onClick={toggleCollapsed}
          title={collapsed ? t('pinned.expand') : t('pinned.collapse')}
        >
          <Pin className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 fill-amber-600 dark:fill-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{t('pinned.title')}</span>
          {collapsed ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronUp className="w-3 h-3 text-muted-foreground" />}
        </button>
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-amber-100 dark:hover:bg-amber-900/50 transition"
            title={t('pinned.edit')}
            onClick={() => {
              if (collapsed) setCollapsed(false)
              setEditing((v) => !v)
            }}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1.5 rounded text-muted-foreground hover:text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition"
            title={t('pinned.unpin')}
            onClick={handleUnpin}
          >
            <PinOff className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="mt-2">
          {editing ? (
            <TaskEntryBlock
              entry={entry}
              taskId={taskId}
              onSave={handleSave}
              onDelete={() => {}}
              editing
              onEditingChange={setEditing}
              highlightTokens={highlightTokens}
            />
          ) : (
            <div
              className="text-sm prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2 text-foreground"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(
                  highlightTokens?.length ? highlightHtml(entry.content, highlightTokens) : entry.content,
                  { ALLOW_UNKNOWN_PROTOCOLS: true }
                ),
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
