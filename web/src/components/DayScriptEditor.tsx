import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DayScriptDocument, DayScriptSubmitAnchor, Task } from '@/types'
import { buildDayScriptActivityKey, findActiveBlock, isNewTaskHeaderText, parseDayScriptDocument } from '@/lib/dayScript'
import { ChronicleImage, isTauri, resolveImageSrcsInEditor, uploadAndInsertImage } from '@/components/RichEditor'
import { WrappedCodeBlock } from '@/components/RichEditor/WrappedCodeBlock'

interface DayScriptEditorProps {
  value: DayScriptDocument['document']
  blocks: DayScriptDocument['blocks']
  tasks: Task[]
  scriptDate: string
  todayScriptDate: string
  onChange: (document: Record<string, any>) => void
  onSave: () => void
  onSubmitProgress?: (getCurrentDocument?: () => Record<string, any>, submitAnchor?: DayScriptSubmitAnchor) => void
  onNavigateTask: (taskId: string) => void
  onEditingTask?: (activity: { taskId: string; blockKey: string }) => void
  onContentError?: (message: string, error?: unknown) => void
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

const DayScriptParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      source: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-day-script-source'),
        renderHTML: (attributes) => attributes.source ? { 'data-day-script-source': attributes.source } : {},
      },
      blockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-day-script-block-id'),
        renderHTML: (attributes) => attributes.blockId ? { 'data-day-script-block-id': attributes.blockId } : {},
      },
      originScriptDate: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-day-script-origin-date'),
        renderHTML: (attributes) => attributes.originScriptDate ? { 'data-day-script-origin-date': attributes.originScriptDate } : {},
      },
      originBlockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-day-script-origin-block-id'),
        renderHTML: (attributes) => attributes.originBlockId ? { 'data-day-script-origin-block-id': attributes.originBlockId } : {},
      },
      originSource: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-day-script-origin-source'),
        renderHTML: (attributes) => attributes.originSource ? { 'data-day-script-origin-source': attributes.originSource } : {},
      },
    }
  },
})

const NewTaskBadge = Node.create({
  name: 'newTaskBadge',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      label: {
        default: 'new',
        parseHTML: (element) => element.getAttribute('data-label') || 'new',
        renderHTML: (attributes) => ({ 'data-label': attributes.label || 'new' }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-day-script-new-task]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-day-script-new-task': 'true',
        contenteditable: 'false',
        class: 'day-script-new-task-badge',
      }),
      'new',
    ]
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

function sanitizeEditorNode(node: any): any | null {
  if (!node || typeof node !== 'object') return node
  if (node.type === 'text' && !node.text) return null
  const content = Array.isArray(node.content)
    ? node.content.map(sanitizeEditorNode).filter(Boolean)
    : undefined
  return {
    ...node,
    ...(content ? { content } : {}),
  }
}

function sanitizeEditorDocument(document: Record<string, any> | null | undefined): Record<string, any> {
  const sanitized = sanitizeEditorNode(document)
  if (!sanitized || sanitized.type !== 'doc') return { type: 'doc', content: [{ type: 'paragraph' }] }
  const content = Array.isArray(sanitized.content) ? sanitized.content : []
  return { ...sanitized, content: content.length > 0 ? content : [{ type: 'paragraph' }] }
}

const LINE_NODE_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock', 'horizontalRule', 'image', 'imageResize'])
const LINE_ELEMENT_SELECTOR = 'p, h1, h2, h3, h4, blockquote, li, pre, hr, img'
const TIME_VALUE_PATTERN = '(?:\\d{1,2}:\\d{2}|\\d{3,4})'
const TIME_HEADER_RE = new RegExp(`^${TIME_VALUE_PATTERN}\\s*-\\s*${TIME_VALUE_PATTERN}(?:\\s+|$)`)
const TIME_HEADER_WITH_BODY_RE = new RegExp(`^${TIME_VALUE_PATTERN}\\s*-\\s*${TIME_VALUE_PATTERN}(?:\\s+|$)(.*)$`)

function focusHeaderTextFromLine(text: string): string {
  const visible = text.replace(/\u00a0/g, ' ').trimEnd()
  return (visible.match(TIME_HEADER_WITH_BODY_RE)?.[1] ?? visible).trim()
}

function normalizedFocusHeaderText(text: string): string {
  return focusHeaderTextFromLine(text).replace(/\s+/g, ' ').trim()
}

function hasTaskLinkNode(node: ProseMirrorNode): boolean {
  let found = false
  node.descendants((child) => {
    if (found || !child.isText) return !found
    found = child.marks.some((mark) => mark.type.name === 'link' && typeof mark.attrs.taskId === 'string' && mark.attrs.taskId)
    return !found
  })
  return found
}

const FocusLineDecorations = Extension.create({
  name: 'focusLineDecorations',
  addStorage() {
    return {
      savedNewTaskHeaders: [] as string[],
    }
  },
  addProseMirrorPlugins() {
    const extension = this
    return [
      new Plugin({
        key: new PluginKey('focusLineDecorations'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            const savedNewTaskHeaders = new Set(extension.storage.savedNewTaskHeaders as string[])
            state.doc.descendants((node, pos) => {
              if (!LINE_NODE_TYPES.has(node.type.name)) return true
              const text = node.textBetween(0, node.content.size, '\n', '\n').replace(/\u00a0/g, ' ').trimEnd()
              const isSavedNewTaskLine = savedNewTaskHeaders.has(normalizedFocusHeaderText(text))
              if (!TIME_HEADER_RE.test(text) && !hasTaskLinkNode(node) && !isSavedNewTaskLine) return true
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

function moveSelectionToTextblockBoundary(editor: Editor, edge: 'start' | 'end'): boolean {
  const { state, view } = editor
  const { $anchor } = state.selection
  if (!$anchor.parent.isTextblock) return false

  const pos = edge === 'start' ? $anchor.start() : $anchor.end()
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView())
  return true
}

function splitAfterLink(editor: Editor): boolean {
  const { state, view } = editor
  const { selection, schema } = state
  const linkType = schema.marks.link
  if (!linkType || !selection.empty) return false

  const { $from } = selection
  if (!$from.parent.isTextblock) return false
  const nodeBefore = $from.nodeBefore
  const nodeAfter = $from.nodeAfter
  const hasLinkBefore = !!nodeBefore?.marks.some((mark) => mark.type === linkType)
  const continuesLinkAfter = !!nodeAfter?.marks.some((mark) => mark.type === linkType)
  if (!hasLinkBefore || continuesLinkAfter) return false

  const tr = state.tr.split(selection.from).removeStoredMark(linkType).scrollIntoView()
  view.dispatch(tr)
  return true
}

function findTaskMentionRangeInCurrentLine(editor: Editor): { from: number; to: number } | null {
  const { state } = editor
  const { $anchor } = state.selection
  if (!$anchor.parent.isTextblock) return null

  let range: { from: number; to: number } | null = null
  state.doc.nodesBetween($anchor.start(), $anchor.end(), (node, pos) => {
    if (range || !node.isText) return true
    const hasTaskLink = node.marks.some((mark) => mark.type.name === 'link' && typeof mark.attrs.taskId === 'string' && mark.attrs.taskId)
    if (!hasTaskLink) return true
    range = { from: pos, to: pos + node.nodeSize }
    return false
  })
  return range
}

function getMentionStateFromSelection(editor: Editor): MentionState {
  const { state, view } = editor
  const { from } = state.selection
  const textBefore = state.doc.textBetween(Math.max(0, from - 80), from, '\n', '\n')
  const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return null
  const query = match[1] ?? ''
  const coords = view.coordsAtPos(from)
  return {
    query,
    from: from - query.length - 1,
    to: from,
    anchorTop: coords.top,
    anchorBottom: coords.bottom,
    left: coords.left,
  }
}

export function DayScriptEditor({ value, blocks: savedBlocks, tasks, scriptDate, todayScriptDate, onChange, onSave, onSubmitProgress, onNavigateTask, onEditingTask, onContentError }: DayScriptEditorProps) {
  const safeValue = useMemo(() => sanitizeEditorDocument(value), [value])
  const savedNewTaskHeaders = useMemo(() => new Set(
    savedBlocks
      .filter((block) => (block.taskIds?.length ?? 0) === 0 && isNewTaskHeaderText(block.headerText))
      .map((block) => block.headerText.replace(/\s+/g, ' ').trim())
  ), [savedBlocks])
  const savedNewTaskHeaderKey = useMemo(() => [...savedNewTaskHeaders].sort().join('\n'), [savedNewTaskHeaders])
  const [mentionState, setMentionState] = useState<MentionState>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const mentionPopupRef = useRef<HTMLDivElement | null>(null)
  const mentionStateRef = useRef<MentionState>(null)
  const filteredTasksRef = useRef<Task[]>([])
  const tasksRef = useRef<Task[]>(tasks)
  const selectedMentionIndexRef = useRef(0)
  const suppressEditingNotificationRef = useRef(false)
  const suppressCursorNavigationRef = useRef(false)
  const lastCursorTaskIdRef = useRef<string | null>(null)
  const currentValueRef = useRef(JSON.stringify(safeValue))

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        horizontalRule: {},
        paragraph: false,
        codeBlock: false,
      }),
      DayScriptParagraph,
      WrappedCodeBlock,
      NewTaskBadge,
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
    content: safeValue,
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
      handleTextInput: (view, from, to, text) => {
        if (text !== '-') return false
        const { state } = view
        const { $from } = state.selection
        if (!$from.parent.isTextblock) return false
        const textBefore = state.doc.textBetween($from.start(), from, '\n', '\n')
        if (textBefore !== '--') return false
        view.dispatch(state.tr.insertText(text, from, to))
        return true
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          onSave()
          return true
        }
        if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Enter') {
          event.preventDefault()
          const activeEditor = editorRef.current
          onSubmitProgress?.(
            () => activeEditor?.getJSON() ?? { type: 'doc', content: [{ type: 'paragraph' }] },
            activeEditor ? getSubmitAnchor(activeEditor) : undefined
          )
          return true
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault()
          return moveSelectionToTextblockBoundary(editorRef.current!, event.key === 'Home' ? 'start' : 'end')
        }
        if (mentionStateRef.current) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSelectedMentionIndex((index) => Math.min(index + 1, filteredTasksRef.current.length - 1))
            return true
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSelectedMentionIndex((index) => Math.max(index - 1, 0))
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const task = getMentionTasks()[selectedMentionIndexRef.current]
            if (task) {
              event.preventDefault()
              insertMention(task.id, task.title, mentionStateRef.current)
              return true
            }
          }
          if (event.key === 'Escape') {
            setMentionState(null)
            return true
          }
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === 'Enter') {
          if (splitAfterLink(editorRef.current!)) {
            event.preventDefault()
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
              uploadAndInsertImage(activeEditor, getUploadTaskId(activeEditor), file, activeEditor?.state.selection.from)
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
        const activeEditor = editorRef.current
        uploadAndInsertImage(activeEditor, getUploadTaskId(activeEditor), file, activeEditor?.state.selection.from)
        return true
      },
    },
    onCreate: ({ editor: nextEditor }) => {
      editorRef.current = nextEditor
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
      if (!suppressCursorNavigationRef.current) notifyCursorTask(nextEditor)
      applyBlockClasses(nextEditor)
    },
  })
  editorRef.current = editor

  useEffect(() => {
    const nextSerialized = JSON.stringify(safeValue)
    if (!editor || nextSerialized === currentValueRef.current) return
    suppressEditingNotificationRef.current = true
    suppressCursorNavigationRef.current = true
    try {
      editor.commands.setContent(safeValue)
      currentValueRef.current = nextSerialized
      scheduleApplyBlockClasses(editor)
    } catch (error) {
      onContentError?.('Focus editor failed to load the supplied document.', error)
      console.error('Failed to load Day Script editor content:', error)
    } finally {
      suppressEditingNotificationRef.current = false
      window.setTimeout(() => {
        suppressCursorNavigationRef.current = false
      }, 0)
    }
  }, [editor, safeValue, scriptDate])

  useEffect(() => {
    const activeEditor = editorRef.current
    if (!activeEditor) return
    scheduleApplyBlockClasses(activeEditor)
  }, [editor, scriptDate, todayScriptDate])

  useLayoutEffect(() => {
    const activeEditor = editorRef.current
    if (!activeEditor) return
    ;(activeEditor.storage as any).focusLineDecorations.savedNewTaskHeaders = [...savedNewTaskHeaders]
    activeEditor.view.dispatch(activeEditor.state.tr.setMeta('focusLineDecorations', savedNewTaskHeaderKey))
  }, [editor, savedNewTaskHeaderKey])

  useEffect(() => {
    if (!editor) return
    const timer = window.setTimeout(resolveImageSrcsInEditor, 50)
    return () => window.clearTimeout(timer)
  }, [editor, value])

  useEffect(() => {
    const handleMentionKeyDown = (event: KeyboardEvent) => {
      if (!mentionStateRef.current) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedMentionIndex((index) => Math.min(index + 1, filteredTasksRef.current.length - 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedMentionIndex((index) => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const task = getMentionTasks()[selectedMentionIndexRef.current]
        if (!task) return
        event.preventDefault()
        event.stopPropagation()
        insertMention(task.id, task.title, mentionStateRef.current)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        mentionStateRef.current = null
        setMentionState(null)
      }
    }

    document.addEventListener('keydown', handleMentionKeyDown, true)
    return () => document.removeEventListener('keydown', handleMentionKeyDown, true)
  }, [])

  const filteredTasks = useMemo(() => {
    const query = mentionState?.query.trim().toLowerCase() ?? ''
    const pool = tasks.filter((task) => task.status === 'PENDING' || task.status === 'DOING')
    if (!query) return pool.slice(0, 8)
    return pool.filter((task) =>
      task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)
    ).slice(0, 8)
  }, [mentionState?.query, tasks])
  tasksRef.current = tasks
  filteredTasksRef.current = filteredTasks
  selectedMentionIndexRef.current = selectedMentionIndex

  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [mentionState?.query])

  useEffect(() => {
    const item = mentionPopupRef.current?.querySelector(`[data-mention-index="${selectedMentionIndex}"]`) as HTMLElement | null
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedMentionIndex, filteredTasks.length, mentionState?.query])

  function updateMentionState(nextEditor: NonNullable<typeof editor>) {
    const { state, view } = nextEditor
    const { from } = state.selection
    const textBefore = state.doc.textBetween(Math.max(0, from - 80), from, '\n', '\n')
    const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/)
    if (!match) {
      mentionStateRef.current = null
      setMentionState(null)
      return
    }
    const query = match[1] ?? ''
    const mentionFrom = from - query.length - 1
    const coords = view.coordsAtPos(from)
    const nextMentionState = {
      query,
      from: mentionFrom,
      to: from,
      anchorTop: coords.top,
      anchorBottom: coords.bottom,
      left: coords.left,
    }
    mentionStateRef.current = nextMentionState
    setMentionState(nextMentionState)
  }

  function insertMention(taskId: string, title: string, activeMention?: NonNullable<MentionState> | null) {
    const activeEditor = editorRef.current
    const activeMentionState = activeMention ?? mentionStateRef.current ?? (activeEditor ? getMentionStateFromSelection(activeEditor) : null)
    if (!activeEditor || !activeMentionState) return
    const taskMention = activeEditor.schema.text(`@${title}`, [
      activeEditor.schema.marks.link.create({
        href: `/today?task=${encodeURIComponent(taskId)}`,
        taskId,
      }),
    ])
    const existingRange = findTaskMentionRangeInCurrentLine(activeEditor)
    if (existingRange && (existingRange.from !== activeMentionState.from || existingRange.to !== activeMentionState.to)) {
      let tr = activeEditor.state.tr.replaceWith(existingRange.from, existingRange.to, taskMention)
      const mappedMentionFrom = tr.mapping.map(activeMentionState.from)
      const mappedMentionTo = tr.mapping.map(activeMentionState.to)
      if (mappedMentionFrom < mappedMentionTo) tr = tr.delete(mappedMentionFrom, mappedMentionTo)
      tr = tr.insertText(' ', tr.selection.from)
      activeEditor.view.dispatch(tr.scrollIntoView())
      activeEditor.commands.focus()
    } else {
      activeEditor.chain().focus().insertContentAt(
        { from: activeMentionState.from, to: activeMentionState.to },
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
    }
    mentionStateRef.current = null
    setMentionState(null)
    onNavigateTask(taskId)
  }

  function getMentionTasks(): Task[] {
    const query = mentionStateRef.current?.query.trim().toLowerCase() ?? ''
    const pool = tasksRef.current.filter((task) => task.status === 'PENDING' || task.status === 'DOING')
    if (!query) return pool.slice(0, 8)
    return pool.filter((task) =>
      task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)
    ).slice(0, 8)
  }

  function getUploadTaskId(nextEditor: Editor | null): string {
    if (!nextEditor) return 'day-script'
    const lineIndex = getSelectionLineIndex(nextEditor)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const activeLineBlock = blocks.find((block) => lineIndex >= block.lineStart && lineIndex <= block.lineEnd)
    return activeLineBlock?.taskIds[0] ?? 'day-script'
  }

  function getSubmitAnchor(nextEditor: NonNullable<typeof editor>): DayScriptSubmitAnchor | undefined {
    const lineIndex = getSelectionLineIndex(nextEditor)
    const blocks = parseDayScriptDocument(nextEditor.getJSON())
    const activeLineBlock = blocks.find((block) => lineIndex >= block.lineStart && lineIndex <= block.lineEnd)
    if (!activeLineBlock) return undefined
    return {
      sortOrder: activeLineBlock.sortOrder,
      startTime: activeLineBlock.startTime,
      endTime: activeLineBlock.endTime,
      headerText: activeLineBlock.headerText,
    }
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
    const currentIndex = scriptDate === todayScriptDate ? findActiveBlock(blocks, new Date()) : -1
    lineElements.forEach((child) => {
      child.classList.remove('day-script-line-header', 'day-script-line-active', 'day-script-line-complete')
      const lineHeaderText = focusHeaderTextFromLine(child.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (
        TIME_HEADER_RE.test((child.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd())
        || Boolean(child.querySelector('a[data-task-id]'))
        || savedNewTaskHeaders.has(lineHeaderText)
      ) {
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

    root.querySelectorAll('pre').forEach((pre) => {
      pre.classList.toggle('day-script-code-block-scroll', pre.scrollHeight > pre.clientHeight + 1)
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
            ref={mentionPopupRef}
            className="fixed max-h-72 w-80 overflow-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
            style={{ top, left, zIndex: 2147483647 }}
          >
            {filteredTasks.map((task, index) => {
              const activeMentionState = mentionState
              return (
              <button
                key={task.id}
                data-mention-index={index}
                className={`flex w-full items-start justify-between rounded-lg px-3 py-2 text-left ${index === selectedMentionIndex ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  insertMention(task.id, task.title, activeMentionState)
                }}
              >
                <span className="pr-3">{task.title}</span>
                <span className="text-xs text-muted-foreground">{task.status}</span>
              </button>
              )
            })}
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
          min-height: 0;
          min-height: 100%;
          width: 100%;
        }
        .day-script-editor.tiptap.ProseMirror {
          display: block;
          height: auto;
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
          min-height: calc((0.9rem * 1.5) + 1.3rem);
          overflow-x: auto;
          padding: 0.65rem 1rem;
          display: block;
        }
        .day-script-editor.ProseMirror pre.day-script-code-block-scroll {
          overflow-x: auto;
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
        .day-script-editor.ProseMirror p.is-empty::before {
          content: "\\200B";
          color: transparent;
          pointer-events: none;
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
        .day-script-editor.ProseMirror .day-script-new-task-badge {
          display: inline-flex;
          align-items: center;
          margin-right: 0.35rem;
          border: 1px solid hsl(var(--primary) / 0.35);
          background: hsl(var(--primary) / 0.12);
          color: hsl(var(--primary));
          border-radius: 0.25rem;
          padding: 0 0.35rem;
          font-size: 0.72em;
          font-weight: 700;
          line-height: 1.45;
          user-select: none;
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
