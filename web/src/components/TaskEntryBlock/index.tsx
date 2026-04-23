import { useState, useEffect, useRef, useCallback } from 'react'
import DOMPurify from 'dompurify'
import type { TaskEntry } from '@/types'
import { RichEditor } from '@/components/RichEditor'
import { useI18n } from '@/i18n/context'
import { format } from 'date-fns'
import { highlightHtml } from '@/lib/highlight'
import { ZoomIn, ZoomOut, X } from 'lucide-react'

// Check if HTML content is effectively empty (no visible text)
function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  // Remove HTML tags and check for remaining text
  const text = html.replace(/<[^>]*>/g, '').trim()
  // Also check for &nbsp; and other common empty HTML entities
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
    // Convert img data-fullpath to src + asset URL
    html = html.replace(/(<img\b[^>]*?)data-fullpath="([^"]+)"([^>]*?)>/g, (_match: string, before: string, fullPath: string, after: string) => {
      // Remove src="" if present
      const cleaned = before.replace(/src=""\s*/, '')
      return `${cleaned}src="${tauriCore.convertFileSrc(fullPath)}" data-fullpath="${fullPath}"${after}>`
    })
    return html
  } catch {
    return html
  }
}

interface TaskEntryBlockProps {
  entry: TaskEntry
  onSave: (id: string, newContent: string) => void
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  highlightTokens?: string[]
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

export function TaskEntryBlock({ entry, onSave, editing: externalEditing, onEditingChange, highlightTokens, taskId }: TaskEntryBlockProps) {
  const { t, dateLocale } = useI18n()
  const [internalEditing, setInternalEditing] = useState(false)
  const [draftContent, setDraftContent] = useState(entry.content)
  const [imageViewerSrc, setImageViewerSrc] = useState<string | null>(null)
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)

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
          key={entry.id}
          content={draftContent}
          onChange={setDraftContent}
          placeholder={t('entry.editPlaceholder')}
          minHeight="120px"
          autoFocus
          taskId={taskId}
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

  const handleContainerClick = async (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return
    const dx = e.clientX - mouseDownPos.current.x
    const dy = e.clientY - mouseDownPos.current.y
    if (Math.sqrt(dx * dx + dy * dy) > 3) return // was a drag/selection, not a click

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

  return (
    <>
      <div
        className="py-2 cursor-pointer hover:bg-muted/40 rounded transition group"
        onMouseDown={handleMouseDown}
        onClick={handleContainerClick}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted-foreground">
            {format(new Date(entry.createdAt), 'yyyy-MM-dd HH:mm', { locale: dateLocale })}
          </span>
        </div>
        <div
          className="text-sm prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2 opacity-90 group-hover:opacity-100 transition prose-mirror-display"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightTokens?.length ? highlightHtml(convertImageSrcs(entry.content), highlightTokens) : convertImageSrcs(entry.content), { ALLOW_UNKNOWN_PROTOCOLS: true }) }}
        />
      </div>
      {imageViewerSrc && (
        <ImageViewer src={imageViewerSrc} onClose={() => setImageViewerSrc(null)} />
      )}
    </>
  )
}
