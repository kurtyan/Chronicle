import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import type { NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core'
import { Selection, TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import ImageResize from 'tiptap-extension-resize-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Italic, List, ListOrdered, Code, Link2, Image as ImageIcon, Strikethrough, Heading1, Heading2, Heading3, Heading4, Indent, Outdent, Quote } from 'lucide-react'
import { useEffect, useRef, useMemo, useState } from 'react'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'
import { WrappedCodeBlock } from '@/components/RichEditor/WrappedCodeBlock'

/** Detect Tauri environment */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI__
}

/** Insert image with a default width */
export function insertImageWithAttrs(ed: Editor, filePath: string, filename?: string, insertionPosition?: number) {
  if ((ed as any).isDestroyed) return
  const src = isTauri()
    ? (window as any).__TAURI__.core.convertFileSrc(filePath)
    : `file://${filePath}`
  const { state } = ed
  const imageNode = ed.schema.nodes.imageResize.create({
    src,
    width: 500,
    containerStyle: `width: 500px; height: auto; cursor: pointer;`,
    fullpath: filePath,
    filename,
  })
  const paragraphNode = ed.schema.nodes.paragraph.create()
  const insertPos = insertionPosition === undefined
    ? state.selection.from
    : Math.max(1, Math.min(insertionPosition, state.doc.content.size))
  try {
    let tr = state.tr.setSelection(Selection.near(state.doc.resolve(insertPos)))
    tr = tr.replaceSelectionWith(imageNode, false)
    const paragraphPos = Math.min(insertPos + imageNode.nodeSize, tr.doc.content.size)
    tr = tr.insert(paragraphPos, paragraphNode)
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(paragraphPos + 1, tr.doc.content.size))))
    ed.view.dispatch(tr)
    ed.commands.focus()
    window.requestAnimationFrame(resolveImageSrcsInEditor)
  } catch (err) {
    console.error('Failed to insert image at captured position, falling back to current selection:', err)
    ed.chain().focus().insertContent({
      type: 'imageResize',
      attrs: {
        src,
        width: 500,
        containerStyle: `width: 500px; height: auto; cursor: pointer;`,
        fullpath: filePath,
        filename,
      },
    }).run()
    window.requestAnimationFrame(resolveImageSrcsInEditor)
  }
}

/** Upload image via Tauri invoke and insert into editor */
export async function uploadAndInsertImage(ed: Editor | null, taskId: string, file: File, insertionPosition?: number) {
  if (!ed || !isTauri()) return
  try {
    const arrayBuffer = await file.arrayBuffer()
    const uint8 = new Uint8Array(arrayBuffer)
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ fileName: string; filePath: string }>('save_editor_image', {
      taskId,
      fileName: file.name,
      data: Array.from(uint8),
    })
    if (!result || typeof result.filePath !== 'string' || typeof result.fileName !== 'string') {
      console.error('Invalid response from save_editor_image:', result)
      return
    }
    insertImageWithAttrs(ed, result.filePath, result.fileName, insertionPosition)
  } catch (err) {
    console.error('Failed to save editor image:', err)
  }
}

function getClipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return []

  const files = Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'))
  if (files.length > 0) return files

  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item, index) => {
      const file = item.getAsFile()
      if (!file) return null
      if (file.name) return file
      const extension = item.type.split('/')[1] || 'png'
      return new File([file], `clipboard-image-${index + 1}.${extension}`, { type: item.type })
    })
    .filter((file): file is File => Boolean(file))
}

interface RichEditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: string
  autoFocus?: boolean
  onKeyDown?: (e: KeyboardEvent) => void
  variant?: 'full' | 'minimal'
  onNavigateUp?: () => void
  taskId?: string
  taskMentionTasks?: Task[]
  onTaskMentionIdsChange?: (taskIds: string[]) => void
}

const ChronicleLink = Link.extend({
  inclusive: false,
  addAttributes() {
    return {
      ...this.parent?.(),
      taskId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-task-id'),
        renderHTML: (attributes) => attributes.taskId ? { 'data-task-id': attributes.taskId } : {},
      },
    }
  },
})

type MentionState = {
  query: string
  from: number
  to: number
  anchorTop: number
  top: number
  left: number
} | null

export function extractTaskMentionIdsFromHtml(html: string): string[] {
  const ids = new Set<string>()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('[data-task-id]').forEach((element) => {
    const taskId = element.getAttribute('data-task-id')
    if (taskId) ids.add(taskId)
  })
  return [...ids]
}

const ToolbarButton = ({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
}) => (
  <button
    type="button"
    className={cn(
      'p-1.5 rounded hover:bg-muted transition',
      active && 'bg-muted text-primary'
    )}
    onClick={onClick}
    title={title}
  >
    {children}
  </button>
)

// Custom Image extension with data-fullpath and data-filename support, extending ImageResize for resize capability
export const ChronicleImage = ImageResize.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fullpath: {
        default: null,
        parseHTML: element => element.getAttribute('data-fullpath'),
        renderHTML: attributes => {
          if (!attributes.fullpath) return {}
          return { 'data-fullpath': attributes.fullpath }
        },
      },
      filename: {
        default: null,
        parseHTML: element => element.getAttribute('data-filename'),
        renderHTML: attributes => {
          if (!attributes.filename) return {}
          return { 'data-filename': attributes.filename }
        },
      },
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    // For serialization: convert asset:// src back to empty src + data-fullpath
    // This ensures the DB stores file paths, not ephemeral asset:// URLs
    const attrs = { ...HTMLAttributes }
    const fp = (node.attrs as Record<string, unknown>).fullpath as string | null
    if (attrs.src && attrs.src.startsWith('asset://')) {
      if (fp) {
        attrs.src = ''
        attrs['data-fullpath'] = fp
      }
    }
    return ['img', attrs]
  },
  addNodeView() {
    return ((props: NodeViewRendererProps) => {
      const fp = (props.node.attrs as Record<string, unknown>).fullpath as string | null
      let resolvedNode = props.node
      if (fp && isTauri() && !props.node.attrs.src) {
        const assetUrl = (window as any).__TAURI__.core.convertFileSrc(fp)
        resolvedNode = props.editor.view.state.schema.nodes.imageResize.create({
          ...props.node.attrs,
          src: assetUrl,
        })
      }
      const parentResult = this.parent?.()
      if (parentResult) return parentResult({ ...props, node: resolvedNode })
      return null
    }) as unknown as NodeViewRenderer
  },
})

/** Resolve data-fullpath to Tauri asset URL for images already in the DOM (fallback for re-renders) */
export function resolveImageSrcsInEditor() {
  if (!isTauri()) return
  try {
    const tauriCore = (window as any).__TAURI__.core
    document.querySelectorAll<HTMLImageElement>('img[data-fullpath]').forEach(img => {
      const fullpath = img.getAttribute('data-fullpath')
      if (fullpath) {
        const assetUrl = tauriCore.convertFileSrc(fullpath)
        if (img.src !== assetUrl) {
          img.src = assetUrl
        }
      }
    })
  } catch { /* ignore */ }
}

function RichEditorInner({
  content,
  onChange,
  placeholder,
  minHeight = '200px',
  autoFocus = false,
  onKeyDown,
  variant = 'full',
  onNavigateUp,
  taskId,
  taskMentionTasks = [],
  onTaskMentionIdsChange,
}: RichEditorProps) {
  const { t } = useI18n()
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const taskMentionTasksRef = useRef(taskMentionTasks)
  taskMentionTasksRef.current = taskMentionTasks
  const onTaskMentionIdsChangeRef = useRef(onTaskMentionIdsChange)
  onTaskMentionIdsChangeRef.current = onTaskMentionIdsChange
  const filteredMentionTasksRef = useRef<Task[]>([])
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const mentionPopupRef = useRef<HTMLDivElement | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [mentionState, setMentionState] = useState<MentionState>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)

  const canSaveImage = isTauri() && !!taskId

  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: false,
    }),
    WrappedCodeBlock,
    ChronicleImage.configure({
      inline: false,
    }),
    ChronicleLink.configure({
      openOnClick: false,
      protocols: ['file'],
    }),
    Placeholder.configure({
      placeholder: placeholder ?? t('editor.placeholder'),
    }),
  ], []) // stable across re-renders

  const editor = useEditor({
    extensions,
    content,
    onUpdate: ({ editor }) => {
      contentRef.current = editor.getHTML()
      onChangeRef.current(editor.getHTML())
      onTaskMentionIdsChangeRef.current?.(extractTaskMentionIdsFromHtml(editor.getHTML()))
      updateMentionState(editor)
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[200px] p-4',
      },
      handleDOMEvents: {
          dragstart: (_view, event) => {
            if (event.target instanceof HTMLImageElement) {
              event.preventDefault()
              return true
            }
            return false
          },
          dragover: (_view, event) => {
            if (event.dataTransfer?.types.includes('Files')) {
              event.preventDefault()
              return true
            }
            return false
          },
          drop: (_view, event) => {
            const files = event.dataTransfer?.files
            if (!files?.length) return false

            // Prevent browser navigation for all file drops
            event.preventDefault()

            // Handle each file
            for (const file of Array.from(files)) {
              if (file.type.startsWith('image/')) {
                // Image: save to filesystem via Tauri (only in Tauri env)
                if (canSaveImage) {
                  const ed = editorRef.current
                  if (ed) uploadAndInsertImage(ed, taskId!, file, ed.state.selection.from)
                }
                // Non-Tauri: silently ignore image drops
              } else if (taskId) {
                // Non-image: save as attachment
                const ts = Date.now()
                const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
                const fileName = `${ts}_${safeName}`
                const reader = new FileReader()
                reader.onload = async (e) => {
                  const arrayBuffer = e.target?.result as ArrayBuffer
                  const uint8 = new Uint8Array(arrayBuffer)
                  try {
                    const { invoke } = await import('@tauri-apps/api/core')
                    const filePath = await invoke<string>('copy_attachment_file', {
                      taskId,
                      fileName,
                      data: Array.from(uint8),
                    })
                    if (typeof filePath !== 'string' || !filePath) {
                      console.error('Invalid response from copy_attachment_file:', filePath)
                      return
                    }
                    const ed2 = editorRef.current
                    if (ed2) {
                      const { tr } = ed2.state
                      const linkMark = ed2.schema.marks.link.create({
                        href: `file://${filePath}?chronicle_attachment=1`,
                      })
                      const textNode = ed2.schema.text(`📎 ${file.name}`, [linkMark])
                      tr.insert(tr.selection.from, textNode)
                      ed2.view.dispatch(tr)
                      ed2.commands.focus()
                    }
                  } catch (err) {
                    console.error('Failed to copy attachment:', err)
                  }
                }
                reader.readAsArrayBuffer(file)
              }
            }

            return true
          },
        },
      handleKeyDown: (view, event) => {
        if (mentionState) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSelectedMentionIndex((index) => Math.min(index + 1, filteredMentionTasksRef.current.length - 1))
            return true
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSelectedMentionIndex((index) => Math.max(index - 1, 0))
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const task = filteredMentionTasksRef.current[selectedMentionIndex]
            if (task) {
              event.preventDefault()
              insertTaskMention(task)
              return true
            }
          }
          if (event.key === 'Escape') {
            setMentionState(null)
            return true
          }
        }
        if (event.key === 'ArrowUp' && onNavigateUp) {
          const { state } = view
          const { selection } = state
          const isAtStart = selection.$anchor.pos === 1 && selection.$head.pos === 1
          if (isAtStart) {
            onNavigateUp()
            return true
          }
        }
        if (event.key === 'ArrowLeft' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          const { state } = view
          const { selection } = state
          const isAtStart = selection.$anchor.pos === 1 && selection.$head.pos === 1
          if (isAtStart) {
            editor.commands.blur()
            return true
          }
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const ed = editorRef.current
          if (ed) {
            if (event.shiftKey) {
              ed.chain().focus().liftListItem('listItem').run()
            } else {
              ed.chain().focus().sinkListItem('listItem').run()
            }
          }
          return true
        }
        return false
      },
      handlePaste: (_view, event) => {
        if (canSaveImage) {
          const imageFiles = getClipboardImageFiles(event.clipboardData)
          if (imageFiles.length > 0) {
            event.preventDefault()
            const ed = editorRef.current
            const insertionPosition = ed?.state.selection.from
            if (ed) {
              for (const file of imageFiles) {
                uploadAndInsertImage(ed, taskId!, file, insertionPosition)
              }
            }
            return true
          }
        }
        // Not an image paste — let ProseMirror handle text/HTML paste normally
        return false
      },
    },
  })

  // Keep editorRef in sync for use inside async closures (e.g. attachment drop handler)
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  // Resolve data-fullpath → src for images in Tauri environment on initial load
  useEffect(() => {
    if (!editor) return
    // Use setTimeout to wait for TipTap to finish rendering
    const timer = setTimeout(resolveImageSrcsInEditor, 50)
    return () => clearTimeout(timer)
  }, [editor, content])

  const containerRef = useRef<HTMLDivElement>(null)

  const filteredMentionTasks = useMemo(() => {
    const query = mentionState?.query.trim().toLowerCase() ?? ''
    const pool = taskMentionTasks.filter((task) => task.status === 'PENDING' || task.status === 'DOING')
    if (!query) return pool.slice(0, 8)
    return pool.filter((task) =>
      task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)
    ).slice(0, 8)
  }, [mentionState?.query, taskMentionTasks])
  filteredMentionTasksRef.current = filteredMentionTasks

  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [mentionState?.query])

  useEffect(() => {
    if (!mentionState) return
    const handlePointerDown = (event: PointerEvent) => {
      const popup = mentionPopupRef.current
      if (!popup) return
      const rect = popup.getBoundingClientRect()
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) return

      const buttons = Array.from(popup.querySelectorAll<HTMLButtonElement>('button'))
      const index = buttons.findIndex((button) => {
        const buttonRect = button.getBoundingClientRect()
        return (
          event.clientX >= buttonRect.left &&
          event.clientX <= buttonRect.right &&
          event.clientY >= buttonRect.top &&
          event.clientY <= buttonRect.bottom
        )
      })
      const task = filteredMentionTasksRef.current[index]
      if (!task) return
      event.preventDefault()
      event.stopPropagation()
      insertTaskMention(task)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [mentionState])

  function updateMentionState(ed: Editor) {
    if (taskMentionTasksRef.current.length === 0) {
      setMentionState(null)
      return
    }
    const { state, view } = ed
    const { from } = state.selection
    const textBefore = state.doc.textBetween(Math.max(0, from - 80), from, '\n', '\n')
    const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/)
    if (!match) {
      setMentionState(null)
      return
    }
    const query = match[1] ?? ''
    const mentionFrom = from - query.length - 1
    const coords = view.coordsAtPos(from)
    setMentionState({
      query,
      from: mentionFrom,
      to: from,
      anchorTop: coords.top,
      top: coords.bottom + 6,
      left: coords.left,
    })
  }

  function insertTaskMention(task: Task) {
    if (!editor || !mentionState) return
    editor.chain().focus().insertContentAt(
      { from: mentionState.from, to: mentionState.to },
      {
        type: 'text',
        text: `@${task.title}`,
        marks: [{
          type: 'link',
          attrs: {
            href: `/?task=${encodeURIComponent(task.id)}`,
            taskId: task.id,
          },
        }],
      }
    ).insertContent(' ').run()
    setMentionState(null)
  }

  // Sync external content changes back to editor (e.g. clearing after submit)
  useEffect(() => {
    if (!editor) return
    if (content !== contentRef.current) {
      editor.commands.setContent(content, { emitUpdate: false })
      contentRef.current = content
    }
  }, [content, editor])

  useEffect(() => {
    if (editor && autoFocus) {
      editor.commands.focus()
    }
  }, [editor, autoFocus])

  // Keyboard shortcuts at DOM level
  useEffect(() => {
    if (!onKeyDown) return

    const handler = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return

      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        onKeyDown(e)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        editor.commands.blur()
        onKeyDown(e)
      } else if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onKeyDown(e)
      }
    }

    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onKeyDown, editor])

  // DOM-level drag handlers for visual feedback when files are dragged over
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        setIsDragOver(true)
      }
    }
    const handleDragLeave = (e: DragEvent) => {
      const rect = container.getBoundingClientRect()
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        setIsDragOver(false)
      }
    }
    const handleDrop = () => {
      setIsDragOver(false)
    }
    const handleDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        setIsDragOver(true)
      }
    }

    // Use capture phase to intercept before ProseMirror
    container.addEventListener('dragenter', handleDragEnter, true)
    container.addEventListener('dragover', handleDragOver, true)
    container.addEventListener('dragleave', handleDragLeave, true)
    container.addEventListener('drop', handleDrop, true)
    return () => {
      container.removeEventListener('dragenter', handleDragEnter, true)
      container.removeEventListener('dragover', handleDragOver, true)
      container.removeEventListener('dragleave', handleDragLeave, true)
      container.removeEventListener('drop', handleDrop, true)
    }
  }, [])

  // Cleanup FileReader refs on unmount
  useEffect(() => {
    return () => {
      const readers = (window as unknown as { __richEditorReaders?: FileReader[] }).__richEditorReaders
      if (readers) {
        readers.forEach(r => {
          try { r.abort() } catch { /* ignore */ }
        })
        ;(window as unknown as { __richEditorReaders?: FileReader[] }).__richEditorReaders = []
      }
    }
  }, [])

  if (!editor) return null

  const mentionPopup = mentionState && filteredMentionTasks.length > 0
    ? (() => {
      const popupHeight = 288
      const popupWidth = 320
      const containerRect = containerRef.current?.getBoundingClientRect()
      const containerWidth = containerRef.current?.clientWidth ?? popupWidth
      const bottomRelativeToContainer = mentionState.top - (containerRect?.top ?? 0)
      const anchorTopRelativeToContainer = mentionState.anchorTop - (containerRect?.top ?? 0)
      const top = mentionState.top + popupHeight > window.innerHeight
        ? Math.max(8, anchorTopRelativeToContainer - popupHeight - 10)
        : bottomRelativeToContainer
      const left = Math.min(
        Math.max(8, mentionState.left - (containerRect?.left ?? 0) - 20),
        Math.max(8, containerWidth - popupWidth - 8)
      )

      return (
        <div
          ref={mentionPopupRef}
          className="absolute max-h-72 w-80 overflow-auto rounded-md border border-border bg-popover p-1 shadow-xl"
          style={{ top, left, zIndex: 2147483647, pointerEvents: 'auto' }}
        >
          {filteredMentionTasks.map((task, index) => (
            <button
              key={task.id}
              type="button"
              className={cn('flex w-full items-start justify-between rounded px-3 py-2 text-left text-sm', index === selectedMentionIndex ? 'bg-primary/10 text-foreground' : 'hover:bg-muted')}
              onMouseDown={(event) => {
                event.preventDefault()
                insertTaskMention(task)
              }}
              onClick={(event) => {
                event.preventDefault()
                insertTaskMention(task)
              }}
            >
              <span className="min-w-0 truncate pr-3">{task.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{task.status}</span>
            </button>
          ))}
        </div>
      )
    })()
    : null

  return (
    <>
    <div
      ref={containerRef}
      data-rich-editor="true"
      className={cn(
        'relative isolate border rounded-lg overflow-visible transition-colors',
        variant === 'minimal' && 'border-none rounded-none',
        isDragOver && 'border-primary bg-primary/5'
      )}
    >
        {variant === 'full' && (
          <div className="flex items-center gap-0.5 p-2 border-b bg-muted/30 flex-wrap">
            <ToolbarButton
              active={editor.isActive('bold')}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title={t('editor.bold')}
            >
              <Bold className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('italic')}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title={t('editor.italic')}
            >
              <Italic className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('strike')}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              title={t('editor.strikethrough')}
            >
              <Strikethrough className="w-4 h-4" />
            </ToolbarButton>
            <div className="w-px h-5 bg-border mx-1" />
            <ToolbarButton
              active={editor.isActive('heading', { level: 1 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              title={t('editor.heading1')}
            >
              <Heading1 className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('heading', { level: 2 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              title={t('editor.heading2')}
            >
              <Heading2 className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('heading', { level: 3 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              title={t('editor.heading3')}
            >
              <Heading3 className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('heading', { level: 4 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
              title={t('editor.heading4')}
            >
              <Heading4 className="w-4 h-4" />
            </ToolbarButton>
            <div className="w-px h-5 bg-border mx-1" />
            <ToolbarButton
              active={editor.isActive('bulletList')}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              title={t('editor.bulletList')}
            >
              <List className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('orderedList')}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              title={t('editor.orderedList')}
            >
              <ListOrdered className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().sinkListItem('listItem').run()}
              title={t('editor.indent')}
            >
              <Indent className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().liftListItem('listItem').run()}
              title={t('editor.outdent')}
            >
              <Outdent className="w-4 h-4" />
            </ToolbarButton>
            <div className="w-px h-5 bg-border mx-1" />
            <ToolbarButton
              active={editor.isActive('blockquote')}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              title={t('editor.blockquote')}
            >
              <Quote className="w-4 h-4" />
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('codeBlock')}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              title={t('editor.codeBlock')}
            >
              <Code className="w-4 h-4" />
            </ToolbarButton>
            <div className="w-px h-5 bg-border mx-1" />
            <ToolbarButton
              active={editor.isActive('link')}
              onClick={() => {
                const url = prompt(t('editor.linkPrompt'))
                if (url && !url.startsWith('javascript:') && !url.startsWith('vbscript:')) {
                  editor.chain().focus().setLink({ href: url }).run()
                }
              }}
              title={t('editor.link')}
            >
              <Link2 className="w-4 h-4" />
            </ToolbarButton>
            {canSaveImage && (
              <ToolbarButton
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/*'
                  input.onchange = () => {
                    const file = input.files?.[0]
                    if (file) {
                      const ed = editorRef.current
                      if (ed) uploadAndInsertImage(ed, taskId!, file, ed.state.selection.from)
                    }
                  }
                  input.click()
                }}
                title={t('editor.image')}
              >
                <ImageIcon className="w-4 h-4" />
              </ToolbarButton>
            )}
          </div>
        )}
        <EditorContent editor={editor} className="relative z-0 min-h-[200px]" />
        {mentionPopup}
        <style>{`
          .ProseMirror {
            min-height: ${minHeight};
            padding: 1rem;
            outline: none;
          }
          .ProseMirror p.is-editor-empty:first-child::before {
            content: attr(data-placeholder);
            color: hsl(var(--muted-foreground));
            pointer-events: none;
            float: left;
            height: 0;
          }
          .ProseMirror h1 { font-size: 1.5rem; font-weight: 700; margin: 0.5rem 0; }
          .ProseMirror h2 { font-size: 1.25rem; font-weight: 700; margin: 0.5rem 0; }
          .ProseMirror h3 { font-size: 1.125rem; font-weight: 600; margin: 0.5rem 0; }
          .ProseMirror h4 { font-size: 1rem; font-weight: 600; margin: 0.5rem 0; }
          .ProseMirror ul { list-style-type: disc; padding-left: 1.5rem; }
          .ProseMirror ol { list-style-type: decimal; padding-left: 1.5rem; }
          .ProseMirror li { margin: 0.25rem 0; }
          .ProseMirror blockquote {
            border-left: 3px solid hsl(var(--border));
            padding-left: 1rem;
            margin: 0.5rem 0;
            color: hsl(var(--muted-foreground));
          }
          .ProseMirror img {
            max-width: 100%;
            height: auto;
            border-radius: 0.5rem;
            margin: 0.5rem 0;
            cursor: pointer;
            -webkit-user-drag: none !important;
            -khtml-user-drag: none !important;
            -moz-user-drag: none !important;
            -o-user-drag: none !important;
            user-drag: none !important;
            user-select: none;
            pointer-events: auto;
          }
          .ProseMirror img[draggable="true"] {
            -webkit-user-drag: none !important;
          }
          .ProseMirror .resize-image-wrapper img {
            max-width: none;
            margin: 0;
          }
          .ProseMirror .resize-image-wrapper {
            display: inline-block;
            position: relative;
            vertical-align: top;
          }
          .ProseMirror pre {
            background: hsl(var(--muted));
            border-radius: 0.5rem;
            padding: 0.75rem;
            overflow-x: auto;
            font-size: 0.875rem;
          }
          .ProseMirror pre code {
            display: block;
            background: transparent;
            padding: 0;
            border-radius: 0;
            font-size: inherit;
            white-space: pre;
          }
          .ProseMirror code {
            background: hsl(var(--muted));
            padding: 0.125rem 0.375rem;
            border-radius: 0.25rem;
            font-size: 0.875em;
          }
          .ProseMirror a {
            color: hsl(var(--primary));
            text-decoration: underline;
          }
          .ProseMirror a.chronicle-attachment {
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
            padding: 0.125rem 0.5rem;
            background: hsl(var(--muted));
            border: 1px solid hsl(var(--border));
            border-radius: 0.25rem;
            font-size: 0.8125rem;
            text-decoration: none;
            color: hsl(var(--foreground));
            cursor: pointer;
          }
        `}</style>
      </div>
    </>
  )
}

export function RichEditor(props: RichEditorProps) {
  return <RichEditorInner {...props} />
}
