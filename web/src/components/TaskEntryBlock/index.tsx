import { useState, useEffect, useRef, useCallback } from 'react'
import DOMPurify from 'dompurify'
import type { TaskEntry } from '@/types'
import { RichEditor } from '@/components/RichEditor'
import { useI18n } from '@/i18n/context'
import { format } from 'date-fns'
import { highlightHtml } from '@/lib/highlight'
import { ZoomIn, ZoomOut, X, Trash2, Pin } from 'lucide-react'

// Check if HTML content is effectively empty (no visible text)
function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  const text = html.replace(/<[^>]*>/g, '').trim()
  const decoded = text.replace(/&nbsp;/g, '').replace(/\s+/g, '')
  return decoded.length === 0
}

// Check if Tauri environment
function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI__
}

// Convert data-fullpath attributes in HTML to Tauri asset URLs for rendering
function convertImageSrcs(html: string): string {
  if (!isTauri()) return html
  try {
    const tauriCore = (window as any).__TAURI__.core
    html = html.replace(/(<img\b[^>]*?)data-fullpath="([^"]+)"([^>]*?)>/g, (_match: string, before: string, fullPath: string, after: string) => {
      const cleaned = before.replace(/src=""\s*/, '')
      return `${cleaned}src="${tauriCore.convertFileSrc(fullPath)}" data-fullpath="${fullPath}"${after}>`
    })
    return html
  } catch {
    return html
  }
}

function withCodeBlockWrapButtons(html: string): string {
  return html.replace(/<pre\b([^>]*)>/g, (_match, attrs: string) => {
    const nextAttrs = /\sdata-code-wrap=/.test(attrs) ? attrs : `${attrs} data-code-wrap="on"`
    return `<pre${nextAttrs}><button type="button" class="code-block-wrap-toggle" aria-label="Toggle code block soft wrap" title="Toggle soft wrap" aria-pressed="${nextAttrs.includes('data-code-wrap="off"') ? 'false' : 'true'}">↵</button>`
  })
}

interface TaskEntryBlockProps {
  entry?: TaskEntry
  onSave: (id: string, newContent: string) => void
  onDelete?: (id: string) => void
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  isNewEntry?: boolean
  onSubmit?: (content: string) => void
  onSilentSave?: (content: string) => void
  onChange?: (content: string) => void
  onFirstMeaningfulEdit?: () => void
  onPin?: (content: string) => void
  initialContent?: string
  highlightTokens?: string[]
  highlightPlan?: boolean
  taskId?: string
}

interface ImageViewerProps {
  src: string
  onClose: () => void
}

function ImageViewer({ src, onClose }: ImageViewerProps) {
  const { t } = useI18n()
  const [scale, setScale] = useState(1)

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setScale(prev => {
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      return Math.max(0.1, Math.min(5, prev + delta))
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center"
      onClick={onClose}
      onWheel={handleWheel}
    >
      {/* Close button */}
      <button
        className="absolute top-4 right-4 p-2 text-white/80 hover:text-white bg-white/10 rounded-full hover:bg-white/20 transition z-10"
        onClick={(e) => { e.stopPropagation(); onClose() }}
      >
        <X className="w-5 h-5" />
      </button>

      {/* Image */}
      <img
        src={src}
        alt=""
        className="max-w-[90vw] max-h-[85vh] object-contain transition-transform duration-150"
        style={{ transform: `scale(${scale})` }}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />

      {/* Toolbar */}
      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur-sm rounded-full px-3 py-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded-full transition"
          title={t('imageViewer.zoomOut')}
          onClick={() => setScale(s => Math.max(0.1, s - 0.25))}
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-white/60 text-xs font-mono w-12 text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          className="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded-full transition"
          title={t('imageViewer.zoomIn')}
          onClick={() => setScale(s => Math.min(5, s + 0.25))}
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-white/20" />
        <button
          className="px-2 py-1 text-white/80 hover:text-white hover:bg-white/10 rounded-full transition text-xs"
          title={t('imageViewer.fitScreen')}
          onClick={() => setScale(1)}
        >
          {Math.round(scale * 100) === 100 ? t('imageViewer.fitScreen') : '100%'}
        </button>
      </div>
    </div>
  )
}

export function TaskEntryBlock({ entry, onSave, onDelete, editing: externalEditing, onEditingChange, isNewEntry, onSubmit, onSilentSave, onChange, onFirstMeaningfulEdit, onPin, initialContent, highlightTokens, highlightPlan, taskId }: TaskEntryBlockProps) {
  const { t, dateLocale } = useI18n()
  const [internalEditing, setInternalEditing] = useState(false)
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; text: string } | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // localStorage key for draft content persistence
  const draftKey = taskId ? `chronicle:entry_draft:${taskId}:${entry?.id ?? '__new__'}` : null

  // Initialize draft content from localStorage, then entry content, then initialContent
  const [draftContent, setDraftContent] = useState(() => {
    if (draftKey) {
      const saved = localStorage.getItem(draftKey)
      if (saved) return saved
    }
    return initialContent ?? entry?.content ?? ''
  })
  const [newEntryVersion, setNewEntryVersion] = useState(0)
  const [imageViewerSrc, setImageViewerSrc] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)
  const hasFiredFirstMeaningfulEditRef = useRef(false)
  const originalContentRef = useRef(entry?.content ?? '')

  const editing = externalEditing ?? internalEditing

  useEffect(() => {
    hasFiredFirstMeaningfulEditRef.current = false
    originalContentRef.current = entry?.content ?? ''
  }, [taskId, entry?.id, isNewEntry])

  useEffect(() => {
    if (isNewEntry && isHtmlEmpty(draftContent)) {
      hasFiredFirstMeaningfulEditRef.current = false
    }
  }, [draftContent, isNewEntry])

  useEffect(() => {
    if (isNewEntry) hasFiredFirstMeaningfulEditRef.current = false
  }, [isNewEntry, newEntryVersion])

  // When not editing, sync draft content from entry (external updates) or clear localStorage
  useEffect(() => {
    if (!editing && entry) {
      setDraftContent(entry.content)
      if (draftKey) localStorage.removeItem(draftKey)
    }
  }, [entry?.content, editing, draftKey])

  // New entry mode: sync draft content when taskId changes (initialContent from store)
  useEffect(() => {
    if (!isNewEntry || editing) return
    // Sync from localStorage key for this task's new entry
    if (draftKey) {
      const saved = localStorage.getItem(draftKey)
      if (saved) {
        setDraftContent(saved)
        return
      }
    }
    // No saved draft — sync from parent's initialContent
    setDraftContent(initialContent ?? '')
  }, [taskId, initialContent, isNewEntry, editing, draftKey])

  // Auto-save draft content to localStorage on every change
  const handleDraftChange = useCallback((html: string) => {
    setDraftContent(html)
    if (draftKey) localStorage.setItem(draftKey, html)
    onChange?.(html)

    if (hasFiredFirstMeaningfulEditRef.current || !onFirstMeaningfulEdit) return

    const isMeaningfulEdit = isNewEntry
      ? !isHtmlEmpty(html)
      : Boolean(entry && html.trim() !== originalContentRef.current.trim())

    if (isMeaningfulEdit) {
      hasFiredFirstMeaningfulEditRef.current = true
      onFirstMeaningfulEdit()
    }
  }, [draftKey, onChange, onFirstMeaningfulEdit, isNewEntry, entry])

  const handleEdit = () => {
    if (!entry) return
    hasFiredFirstMeaningfulEditRef.current = false
    originalContentRef.current = entry.content
    setDraftContent(entry.content)
    if (draftKey) localStorage.setItem(draftKey, entry.content)
    if (onEditingChange) {
      onEditingChange(true)
    } else {
      setInternalEditing(true)
    }
  }

  const handleSave = () => {
    if (isHtmlEmpty(draftContent)) return
    if (!entry) return
    onSave(entry.id, draftContent.trim())
    hasFiredFirstMeaningfulEditRef.current = false
    if (draftKey) localStorage.removeItem(draftKey)
    if (onEditingChange) {
      onEditingChange(false)
    } else {
      setInternalEditing(false)
    }
  }

  const handleSilentSave = () => {
    if (isHtmlEmpty(draftContent)) return
    if (!entry) return
    onSave(entry.id, draftContent.trim())
    // Don't clear localStorage or exit editing — keep draft state
  }

  const handleCancel = () => {
    hasFiredFirstMeaningfulEditRef.current = false
    if (draftKey) localStorage.removeItem(draftKey)
    if (entry) setDraftContent(entry.content)
    if (onEditingChange) {
      onEditingChange(false)
    } else {
      setInternalEditing(false)
    }
  }

  const handleSubmit = async () => {
    if (isHtmlEmpty(draftContent)) return
    hasFiredFirstMeaningfulEditRef.current = false
    await onSubmit?.(draftContent.trim())
    hasFiredFirstMeaningfulEditRef.current = false
    if (draftKey) localStorage.removeItem(draftKey)
    setDraftContent('')
    setNewEntryVersion((version) => version + 1)
  }

  // Auto-save to DB every 30s when editing an existing entry
  useEffect(() => {
    if (!editing || !entry || isNewEntry) return
    const timer = setInterval(() => {
      if (!isHtmlEmpty(draftContent)) {
        onSave(entry.id, draftContent.trim())
      }
    }, 30000)
    return () => clearInterval(timer)
  }, [editing, entry?.id, draftContent, onSave])

  // Auto-save for new entry mode every 30s
  useEffect(() => {
    if (!isNewEntry || editing) return
    const timer = setInterval(() => {
      if (!isHtmlEmpty(draftContent)) {
        onSilentSave?.(draftContent.trim())
      }
    }, 30000)
    return () => clearInterval(timer)
  }, [isNewEntry, editing, draftContent, onSilentSave])

  // Hide selection toolbar when clicking outside or when selection is cleared
  useEffect(() => {
    if (!selectionToolbar) return
    const handleDocMouseDown = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        setSelectionToolbar(null)
      }
    }
    document.addEventListener('mousedown', handleDocMouseDown)
    return () => document.removeEventListener('mousedown', handleDocMouseDown)
  }, [selectionToolbar])

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
    } else {
      setConfirmDelete(false)
      onDelete?.(entry!.id)
    }
  }

  // New entry mode
  if (isNewEntry) {
    return (
      <>
        <RichEditor
          key={`${taskId ?? 'new'}:${newEntryVersion}`}
          content={draftContent}
          onChange={handleDraftChange}
          placeholder={t('task.logPlaceholder')}
          variant="full"
          taskId={taskId}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault(); e.stopPropagation()
              if (!isHtmlEmpty(draftContent)) onSilentSave?.(draftContent.trim())
            } else if (e.key === 'Escape') {
              e.preventDefault(); e.stopPropagation()
            } else if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault(); e.stopPropagation()
              handleSubmit()
            }
          }}
        />
        <button
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 text-sm mt-2"
          onClick={handleSubmit}
          disabled={isHtmlEmpty(draftContent)}
        >
          {t('workspace.submitLog')}
        </button>
      </>
    )
  }

  // Editing mode for existing entry
  if (editing && entry) {
    return (
      <div className="py-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted-foreground">
            {format(new Date(entry.createdAt), 'yyyy-MM-dd HH:mm', { locale: dateLocale })}
          </span>
        </div>
        <RichEditor
          key={entry.id}
          content={draftContent}
          onChange={handleDraftChange}
          placeholder={t('entry.editPlaceholder')}
          minHeight="120px"
          autoFocus
          taskId={taskId}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault()
              e.stopPropagation()
              handleSilentSave()
            } else if (e.key === 'Escape') {
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

  const handleContainerClick = async (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return
    const dx = e.clientX - mouseDownPos.current.x
    const dy = e.clientY - mouseDownPos.current.y
    if (Math.sqrt(dx * dx + dy * dy) > 3) return // was a drag/selection, not a click

    const wrapButton = (e.target as HTMLElement).closest('button.code-block-wrap-toggle') as HTMLButtonElement | null
    if (wrapButton) {
      e.preventDefault()
      e.stopPropagation()
      const pre = wrapButton.closest('pre')
      if (pre) {
        const next = pre.getAttribute('data-code-wrap') === 'off' ? 'on' : 'off'
        pre.setAttribute('data-code-wrap', next)
        wrapButton.setAttribute('aria-pressed', String(next === 'on'))
        wrapButton.title = next === 'on' ? 'Disable soft wrap' : 'Enable soft wrap'
      }
      return
    }

    // Handle image click — open viewer
    const imgEl = (e.target as HTMLElement).closest('img') as HTMLImageElement | null
    if (imgEl) {
      const filename = imgEl.getAttribute('data-filename')
      if (filename && taskId && isTauri()) {
        try {
          const tauriCore = (window as any).__TAURI__.core
          const fullPath: string = await tauriCore.invoke('resolve_attachment_path', { taskId, fileName: filename })
          const assetUrl = tauriCore.convertFileSrc(fullPath)
          setImageViewerSrc(assetUrl)
        } catch {
          setImageViewerSrc(imgEl.src)
        }
      } else {
        // Fallback: use the image's current src (base64 or asset URL)
        setImageViewerSrc(imgEl.src)
      }
      return
    }

    // Handle attachment link clicks — open file in Finder
    const linkEl = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
    if (linkEl) {
      let filePath: string | null = null

      // Check for data-file-path attribute (legacy format)
      if (linkEl.dataset.filePath) {
        filePath = linkEl.dataset.filePath
      }
      // Check for file:// URL with chronicle_attachment query param (legacy format)
      else if (linkEl.href.startsWith('file://') && linkEl.href.includes('chronicle_attachment')) {
        filePath = linkEl.href.replace('file://', '').replace(/\?.*$/, '')
      }
      // Check for chronicle-attachment:// URL (new format)
      else if (linkEl.href.startsWith('chronicle-attachment://')) {
        filePath = linkEl.href.replace('chronicle-attachment://', '')
      } else {
        // Not an attachment link, don't intercept
        return
      }

      if (filePath) {
        e.preventDefault()
        e.stopPropagation()
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('reveal_file_in_finder', { path: filePath })
            .catch(() => window.open(`file://${filePath}`))
        }).catch(() => {
          window.open(`file://${filePath}`)
        })
        return
      }
    }

    handleEdit()
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY }
  }

  const handlePinClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!entry || entry.type !== 'log' || !onPin) return
    onPin(entry.content)
  }

  const handleSelectionMouseUp = (_e: React.MouseEvent) => {
    if (!onPin || !contentRef.current) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionToolbar(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      setSelectionToolbar(null)
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      setSelectionToolbar(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelectionToolbar({ x: rect.left + rect.width / 2, y: rect.top - 40, text })
  }

  const handleAddSelectionToPin = () => {
    if (!selectionToolbar) return
    const selection = window.getSelection()
    let html = ''
    if (selection && selection.rangeCount > 0) {
      const container = document.createElement('div')
      container.appendChild(selection.getRangeAt(0).cloneContents())
      html = container.innerHTML
    }
    onPin?.(html || `<p>${selectionToolbar.text}</p>`)
    setSelectionToolbar(null)
    window.getSelection()?.removeAllRanges()
  }

  // Display mode — show existing entry content
  if (!entry) return null

  return (
    <>
      <div
        data-testid="task-entry-block"
        className={`py-2 cursor-pointer hover:bg-muted/40 rounded group ${highlightPlan ? 'bg-primary/10 ring-1 ring-primary animate-highlight-flash' : ''}`}
        onMouseDown={handleMouseDown}
        onMouseUp={handleSelectionMouseUp}
        onClick={handleContainerClick}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted-foreground">
            {format(new Date(entry.createdAt), 'yyyy-MM-dd HH:mm', { locale: dateLocale })}
          </span>
          <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
            {entry.type === 'log' && onPin && (
              <button
                className="p-1 rounded text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition"
                onClick={handlePinClick}
                title={t('pinned.pinThisLog')}
              >
                <Pin className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              className={`p-1 rounded transition ${confirmDelete ? 'bg-red-500 text-white' : 'text-muted-foreground hover:text-red-500 hover:bg-red-500/10'}`}
              onClick={handleDeleteClick}
              title={confirmDelete ? t('entry.confirmDelete') : t('entry.delete')}
            >
              {confirmDelete ? <X className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        <div
          ref={contentRef}
          data-testid="entry-content"
          className="text-sm prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2 opacity-90 group-hover:opacity-100 transition prose-mirror-display"
          dangerouslySetInnerHTML={{ __html: withCodeBlockWrapButtons(DOMPurify.sanitize(highlightTokens?.length ? highlightHtml(convertImageSrcs(entry.content), highlightTokens) : convertImageSrcs(entry.content), { ALLOW_UNKNOWN_PROTOCOLS: true })) }}
        />
      </div>
      {selectionToolbar && (
        <div
          className="fixed z-[100] bg-popover border rounded-md shadow-md py-1 px-1.5 flex items-center gap-1"
          style={{ left: selectionToolbar.x, top: selectionToolbar.y, transform: 'translateX(-50%)' }}
        >
          <button
            className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-muted transition"
            onClick={handleAddSelectionToPin}
          >
            <Pin className="w-3 h-3 text-amber-500 fill-amber-500" />
            {t('pinned.addToPin')}
          </button>
        </div>
      )}
      {imageViewerSrc && (
        <ImageViewer src={imageViewerSrc} onClose={() => setImageViewerSrc(null)} />
      )}
    </>
  )
}
