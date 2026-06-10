import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DayScriptDocument, Task } from '@/types'
import { buildDayScriptActivityKey, findActiveBlock, parseDayScriptDocument } from '@/lib/dayScript'
import { ChronicleImage, isTauri, resolveImageSrcsInEditor, uploadAndInsertImage } from '@/components/RichEditor'
import { WrappedCodeBlock } from '@/components/RichEditor/WrappedCodeBlock'

interface DayScriptEditorProps {
  value: DayScriptDocument['document']
  tasks: Task[]
  scriptDate: string
  onChange: (document: Record<string, any>) => void
  onSave: () => void
  onNavigateTask: (taskId: string) => void
  onEditingTask?: (activity: { taskId: string; blockKey: string }) => void
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

type LineMapping = {
  from: number
  to: number
  topIndex: number
}

const LINE_NODE_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock', 'horizontalRule', 'image', 'imageResize'])
const LINE_ELEMENT_SELECTOR = 'p, h1, h2, h3, h4, blockquote, li, pre, hr, img'
const TIME_VALUE_PATTERN = '(?:\\d{1,2}:\\d{2}|\\d{3,4})'
const TIME_HEADER_RE = new RegExp(`^${TIME_VALUE_PATTERN}\\s*-\\s*${TIME_VALUE_PATTERN}(?:\\s+|$)`)

const FocusLineDecorations = Extension.create({
  name: 'focusLineDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('focusLineDecorations'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!LINE_NODE_TYPES.has(node.type.name)) return true
              const text = node.textBetween(0, node.content.size, '\n', '\n').replace(/\u00a0/g, ' ').trimEnd()
              if (!TIME_HEADER_RE.test(text)) return true
              const classes = ['day-script-line-header']
              if (text.includes('✅')) classes.push('day-script-line-complete')
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: classes.join(' ') }))
              return false
            })
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})

function isTodayDate(date: string): boolean {
  const now = new Date()
  return date === [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

function isLineNode(node: ProseMirrorNode): boolean {
  return LINE_NODE_TYPES.has(node.type.name)
}

function isLineElement(element: Element): boolean {
  return element.matches(LINE_ELEMENT_SELECTOR)
}

function collectLineElements(root: Element): Element[] {
  const elements: Element[] = []

  const visit = (element: Element) => {
    if (isLineElement(element)) {
      elements.push(element)
      return
    }
    for (const child of Array.from(element.children)) visit(child)
  }

  for (const child of Array.from(root.children)) visit(child)
  return elements
}

function collectLineMappings(doc: ProseMirrorNode): LineMapping[] {
  const mappings: LineMapping[] = []

  let topIndex = 0
  doc.forEach((topNode, topOffset) => {
    const topFrom = topOffset + 1
    if (isLineNode(topNode)) {
      mappings.push({ from: topFrom, to: topFrom + topNode.nodeSize, topIndex })
      topIndex += 1
      return
    }

    topNode.descendants((node, pos) => {
      if (!isLineNode(node)) return true
      const from = topFrom + pos
      mappings.push({ from, to: from + node.nodeSize, topIndex })
      return false
    })
    topIndex += 1
  })

  return mappings
}

function getSelectionLineIndex(editor: Editor): number {
  const mappings = collectLineMappings(editor.state.doc)
  if (mappings.length === 0) return 0

  const selectionPos = editor.state.selection.$anchor.pos
  const containingIndex = mappings.findIndex((mapping) => selectionPos >= mapping.from && selectionPos <= mapping.to)
  if (containingIndex >= 0) return containingIndex

  for (let index = mappings.length - 1; index >= 0; index -= 1) {
    if (selectionPos >= mappings[index].from) return index
  }
  return 0
}

export function DayScriptEditor({ value, tasks, scriptDate, onChange, onSave, onNavigateTask, onEditingTask }: DayScriptEditorProps) {
  const [mentionState, setMentionState] = useState<MentionState>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const suppressEditingNotificationRef = useRef(false)
  const lastCursorTaskIdRef = useRef<string | null>(null)
  const currentValueRef = useRef(JSON.stringify(value ?? { type: 'doc', content: [{ type: 'paragraph' }] }))
  const pendingClipboardImageFallbackRef = useRef<number | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        horizontalRule: {},
        codeBlock: false,
      }),
      WrappedCodeBlock,
      ChronicleImage.configure({
        inline: false,
      }),
      FocusLineDecorations,
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
        if (isTauri() && event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v') {
          scheduleClipboardImageFallback()
          return false
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
          if (!files?.length || !isTauri()) return false
          event.preventDefault()
          const activeEditor = editorRef.current
          for (const file of Array.from(files)) {
            if (file.type.startsWith('image/')) {
              uploadAndInsertImage(activeEditor, getUploadTaskId(activeEditor), file)
            }
          }
          return true
        },
      },
      handlePaste: (_view, event) => {
        if (!isTauri()) return false
        const types = event.clipboardData?.types || []
        const hasImageFile = types.includes('Files') && (event.clipboardData?.files?.length ?? 0) > 0
        if (!hasImageFile) return false
        const file = event.clipboardData!.files[0]
        if (!file?.type.startsWith('image/')) return false
        event.preventDefault()
        cancelClipboardImageFallback()
        const activeEditor = editorRef.current
        uploadAndInsertImage(activeEditor, getUploadTaskId(activeEditor), file)
        return true
      },
    },
    onCreate: ({ editor: nextEditor }) => {
      scheduleApplyBlockClasses(nextEditor)
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
      notifyCursorTask(nextEditor)
      applyBlockClasses(nextEditor)
    },
  })
  editorRef.current = editor

  useEffect(() => {
    const nextSerialized = JSON.stringify(value ?? { type: 'doc', content: [{ type: 'paragraph' }] })
    if (!editor || nextSerialized === currentValueRef.current) return
    suppressEditingNotificationRef.current = true
    try {
      editor.commands.setContent(value)
      currentValueRef.current = nextSerialized
      scheduleApplyBlockClasses(editor)
    } finally {
      suppressEditingNotificationRef.current = false
    }
  }, [editor, value, scriptDate])

  useEffect(() => {
    if (!editor) return
    scheduleApplyBlockClasses(editor)
  }, [editor, scriptDate])

  useEffect(() => {
    if (!editor) return
    const timer = window.setTimeout(resolveImageSrcsInEditor, 50)
    return () => window.clearTimeout(timer)
  }, [editor, value])

  useEffect(() => {
    return () => cancelClipboardImageFallback()
  }, [])

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
    setMentionState({
      query,
      from: mentionFrom,
      to: from,
      anchorTop: coords.top,
      anchorBottom: coords.bottom,
      left: coords.left,
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
    onNavigateTask(taskId)
  }

  async function pasteClipboardImage(nextEditor: Editor | null) {
    if (!nextEditor || !navigator.clipboard?.read) return
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (!imageType) continue
        const blob = await item.getType(imageType)
        const extension = imageType.split('/')[1] || 'png'
        const file = new File([blob], `clipboard-image.${extension}`, { type: imageType })
        uploadAndInsertImage(nextEditor, getUploadTaskId(nextEditor), file)
        return
      }
    } catch {
      // Native paste may still handle clipboard content; ignore permission/read failures.
    }
  }

  function cancelClipboardImageFallback() {
    if (pendingClipboardImageFallbackRef.current === null) return
    window.clearTimeout(pendingClipboardImageFallbackRef.current)
    pendingClipboardImageFallbackRef.current = null
  }

  function scheduleClipboardImageFallback() {
    cancelClipboardImageFallback()
    pendingClipboardImageFallbackRef.current = window.setTimeout(() => {
      pendingClipboardImageFallbackRef.current = null
      pasteClipboardImage(editorRef.current)
    }, 80)
  }

  function getUploadTaskId(nextEditor: Editor | null): string {
    if (!nextEditor) return 'day-script'
    const lineIndex = getSelectionLineIndex(nextEditor)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const activeLineBlock = blocks.find((block) => lineIndex >= block.lineStart && lineIndex <= block.lineEnd)
    return activeLineBlock?.taskIds[0] ?? 'day-script'
  }

  function notifyEditingTask(nextEditor: NonNullable<typeof editor>) {
    if (!onEditingTask) return
    const lineIndex = getSelectionLineIndex(nextEditor)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const activeLineBlock = blocks.find((block) => lineIndex >= block.lineStart && lineIndex <= block.lineEnd)
    if (!activeLineBlock || lineIndex <= activeLineBlock.lineStart) return
    const taskId = activeLineBlock?.taskIds[0]
    if (taskId) onEditingTask({ taskId, blockKey: buildDayScriptActivityKey(activeLineBlock, taskId) })
  }

  function notifyCursorTask(nextEditor: NonNullable<typeof editor>) {
    const lineIndex = getSelectionLineIndex(nextEditor)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const activeLineBlock = blocks.find((block) => lineIndex >= block.lineStart && lineIndex <= block.lineEnd)
    const taskId = activeLineBlock?.taskIds[0] ?? null
    if (!taskId || lastCursorTaskIdRef.current === taskId) return
    lastCursorTaskIdRef.current = taskId
    onNavigateTask(taskId)
  }

  function applyBlockClasses(nextEditor: NonNullable<typeof editor>) {
    const root = containerRef.current?.querySelector('.ProseMirror')
    if (!root) return
    const lineElements = collectLineElements(root)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const currentIndex = isTodayDate(scriptDate) ? findActiveBlock(blocks, new Date()) : -1

    lineElements.forEach((child) => {
      child.classList.remove('day-script-line-header', 'day-script-line-active', 'day-script-line-complete')
      if (TIME_HEADER_RE.test((child.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd())) {
        child.classList.add('day-script-line-header')
      }
    })

    blocks.forEach((block, index) => {
      for (let line = block.lineStart; line <= block.lineEnd; line++) {
        const element = lineElements[line]
        if (!element) continue
        if (line !== block.lineStart) continue
        element.classList.add('day-script-line-header')
        if (block.completed) element.classList.add('day-script-line-complete')
        if (index === currentIndex) element.classList.add('day-script-line-active')
      }
    })
  }

  function scheduleApplyBlockClasses(nextEditor: NonNullable<typeof editor>) {
    applyBlockClasses(nextEditor)
    window.requestAnimationFrame(() => applyBlockClasses(nextEditor))
    window.setTimeout(() => applyBlockClasses(nextEditor), 50)
  }

  const mentionPopup = mentionState && filteredTasks.length > 0 && typeof document !== 'undefined'
    ? createPortal(
      (() => {
        const popupHeight = 288
        const popupWidth = 320
        const top = mentionState.anchorBottom + popupHeight > window.innerHeight
          ? Math.max(8, mentionState.anchorTop - popupHeight - 10)
          : mentionState.anchorBottom + 6
        const left = Math.min(
          Math.max(8, mentionState.left - 20),
          Math.max(8, window.innerWidth - popupWidth - 8)
        )

        return (
          <div
            className="fixed max-h-72 w-80 overflow-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
            style={{ top, left, zIndex: 2147483647 }}
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
      })(),
      document.body
    )
    : null

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
        <div className="day-script-scroll min-h-0 flex-1 overflow-y-auto">
          <EditorContent editor={editor} className="h-full min-h-0" />
        </div>
      </div>

      {mentionPopup}

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
        .day-script-editor.tiptap.ProseMirror {
          min-height: 100%;
          overflow: visible;
          padding: 1.5rem 1.25rem 4rem;
          font-size: 1.05rem;
          line-height: 1.9;
          outline: none;
        }
        .day-script-editor.ProseMirror p {
          margin: 0;
          padding: 0.18rem 0.55rem;
          border-radius: 0.8rem;
          transition: background-color 120ms ease, color 120ms ease;
          white-space: pre-wrap;
        }
        .day-script-editor.ProseMirror ul {
          list-style-type: disc;
          padding-left: 1.75rem;
          margin: 0.25rem 0;
        }
        .day-script-editor.ProseMirror ol {
          list-style-type: decimal;
          padding-left: 1.75rem;
          margin: 0.25rem 0;
        }
        .day-script-editor.ProseMirror li {
          padding-left: 0.15rem;
        }
        .day-script-editor.ProseMirror blockquote {
          border-left: 3px solid hsl(var(--border));
          padding-left: 1rem;
          margin: 0.5rem 0;
          color: hsl(var(--muted-foreground));
        }
        .day-script-editor.ProseMirror hr {
          border: 0;
          border-top: 1px solid hsl(var(--border));
          margin: 1rem 0;
        }
        .day-script-editor.ProseMirror pre {
          background: hsl(var(--muted));
          border-radius: 0.5rem;
          margin: 0.5rem 0;
          overflow-x: auto;
          padding: 0.65rem 1rem;
          display: block;
        }
        .day-script-editor.ProseMirror pre code {
          display: block;
          background: transparent;
          padding: 0;
          border-radius: 0;
          font-size: 0.9rem;
          line-height: 1.5;
          white-space: pre;
        }
        .day-script-editor.ProseMirror code {
          background: hsl(var(--muted));
          border-radius: 0.25rem;
          padding: 0.125rem 0.35rem;
        }
        .day-script-editor.ProseMirror img {
          max-width: 100%;
          border-radius: 0.5rem;
          margin: 0.5rem 0;
          -webkit-user-drag: none !important;
          user-select: none;
        }
        .day-script-editor.ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          float: left;
          height: 0;
        }
        .day-script-editor.ProseMirror a[data-task-id] {
          color: hsl(var(--primary));
          text-decoration: underline;
          text-underline-offset: 3px;
          cursor: pointer;
        }
        .day-script-editor.ProseMirror .day-script-line-header {
          border-left: 3px solid hsl(var(--primary));
          border-radius: 0;
          background: color-mix(in srgb, hsl(var(--primary)) 8%, transparent);
          font-weight: 600;
        }
        .day-script-editor.ProseMirror .day-script-line-active {
          background: color-mix(in srgb, hsl(var(--primary)) 14%, transparent);
        }
        .day-script-editor.ProseMirror .day-script-line-complete {
          color: hsl(var(--muted-foreground));
          background: color-mix(in srgb, hsl(var(--muted)) 70%, transparent);
        }
        .day-script-editor.ProseMirror .day-script-line-complete.day-script-line-header {
          border-left-color: hsl(var(--muted-foreground));
          background: color-mix(in srgb, hsl(var(--muted)) 82%, transparent);
        }
      `}</style>
    </div>
  )
}
