import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TipTapImage from '@tiptap/extension-image'
import ImageResize from 'tiptap-extension-resize-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Italic, List, ListOrdered, Code, Link2, Image as ImageIcon, Strikethrough, Heading1, Heading2, Quote } from 'lucide-react'
import { useEffect, useRef, useMemo, useState } from 'react'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'

const IMAGE_MAX_SIZE = 80

/** Insert image with auto-resize: scale down so max(width,height) ≤ 80px */
function insertImageWithResize(ed: Editor | null, src: string) {
  if (!ed) return
  const img = new Image()
  img.onload = () => {
    let w = img.naturalWidth
    let h = img.naturalHeight
    if (w > IMAGE_MAX_SIZE || h > IMAGE_MAX_SIZE) {
      const scale = IMAGE_MAX_SIZE / Math.max(w, h)
      w = Math.round(w * scale)
      h = Math.round(h * scale)
    }
    ed.chain().focus().setImage({ src, width: w, height: h }).run()
  }
  img.onerror = () => {
    ed.chain().focus().setImage({ src }).run()
  }
  img.src = src
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
}: RichEditorProps) {
  const { t } = useI18n()
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: { levels: [1, 2] },
    }),
    TipTapImage.configure({
      allowBase64: true,
      HTMLAttributes: {
        class: 'rounded-md max-w-full',
        draggable: 'false',
      },
    }),
    ImageResize,
    Link.configure({
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
                // Image: insert into editor
                const reader = new FileReader()
                reader.onload = (e) => {
                  const ed = editorRef.current
                  if (ed) {
                    ed.chain().focus().setImage({ src: e.target?.result as string }).run()
                  }
                }
                reader.readAsDataURL(file)
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
        if (event.key === 'ArrowUp' && onNavigateUp) {
          const { state } = view
          const { selection } = state
          const isAtStart = selection.$anchor.pos === 1 && selection.$head.pos === 1
          if (isAtStart) {
            onNavigateUp()
            return true
          }
        }
        // Left arrow at start of document → blur editor
        if (event.key === 'ArrowLeft' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          const { state } = view
          const { selection } = state
          const isAtStart = selection.$anchor.pos === 1 && selection.$head.pos === 1
          if (isAtStart) {
            editor.commands.blur()
            return true
          }
        }
        return false
      },
      handlePaste: (_view, event) => {
        const items = Array.from(event.clipboardData?.items || [])
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault()
            const file = item.getAsFile()
            if (file) {
              const reader = new FileReader()
              const readers = (window as unknown as { __richEditorReaders?: FileReader[] }).__richEditorReaders || []
              readers.push(reader)
              ;(window as unknown as { __richEditorReaders: FileReader[] }).__richEditorReaders = readers

              reader.onload = (e) => {
                insertImageWithResize(editor, e.target?.result as string)
              }
              reader.onerror = () => {
                console.error('Failed to read pasted image')
              }
              reader.readAsDataURL(file)
            }
            return true
          }
        }
        return false
      },
    },
  })

  // Keep editorRef in sync for use inside async closures (e.g. attachment drop handler)
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  const containerRef = useRef<HTMLDivElement>(null)

  // Sync external content changes back to editor (e.g. clearing after submit)
  useEffect(() => {
    if (!editor) return
    if (content !== contentRef.current) {
      editor.commands.setContent(content)
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

      if (e.key === 'Escape') {
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

  return (
    <div ref={containerRef} data-rich-editor="true" className={cn('border rounded-lg overflow-hidden transition-colors', variant === 'minimal' && 'border-none rounded-none', isDragOver && 'border-primary bg-primary/5')}>
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
              if (url) editor.chain().focus().setLink({ href: url }).run()
            }}
            title={t('editor.link')}
          >
            <Link2 className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = 'image/*'
              input.onchange = () => {
                const file = input.files?.[0]
                if (file) {
                  const reader = new FileReader()
                  reader.onload = (e) => {
                    insertImageWithResize(editor, e.target?.result as string)
                  }
                  reader.readAsDataURL(file)
                }
              }
              input.click()
            }}
            title={t('editor.image')}
          >
            <ImageIcon className="w-4 h-4" />
          </ToolbarButton>
        </div>
      )}
      <EditorContent editor={editor} className="min-h-[200px]" />
      <style>{`
        .ProseMirror {
          min-height: ${minHeight};
          padding: 1rem;
          outline: none;
        }
        .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          height: 0;
        }
        .ProseMirror img {
          max-width: 100%;
          border-radius: 0.375rem;
          margin: 0.5rem 0;
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
        .ProseMirror blockquote {
          border-left: 3px solid hsl(var(--border));
          padding-left: 1rem;
          margin: 0.5rem 0;
          color: hsl(var(--muted-foreground));
        }
        .ProseMirror pre {
          background: hsl(var(--muted));
          padding: 0.75rem;
          border-radius: 0.375rem;
          overflow-x: auto;
          font-size: 0.875rem;
        }
        .ProseMirror code {
          background: hsl(var(--muted));
          padding: 0.125rem 0.375rem;
          border-radius: 0.25rem;
          font-size: 0.875rem;
        }
        .ProseMirror ul { list-style-type: disc; padding-left: 1.5rem; }
        .ProseMirror ol { list-style-type: decimal; padding-left: 1.5rem; }
        .ProseMirror h1 { font-size: 1.5rem; font-weight: 700; margin: 0.5rem 0; }
        .ProseMirror h2 { font-size: 1.25rem; font-weight: 600; margin: 0.5rem 0; }
        .ProseMirror .resize-image-wrapper {
          position: relative;
          display: inline-block;
          max-width: 100%;
        }
        .ProseMirror .resize-image-wrapper img {
          display: block;
          max-width: 100%;
        }
        .ProseMirror .resize-image-handle {
          position: absolute;
          width: 10px;
          height: 10px;
          background: hsl(var(--primary));
          border-radius: 50%;
          cursor: nwse-resize;
          bottom: -5px;
          right: -5px;
          z-index: 1;
        }
        .ProseMirror .resize-image-wrapper:hover .resize-image-handle {
          opacity: 1;
        }
      `}</style>
    </div>
  )
}

// Let RichEditor re-render when content prop changes (e.g. cleared after submit)
export const RichEditor = RichEditorInner
