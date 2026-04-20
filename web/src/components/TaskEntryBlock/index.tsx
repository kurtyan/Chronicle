import { useState, useEffect } from 'react'
import DOMPurify from 'dompurify'
import type { TaskEntry } from '@/types'
import { RichEditor } from '@/components/RichEditor'
import { useI18n } from '@/i18n/context'
import { format } from 'date-fns'
import { highlightHtml } from '@/lib/highlight'

// Check if HTML content is effectively empty (no visible text)
function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  // Remove HTML tags and check for remaining text
  const text = html.replace(/<[^>]*>/g, '').trim()
  // Also check for &nbsp; and other common empty HTML entities
  const decoded = text.replace(/&nbsp;/g, '').replace(/\s+/g, '')
  return decoded.length === 0
}

interface TaskEntryBlockProps {
  entry: TaskEntry
  onSave: (id: string, newContent: string) => void
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  highlightTokens?: string[]
}

export function TaskEntryBlock({ entry, onSave, editing: externalEditing, onEditingChange, highlightTokens }: TaskEntryBlockProps) {
  const { t, dateLocale } = useI18n()
  const [internalEditing, setInternalEditing] = useState(false)
  const [draftContent, setDraftContent] = useState(entry.content)

  const editing = externalEditing ?? internalEditing

  useEffect(() => {
    if (!editing) {
      setDraftContent(entry.content)
    }
  }, [entry.content, editing])

  const handleEdit = () => {
    setDraftContent(entry.content)
    if (onEditingChange) {
      onEditingChange(true)
    } else {
      setInternalEditing(true)
    }
  }

  const handleSave = () => {
    if (isHtmlEmpty(draftContent)) {
      // Don't save empty content, stay in editing mode
      return
    }
    onSave(entry.id, draftContent.trim())
    if (onEditingChange) {
      onEditingChange(false)
    } else {
      setInternalEditing(false)
    }
  }

  const handleCancel = () => {
    setDraftContent(entry.content)
    if (onEditingChange) {
      onEditingChange(false)
    } else {
      setInternalEditing(false)
    }
  }

  if (editing) {
    return (
      <div className="py-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted-foreground">
            {format(new Date(entry.createdAt), 'yyyy-MM-dd HH:mm', { locale: dateLocale })}
          </span>
        </div>
        <RichEditor
          content={draftContent}
          onChange={setDraftContent}
          placeholder={t('entry.editPlaceholder')}
          minHeight="120px"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              handleCancel()
            } else if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              handleSave()
            }
          }}
        />
        <div className="flex gap-2 mt-2 justify-end">
          <button
            className="px-3 py-1 text-sm border rounded-md hover:bg-muted transition"
            onClick={handleCancel}
          >
            {t('entry.cancel')}
          </button>
          <button
            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded-md hover:opacity-90 transition"
            onClick={handleSave}
          >
            {t('entry.save')}
          </button>
        </div>
      </div>
    )
  }

  const handleContainerClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) return
    handleEdit()
  }

  return (
    <div
      className="py-2 cursor-pointer hover:bg-muted/40 rounded transition group"
      onClick={handleContainerClick}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-muted-foreground">
          {format(new Date(entry.createdAt), 'yyyy-MM-dd HH:mm', { locale: dateLocale })}
        </span>
      </div>
      <div
        className="text-sm prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2 opacity-90 group-hover:opacity-100 transition prose-mirror-display"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightTokens?.length ? highlightHtml(entry.content, highlightTokens) : entry.content) }}
      />
    </div>
  )
}
