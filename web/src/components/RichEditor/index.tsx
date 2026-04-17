import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import ImageResize from 'tiptap-extension-resize-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Italic, List, ListOrdered, Code, Link2, Image as ImageIcon, Strikethrough, Heading1, Heading2, Quote } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'

interface RichEditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: string
  autoFocus?: boolean
  onKeyDown?: (e: KeyboardEvent) => void
  variant?: 'full' | 'minimal'
  onNavigateUp?: () => void  // Called when cursor at start and ArrowUp pressed
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

export function RichEditor({
  content,
  onChange,
  placeholder,
  minHeight = '200px',
  autoFocus = false,
  onKeyDown,
  variant = 'full',
  onNavigateUp,
}: RichEditorProps) {
  const { t } = useI18n()
  const contentRef = useRef(content)
  const containerRef = useRef<HTMLDivElement>(null)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
      }),
      Image.configure({
        allowBase64: true,
        HTMLAttributes: {
          class: 'rounded-md max-w-full',
          draggable: 'false',
        },
      }),
      ImageResize,
      Link.configure({
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? t('editor.placeholder'),
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      contentRef.current = editor.getHTML()
      onChange(editor.getHTML())
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[200px] p-4',
      },
      handleDOMEvents: {
        dragstart: (_view, event) => {
          event.preventDefault()
          return true
        },
        drop: (_view, event) => {
          // Only prevent if it's an image being dropped outside the editor
          if (event.dataTransfer?.files.length || event.dataTransfer?.getData('text/html').includes('<img')) {
            event.preventDefault()
          }
          return false
        },
      },
      handleKeyDown: (view, event) => {
        // Handle ArrowUp at document start - navigate to title
        if (event.key === 'ArrowUp' && onNavigateUp) {
          const { state } = view
          const { selection } = state
          // Check if cursor is at the very beginning of the document
          const isAtStart = selection.$anchor.pos === 1 && selection.$head.pos === 1
          if (isAtStart) {
            onNavigateUp()
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
              // Store reader for cleanup
              const readers = (window as unknown as { __richEditorReaders?: FileReader[] }).__richEditorReaders || []
              readers.push(reader)
              ;(window as unknown as { __richEditorReaders: FileReader[] }).__richEditorReaders = readers

              reader.onload = (e) => {
                const src = e.target?.result as string
                editor?.chain().focus().setImage({ src }).run()
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

  // Controlled mode: sync external content changes
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

  // Handle keyboard shortcuts at DOM level - use document level for reliability
  useEffect(() => {
    if (!onKeyDown) return

    const handler = (e: KeyboardEvent) => {
      // Only handle if focus is within this editor
      if (!containerRef.current?.contains(document.activeElement)) return

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        editor.commands.blur()
        // Propagate to parent so it can handle ESC (e.g., cancel draft)
        if (onKeyDown) onKeyDown(e)
      } else if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onKeyDown(e)
      }
    }

    // Use capture phase on document to catch before anything else
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onKeyDown])

  // Prevent drag on images to avoid browser opening them in new tab
  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const preventDrag = (e: DragEvent) => {
      if (e.target instanceof HTMLImageElement) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    container.addEventListener('dragstart', preventDrag, true)
    return () => {
      container.removeEventListener('dragstart', preventDrag, true)
      // Abort any pending FileReaders
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
    <div ref={containerRef} data-rich-editor="true" className={cn('border rounded-lg overflow-hidden', variant === 'minimal' && 'border-none rounded-none')}>
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
                    editor.chain().focus().setImage({ src: e.target?.result as string }).run()
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
          color: #adb5bd;
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
