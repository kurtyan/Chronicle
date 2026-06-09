import { EditorContent, useEditor } from '@tiptap/react'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DayScriptDocument, Task } from '@/types'
import { findActiveBlock, parseDayScriptDocument } from '@/lib/dayScript'

interface DayScriptEditorProps {
  value: DayScriptDocument['document']
  tasks: Task[]
  scriptDate: string
  onChange: (document: Record<string, any>) => void
  onSave: () => void
  onNavigateTask: (taskId: string) => void
  onEditingTask?: (taskId: string) => void
}

const TaskLink = Link.extend({
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
  anchorBottom: number
  left: number
} | null

function isTodayDate(date: string): boolean {
  const now = new Date()
  return date === [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

export function DayScriptEditor({ value, tasks, scriptDate, onChange, onSave, onNavigateTask, onEditingTask }: DayScriptEditorProps) {
  const [mentionState, setMentionState] = useState<MentionState>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const suppressEditingNotificationRef = useRef(false)
  const currentValueRef = useRef(JSON.stringify(value ?? { type: 'doc', content: [{ type: 'paragraph' }] }))

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      TaskLink.configure({
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: '09:30-09:50 @Task title ✅',
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: 'day-script-editor min-h-[360px] text-[15px] leading-7 outline-none',
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null
        const link = target?.closest('a[data-task-id]') as HTMLAnchorElement | null
        if (!link) return false
        const taskId = link.getAttribute('data-task-id')
        if (taskId) {
          event.preventDefault()
          onNavigateTask(taskId)
          return true
        }
        return false
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          onSave()
          return true
        }
        if (mentionState) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSelectedMentionIndex((index) => Math.min(index + 1, filteredTasks.length - 1))
            return true
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSelectedMentionIndex((index) => Math.max(index - 1, 0))
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const task = filteredTasks[selectedMentionIndex]
            if (task) {
              event.preventDefault()
              insertMention(task.id, task.title)
              return true
            }
          }
          if (event.key === 'Escape') {
            setMentionState(null)
            return true
          }
        }
        return false
      },
    },
    onUpdate: ({ editor: nextEditor }) => {
      const json = nextEditor.getJSON()
      currentValueRef.current = JSON.stringify(json)
      onChange(json)
      updateMentionState(nextEditor)
      if (!suppressEditingNotificationRef.current) notifyEditingTask(nextEditor)
      applyBlockClasses(nextEditor)
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      updateMentionState(nextEditor)
      applyBlockClasses(nextEditor)
    },
  })

  useEffect(() => {
    const nextSerialized = JSON.stringify(value ?? { type: 'doc', content: [{ type: 'paragraph' }] })
    if (!editor || nextSerialized === currentValueRef.current) return
    suppressEditingNotificationRef.current = true
    try {
      editor.commands.setContent(value)
      currentValueRef.current = nextSerialized
      applyBlockClasses(editor)
    } finally {
      suppressEditingNotificationRef.current = false
    }
  }, [editor, value, scriptDate])

  useEffect(() => {
    if (!editor) return
    applyBlockClasses(editor)
  }, [editor, scriptDate])

  const filteredTasks = useMemo(() => {
    const query = mentionState?.query.trim().toLowerCase() ?? ''
    const pool = tasks.filter((task) => task.status === 'PENDING' || task.status === 'DOING')
    if (!query) return pool.slice(0, 8)
    return pool.filter((task) =>
      task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)
    ).slice(0, 8)
  }, [mentionState?.query, tasks])

  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [mentionState?.query])

  function updateMentionState(nextEditor: NonNullable<typeof editor>) {
    const { state, view } = nextEditor
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
    const containerRect = containerRef.current?.getBoundingClientRect()
    setMentionState({
      query,
      from: mentionFrom,
      to: from,
      anchorTop: coords.top - (containerRect?.top ?? 0),
      anchorBottom: coords.bottom - (containerRect?.top ?? 0),
      left: coords.left - (containerRect?.left ?? 0),
    })
  }

  function insertMention(taskId: string, title: string) {
    if (!editor || !mentionState) return
    editor.chain().focus().insertContentAt(
      { from: mentionState.from, to: mentionState.to },
      {
        type: 'text',
        text: `@${title}`,
        marks: [
          {
            type: 'link',
            attrs: {
              href: `/today?task=${encodeURIComponent(taskId)}`,
              taskId,
            },
          },
        ],
      }
    ).insertContent(' ').run()
    setMentionState(null)
  }

  function notifyEditingTask(nextEditor: NonNullable<typeof editor>) {
    if (!onEditingTask) return
    const lineIndex = nextEditor.state.selection.$anchor.index(0)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const activeLineBlock = blocks.find((block) => lineIndex >= block.lineStart && lineIndex <= block.lineEnd)
    if (!activeLineBlock || lineIndex <= activeLineBlock.lineStart) return
    const taskId = activeLineBlock?.taskIds[0]
    if (taskId) onEditingTask(taskId)
  }

  function applyBlockClasses(nextEditor: NonNullable<typeof editor>) {
    const root = containerRef.current?.querySelector('.ProseMirror')
    if (!root) return
    const children = Array.from(root.children)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const currentIndex = isTodayDate(scriptDate) ? findActiveBlock(blocks, new Date()) : -1

    children.forEach((child) => {
      child.classList.remove('day-script-line-active', 'day-script-line-complete')
    })

    blocks.forEach((block, index) => {
      for (let line = block.lineStart; line <= block.lineEnd; line++) {
        const element = children[line]
        if (!element) continue
        if (block.completed) element.classList.add('day-script-line-complete')
        if (index === currentIndex) element.classList.add('day-script-line-active')
      }
    })
  }

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
        <div className="day-script-scroll min-h-0 flex-1 overflow-y-auto">
          <EditorContent editor={editor} className="h-full min-h-0" />
        </div>
      </div>

      {mentionState && filteredTasks.length > 0 && (
        (() => {
          const popupHeight = 288
          const popupWidth = 320
          const containerHeight = containerRef.current?.clientHeight ?? 0
          const containerWidth = containerRef.current?.clientWidth ?? 0
          const top = containerHeight > 0 && mentionState.anchorBottom + popupHeight > containerHeight
            ? Math.max(8, mentionState.anchorTop - popupHeight - 10)
            : mentionState.anchorBottom + 6
          const left = Math.min(
            Math.max(0, mentionState.left - 20),
            Math.max(0, containerWidth - popupWidth - 8)
          )

          return (
            <div
              className="absolute z-30 max-h-72 w-80 overflow-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
              style={{ top, left }}
            >
          {filteredTasks.map((task, index) => (
            <button
              key={task.id}
              className={`flex w-full items-start justify-between rounded-lg px-3 py-2 text-left ${index === selectedMentionIndex ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'}`}
              onMouseDown={(event) => {
                event.preventDefault()
                insertMention(task.id, task.title)
              }}
            >
              <span className="pr-3">{task.title}</span>
              <span className="text-xs text-muted-foreground">{task.status}</span>
            </button>
          ))}
            </div>
          )
        })()
      )}

      <style>{`
        .day-script-editor {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }
        .day-script-scroll {
          height: 100%;
          min-height: 0;
          scrollbar-gutter: stable;
          scrollbar-width: auto;
          scrollbar-color: hsl(var(--border)) transparent;
        }
        .day-script-scroll::-webkit-scrollbar {
          width: 12px;
        }
        .day-script-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .day-script-scroll::-webkit-scrollbar-thumb {
          background: hsl(var(--border));
          border-radius: 999px;
          border: 3px solid transparent;
          background-clip: content-box;
        }
        .day-script-scroll::-webkit-scrollbar-thumb:hover {
          background: hsl(var(--muted-foreground));
          border-radius: 999px;
          border: 3px solid transparent;
          background-clip: content-box;
        }
        .day-script-scroll > .tiptap {
          display: flex;
          flex-direction: column;
          min-height: 0;
          height: 100%;
          width: 100%;
        }
        .day-script-editor .tiptap.ProseMirror {
          min-height: 100%;
          overflow: visible;
          padding: 1.5rem 1.25rem 4rem;
          font-size: 1.05rem;
          line-height: 1.9;
          outline: none;
        }
        .day-script-editor .ProseMirror p {
          margin: 0;
          padding: 0.18rem 0.55rem;
          border-radius: 0.8rem;
          transition: background-color 120ms ease, color 120ms ease;
          white-space: pre-wrap;
        }
        .day-script-editor .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          float: left;
          height: 0;
        }
        .day-script-editor .ProseMirror a[data-task-id] {
          color: hsl(var(--primary));
          text-decoration: underline;
          text-underline-offset: 3px;
          cursor: pointer;
        }
        .day-script-editor .ProseMirror .day-script-line-active {
          background: color-mix(in srgb, hsl(var(--primary)) 10%, transparent);
        }
        .day-script-editor .ProseMirror .day-script-line-complete {
          color: hsl(var(--muted-foreground));
          background: color-mix(in srgb, hsl(var(--muted)) 70%, transparent);
        }
      `}</style>
    </div>
  )
}
