import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import ImageResize from 'tiptap-extension-resize-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Italic, List, ListOrdered, Code, Link2, Image as ImageIcon, Strikethrough, Heading1, Heading2, Quote } from 'lucide-react'
import { useEffect, useRef, useMemo, useState } from 'react'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'

/** Detect Tauri environment */
function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI__
}

/** Insert image with a default width */
function insertImageWithAttrs(ed: Editor, filePath: string, filename?: string) {
  const src = isTauri()
    ? (window as any).__TAURI__.core.convertFileSrc(filePath)
    : `file://${filePath}`
  const { tr } = ed.state
  const imageNode = ed.schema.nodes.imageResize.create({
    src,
    width: 500,
    containerStyle: `width: 500px; height: auto; cursor: pointer;`,
    fullpath: filePath,
    filename,
  })
  tr.insert(tr.selection.from, imageNode)
  ed.view.dispatch(tr)
  ed.commands.focus()
}

/** Upload image via Tauri invoke and insert into editor */
async function uploadAndInsertImage(ed: Editor | null, taskId: string, file: File) {
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
    insertImageWithAttrs(ed, result.filePath, result.fileName)
  } catch (err) {
    console.error('Failed to save editor image:', err)
  }
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

// Custom Image extension with data-fullpath and data-filename support, extending ImageResize for resize capability
const ChronicleImage = ImageResize.extend({
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
    return ({ node, editor, getPos }) => {
      const fp = (node.attrs as Record<string, unknown>).fullpath as string | null
      let resolvedNode = node
      if (fp && isTauri() && !node.attrs.src) {
        const assetUrl = (window as any).__TAURI__.core.convertFileSrc(fp)
        resolvedNode = editor.view.state.schema.nodes.imageResize.create({
          ...node.attrs,
          src: assetUrl,
        })
      }
      return this.parent?.()({ node: resolvedNode, editor, getPos })
    }
  },
})

/** Resolve data-fullpath to Tauri asset URL for images already in the DOM (fallback for re-renders) */
function resolveImageSrcsInEditor() {
  if (!isTauri()) return
  try {
    const tauriCore = (window as any).__TAURI__.core
    document.querySelectorAll('img[data-fullpath]').forEach(img => {
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
}: RichEditorProps) {
  const { t } = useI18n()
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const canSaveImage = isTauri() && !!taskId

  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: { levels: [1, 2] },
    }),
    ChronicleImage.configure({
      allowBase64: true,
      inline: false,
      HTMLAttributes: {
        class: 'rounded-md max-w-full',
        draggable: 'false',
      },
    }),
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
                // Image: save to filesystem via Tauri (only in Tauri env)
                if (canSaveImage) {
                  const ed = editorRef.current
                  if (ed) uploadAndInsertImage(ed, taskId!, file)
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
        // Check for image paste using types/files (doesn't consume clipboard data)
        if (canSaveImage) {
          const types = event.clipboardData?.types || []
          const hasImageFile = types.includes('Files') && (event.clipboardData?.files?.length ?? 0) > 0
          if (hasImageFile) {
            event.preventDefault()
            const file = event.clipboardData!.files[0]
            if (file?.type.startsWith('image/')) {
              const ed = editorRef.current
              if (ed) uploadAndInsertImage(ed, taskId!, file)
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
                    if (ed) uploadAndInsertImage(ed, taskId!, file)
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
        .ProseMirror > div > div[style*="border: 1px dashed"] {
          border-radius: 0.375rem;
        }
      `}</style>
    </div>
  )
}

// Let RichEditor re-render when content prop changes (e.g. cleared after submit)
export const RichEditor = RichEditorInner
