import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Node, Extension, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Fragment, Slice } from '@tiptap/pm/model'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Task } from '@/types'
import type { OutlineDocument } from '@/services/workOutlineApi'
import { MENTION_LIMIT, normalizeOutlineDocument, normalizePastedOutline, indentOutlineRows, moveOutlineBranch, outlineId, outlineLabel, outlineLineText, outlineTaskId, parseOutlineText, parseOutlineHtml, rankOutlineTasks, splitOutlineLine, visibleOutlineRows } from '@/lib/workOutline'
import { useI18n } from '@/i18n/context'
import { translateCurrent } from '@/i18n/runtime'

const OutlineRoot = Node.create({ name: 'doc', topNode: true, content: 'outlineLine+' })
const OutlineLineNode = Node.create({
  name: 'outlineLine', group: 'block', content: '(text | taskRef)*', defining: true,
  addAttributes: () => ({ id: { default: null }, depth: { default: 0 } }),
  parseHTML: () => [{ tag: 'div[data-outline-row]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-outline-row': node.attrs.id, 'data-depth': node.attrs.depth, style: `--outline-depth:${node.attrs.depth};padding-left:${24 + node.attrs.depth * 22}px` }), 0],
})
const TaskReference = Node.create({
  name: 'taskRef', group: 'inline', inline: true, atom: true, selectable: false,
  addAttributes: () => ({ taskId: { default: '' }, label: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-outline-task]', getAttrs: el => ({ taskId: el.getAttribute('data-outline-task'), label: el.textContent?.replace(/^@/, '') || '' }) }],
  renderHTML: ({ node }) => ['span', { 'data-outline-task': node.attrs.taskId, contenteditable: 'false', class: 'outline-task-ref', role: 'button', tabindex: '-1' }, `@${node.attrs.label}`],
  renderText: ({ node }) => `@${node.attrs.label}`,
  addNodeView: () => ({ node, editor }) => {
    const dom = document.createElement('span')
    dom.className = 'outline-task-ref'
    dom.contentEditable = 'false'
    dom.setAttribute('role', 'button')
    const render = (current: typeof node) => {
      dom.dataset.outlineTask = current.attrs.taskId
      const projection = projectionKey.getState(editor.state) as Projection | undefined
      dom.textContent = `@${projection?.titles[current.attrs.taskId] || current.attrs.label}`
    }
    render(node)
    return { dom, update: current => { if (current.type.name !== 'taskRef') return false; render(current); return true } }
  },
})

const projectionKey = new PluginKey('outline-projection')
type Projection = { collapsed: Set<string>; statuses: Record<string, string>; titles: Record<string, string> }
const OutlineProjection = Extension.create({
  name: 'outlineProjection',
  addProseMirrorPlugins: () => [new Plugin<Projection>({
    key: projectionKey,
    filterTransaction: tr => {
      if (!tr.docChanged) return true
      let invalid = false
      tr.doc.forEach(row => {
        let count = 0
        row.forEach(child => { if (child.type.name === 'taskRef') count++ })
        if (count > 1) invalid = true
      })
      if (invalid) queueMicrotask(() => window.dispatchEvent(new Event('chronicle:outline-merge-rejected')))
      return !invalid
    },
    state: { init: () => ({ collapsed: new Set(), statuses: {}, titles: {} }), apply: (tr, value) => tr.getMeta(projectionKey) ?? value },
    props: { decorations: state => {
      const projection = projectionKey.getState(state)!
      const doc = normalizeOutlineDocument(state.doc.toJSON())
      const visible = new Map(visibleOutlineRows(doc, projection.collapsed, projection.statuses).map(row => [row.line.attrs.id, row]))
      const decorations: Decoration[] = []
      state.doc.forEach((node, pos) => {
        const row = visible.get(node.attrs.id)
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {
          class: row?.dimmed ? 'outline-row-done' : '',
          'data-placeholder': translateCurrent('outline.editor.placeholder'),
          ...(row ? {} : { style: 'display:none' }),
        }))
        node.forEach((child, offset) => {
          if (child.type.name !== 'taskRef') return
          const id = child.attrs.taskId
          decorations.push(Decoration.node(pos + 1 + offset, pos + 1 + offset + child.nodeSize, {
            title: projection.statuses[id] === 'MISSING' ? translateCurrent('outline.editor.missingTask') : projection.titles[id] || child.attrs.label,
            'data-task-status': projection.statuses[id] || '',
            class: projection.statuses[id] === 'MISSING' ? 'outline-task-missing' : '',
          }))
        })
      })
      return DecorationSet.create(state.doc, decorations)
    } },
    appendTransaction: (transactions, _oldState, state) => {
      if (!transactions.some(tr => tr.docChanged)) return null
      const normalized = normalizeOutlineDocument(state.doc.toJSON())
      const tr = state.tr
      let index = 0
      state.doc.forEach((node, pos) => {
        const attrs = normalized.content[index++]?.attrs
        if (attrs && (attrs.id !== node.attrs.id || attrs.depth !== node.attrs.depth)) tr.setNodeMarkup(pos, undefined, attrs)
      })
      return tr.steps.length ? tr : null
    },
  })],
})

export interface OutlineRowLayout { id: string; top: number; height: number }
export interface OutlineEditorHandle { focusRow: (id: string) => void; restoreFocus: (fallbackId: string) => void; move: (id: string, direction: 1 | -1) => void; unlink: (id: string) => void }
interface Props {
  value: OutlineDocument
  tasks: Task[]
  statuses: Record<string, string>
  collapsed: Set<string>
  onChange: (document: OutlineDocument) => void
  onSave: () => void
  onOpenTask: (id: string, rowId: string) => void
  onCreateTask: (rowId: string, title: string) => void
  onLayout: (rows: OutlineRowLayout[], height: number) => void
  onActiveRow: (id: string) => void
  handleRef: React.MutableRefObject<OutlineEditorHandle | null>
}
type Mention = { rowId: string; from: number; to: number; query: string; left: number; top: number }
const clipboardType = 'application/x-chronicle-outline'

export function OutlineEditor(props: Props) {
  const latest = useRef(props); latest.current = props
  const { t } = useI18n()
  const tRef = useRef(t); tRef.current = t
  const editorRef = useRef<Editor | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<Mention | null>(null)
  const mentionRef = useRef<Mention | null>(null)
  const mentionMenuRef = useRef<HTMLDivElement>(null)
  const mentionScrollContext = useRef('')
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  const [notice, setNotice] = useState('')
  const incoming = useRef('')
  const cutIds = useRef<Set<string>>(new Set())
  const savedSelection = useRef<{ anchorId: string; anchorOffset: number; headId: string; headOffset: number } | null>(null)
  // Ranked and capped at MENTION_LIMIT; `total` says how many matches the cap hid.
  const mentionRanking = (query: string) => rankOutlineTasks(latest.current.tasks, query, MENTION_LIMIT)
  const mentionTasks = (query: string) => mentionRanking(query).items
  function closeMention() { mentionRef.current = null; setMention(null) }
  function currentDocument() { return normalizeOutlineDocument(editorRef.current!.getJSON()) }
  function rowPosition(ed: Editor, id: string) {
    let position = -1
    ed.state.doc.forEach((node, pos) => { if (node.attrs.id === id) position = pos })
    return position
  }
  function replaceDocument(doc: OutlineDocument, selectedId?: string, offset = 0) {
    const ed = editorRef.current
    if (!ed) return
    const next = ed.schema.nodeFromJSON(doc)
    const tr = ed.state.tr.replaceWith(0, ed.state.doc.content.size, next.content)
    if (selectedId) {
      let position = -1
      tr.doc.forEach((node, pos) => { if (node.attrs.id === selectedId) position = pos + 1 + Math.min(offset, node.content.size) })
      if (position >= 0) tr.setSelection(TextSelection.create(tr.doc, position))
    }
    ed.view.dispatch(closeHistory(tr).scrollIntoView())
  }
  function selectionRowIds(ed: Editor) {
    const ids: string[] = []
    const { from, to } = ed.state.selection
    ed.state.doc.forEach((node, pos) => { if (pos < to && pos + node.nodeSize > from) ids.push(node.attrs.id) })
    return ids
  }
  function updateMention(ed: Editor) {
    const { $from, empty } = ed.state.selection
    const rowId = $from.parent.attrs.id
    if (rowId) latest.current.onActiveRow(rowId)
    if (!empty || $from.parent.type.name !== 'outlineLine') { closeMention(); return }
    const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
    const match = before.match(/(?:^|\s)@([^@\ufffc]*)$/)
    if (!match) { closeMention(); return }
    const coords = ed.view.coordsAtPos($from.pos)
    const value = { rowId, from: $from.pos - match[1].length - 1, to: $from.pos, query: match[1], left: coords.left, top: coords.bottom }
    if (mentionRef.current?.query !== value.query || mentionRef.current?.rowId !== value.rowId || mentionRef.current?.from !== value.from) { selectedRef.current = 0; setSelected(0) }
    mentionRef.current = value; setMention(value)
  }
  function chooseMention(task?: Task) {
    const active = mentionRef.current
    const ed = editorRef.current
    if (!active || !ed) return
    const row = currentDocument().content.find(line => line.attrs.id === active.rowId)
    if (!row) return
    if (!task) {
      if (outlineTaskId(row)) { setNotice(tRef.current('outline.editor.alreadyLinked')); closeMention(); return }
      ed.view.dispatch(ed.state.tr.delete(active.from, active.to))
      closeMention()
      latest.current.onCreateTask(active.rowId, active.query.trim() || outlineLineText(row).replace(/\s*@[^@]*$/, '').trim())
      return
    }
    let tr = ed.state.tr
    const pos = rowPosition(ed, active.rowId)
    const node = ed.state.doc.nodeAt(pos)
    const existing: Array<{ from: number; to: number }> = []
    node?.forEach((child, offset) => { if (child.type.name === 'taskRef') existing.push({ from: pos + 1 + offset, to: pos + 1 + offset + child.nodeSize }) })
    for (const range of existing.reverse()) tr.delete(range.from, range.to)
    tr.replaceWith(tr.mapping.map(active.from), tr.mapping.map(active.to), ed.schema.nodes.taskRef.create({ taskId: task.id, label: outlineLabel(task.title, task.id) }))
    ed.view.dispatch(tr.scrollIntoView())
    closeMention(); ed.commands.focus()
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ document: false, paragraph: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, blockquote: false, heading: false, horizontalRule: false, codeBlock: false, bold: false, italic: false, strike: false, code: false, underline: false, link: false, hardBreak: false, trailingNode: false }),
      OutlineRoot, OutlineLineNode, TaskReference, OutlineProjection,
    ],
    content: props.value,
    onUpdate: ({ editor: ed }) => {
      const doc = normalizeOutlineDocument(ed.getJSON())
      incoming.current = JSON.stringify(doc)
      latest.current.onChange(doc)
      updateMention(ed)
    },
    onSelectionUpdate: ({ editor: ed }) => updateMention(ed),
    editorProps: {
      attributes: { class: 'work-outline-editor', 'data-testid': 'outline-editor', 'aria-label': tRef.current('outline.title'), spellcheck: 'false' },
      handleClick: (view, pos, event) => {
        const element = (event.target as HTMLElement)?.closest<HTMLElement>('[data-outline-task]')
        if (!element) return false
        const rowId = element.closest<HTMLElement>('[data-outline-row]')?.dataset.outlineRow || view.state.doc.resolve(pos).parent.attrs.id
        event.preventDefault()
        latest.current.onOpenTask(element.dataset.outlineTask!, rowId)
        return true
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return event.key === 'Enter' || event.key === 'Tab'
        const ed = editorRef.current!
        const { $from } = ed.state.selection
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); latest.current.onSave(); return true }
        if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return true }
        const currentMention = mentionRef.current
        if (currentMention) {
          const matches = mentionTasks(currentMention.query)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            selectedRef.current = Math.max(0, Math.min(matches.length, selectedRef.current + (event.key === 'ArrowDown' ? 1 : -1)))
            setSelected(selectedRef.current); return true
          }
          if (event.key === 'Enter') { event.preventDefault(); chooseMention(matches[selectedRef.current]); return true }
          if (event.key === 'Escape') { closeMention(); return true }
        }
        if (event.key === 'Tab') {
          event.preventDefault(); closeMention()
          const doc = currentDocument()
          replaceDocument(indentOutlineRows(doc, selectionRowIds(ed), event.shiftKey ? -1 : 1), $from.parent.attrs.id, $from.parentOffset)
          return true
        }
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault(); replaceDocument(moveOutlineBranch(currentDocument(), $from.parent.attrs.id, event.key === 'ArrowUp' ? -1 : 1), $from.parent.attrs.id, $from.parentOffset); return true
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (!ed.state.selection.empty) ed.commands.deleteSelection()
          const anchor = ed.state.selection.$from
          const split = splitOutlineLine(currentDocument(), anchor.parent.attrs.id, anchor.parentOffset)
          replaceDocument(split.document, split.newRowId)
          return true
        }
        if (event.key === 'Backspace' && ed.state.selection.empty && $from.parentOffset === 0) {
          const doc = currentDocument()
          const index = doc.content.findIndex(line => line.attrs.id === $from.parent.attrs.id)
          if (index > 0 && outlineTaskId(doc.content[index]) && outlineTaskId(doc.content[index - 1])) { event.preventDefault(); setNotice(tRef.current('outline.editor.mergeBlocked')); return true }
        }
        return false
      },
      handleTextInput: (view, from, to, text) => {
        if (text !== ' ' || view.state.selection.$from.parent.textContent !== '-' || view.state.selection.$from.parentOffset !== 1) return false
        view.dispatch(view.state.tr.delete(from - 1, to)); return true
      },
      handlePaste: (view, event) => {
        const raw = event.clipboardData?.getData(clipboardType)
        const text = event.clipboardData?.getData('text/plain') ?? ''
        const html = event.clipboardData?.getData('text/html') ?? ''
        if (!raw && !html && !/[\r\n]/.test(text)) return false
        event.preventDefault()
        const knownTaskIds = new Set(latest.current.tasks.filter(task => latest.current.statuses[task.id] !== 'MISSING').map(task => task.id))
        let pasted: OutlineDocument | null = null
        if (raw) {
          try {
            const value = JSON.parse(raw)
            if (value?.type === 'doc' && value?.schemaVersion === 1 && Array.isArray(value.content) && value.content.every((line: { type?: string }) => line?.type === 'outlineLine')) pasted = normalizePastedOutline(value)
          } catch { /* Fall back to the external clipboard formats. */ }
        }
        if (!pasted && html) pasted = parseOutlineHtml(html, knownTaskIds)
        if (!pasted && text) pasted = parseOutlineText(text)
        if (!pasted) return true
        closeMention()
        const doc = currentDocument()
        const present = new Set(doc.content.map(line => line.attrs.id))
        const sourceDepth = pasted.content[0]?.attrs.depth || 0
        const baseDepth = view.state.selection.$from.parent.attrs.depth || 0
        pasted.content = pasted.content.map(line => ({ ...line, attrs: {
          id: cutIds.current.has(line.attrs.id) && !present.has(line.attrs.id) ? line.attrs.id : outlineId(),
          depth: baseDepth + line.attrs.depth - sourceDepth,
        } }))
        cutIds.current.clear()
        const node = view.state.selection.$from.parent
        if (view.state.selection.empty && node.content.size === 0) {
          const index = doc.content.findIndex(line => line.attrs.id === node.attrs.id)
          doc.content.splice(index, 1, ...pasted.content)
          replaceDocument(normalizeOutlineDocument(doc), pasted.content[pasted.content.length - 1].attrs.id)
        } else view.dispatch(closeHistory(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(pasted.content.map(line => view.state.schema.nodeFromJSON(line))), 1, 1)).setMeta('paste', true)).scrollIntoView())
        return true
      },
      handleDOMEvents: {
        blur: view => {
          const { $anchor, $head } = view.state.selection
          savedSelection.current = { anchorId: $anchor.parent.attrs.id, anchorOffset: $anchor.parentOffset, headId: $head.parent.attrs.id, headOffset: $head.parentOffset }
          return false
        },
        copy: (view, event) => {
          if (view.state.selection.empty) return false
          const selectedRows = selectionRowIds(editorRef.current!)
          const { $from, $to } = view.state.selection
          if ($from.parentOffset !== 0 || $to.parentOffset !== $to.parent.content.size) return false
          const rows = currentDocument().content.filter(row => selectedRows.includes(row.attrs.id))
          event.clipboardData?.setData(clipboardType, JSON.stringify({ type: 'doc', schemaVersion: 1, content: rows }))
          event.clipboardData?.setData('text/plain', rows.map(row => `${'\t'.repeat(row.attrs.depth)}- ${outlineLineText(row)}`).join('\n'))
          event.preventDefault(); return true
        },
        cut: (view, event) => {
          if (view.state.selection.empty) return false
          const selectedRows = selectionRowIds(editorRef.current!)
          const { $from, $to } = view.state.selection
          if ($from.parentOffset !== 0 || $to.parentOffset !== $to.parent.content.size) return false
          const doc = currentDocument()
          const rows = doc.content.filter(row => selectedRows.includes(row.attrs.id))
          cutIds.current = new Set(selectedRows)
          event.clipboardData?.setData(clipboardType, JSON.stringify({ ...doc, content: rows }))
          event.clipboardData?.setData('text/plain', rows.map(row => `${'\t'.repeat(row.attrs.depth)}- ${outlineLineText(row)}`).join('\n'))
          event.preventDefault()
          replaceDocument(normalizeOutlineDocument({ ...doc, content: doc.content.filter(row => !cutIds.current.has(row.attrs.id)) }))
          return true
        },
      },
    },
  })
  editorRef.current = editor

  useEffect(() => {
    const rejected = () => setNotice(tRef.current('outline.editor.mergeRejected'))
    window.addEventListener('chronicle:outline-merge-rejected', rejected)
    return () => window.removeEventListener('chronicle:outline-merge-rejected', rejected)
  }, [])

  useEffect(() => {
    if (!editor) return
    const signature = JSON.stringify(props.value)
    if (signature !== incoming.current && signature !== JSON.stringify(normalizeOutlineDocument(editor.getJSON()))) {
      const selectedId = editor.state.selection.$from.parent.attrs.id
      const offset = editor.state.selection.$from.parentOffset
      editor.commands.setContent(props.value, { emitUpdate: false })
      const pos = rowPosition(editor, selectedId)
      if (pos >= 0) editor.commands.setTextSelection(pos + 1 + Math.min(offset, editor.state.doc.nodeAt(pos)!.content.size))
    }
    incoming.current = signature
  }, [editor, props.value])

  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(projectionKey, { collapsed: props.collapsed, statuses: props.statuses, titles: Object.fromEntries(props.tasks.map(task => [task.id, task.title])) }).setMeta('addToHistory', false))
  }, [editor, props.collapsed, props.statuses, props.tasks])

  useEffect(() => {
    props.handleRef.current = {
      focusRow: id => { if (editor) { const pos = rowPosition(editor, id); if (pos >= 0) editor.commands.focus(pos + 1) } },
      restoreFocus: id => {
        if (!editor) return
        const selection = savedSelection.current
        const anchor = rowPosition(editor, selection?.anchorId || id)
        const head = rowPosition(editor, selection?.headId || id)
        if (anchor < 0 || head < 0) { const fallback = rowPosition(editor, id); if (fallback >= 0) editor.commands.setTextSelection(fallback + 1) }
        else editor.commands.setTextSelection({ from: anchor + 1 + Math.min(selection?.anchorOffset || 0, editor.state.doc.nodeAt(anchor)!.content.size), to: head + 1 + Math.min(selection?.headOffset || 0, editor.state.doc.nodeAt(head)!.content.size) })
        editor.view.focus()
      },
      move: (id, direction) => replaceDocument(moveOutlineBranch(currentDocument(), id, direction), id),
      unlink: id => {
        const doc = currentDocument()
        replaceDocument({ ...doc, content: doc.content.map(line => line.attrs.id === id ? { ...line, content: (line.content ?? []).filter(node => node.type !== 'taskRef') } : line) }, id)
      },
    }
    return () => { props.handleRef.current = null }
  }, [editor])

  useLayoutEffect(() => {
    if (!editor || !container.current) return
    const root = container.current
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const top = root.getBoundingClientRect().top
        const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-outline-row]')).filter(el => el.offsetHeight > 0).map(el => ({ id: el.dataset.outlineRow!, top: el.getBoundingClientRect().top - top, height: el.getBoundingClientRect().height }))
        latest.current.onLayout(rows, root.offsetHeight)
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    root.querySelectorAll('[data-outline-row]').forEach(el => observer.observe(el))
    measure()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [editor, props.value, props.collapsed, props.statuses])

  useEffect(() => {
    if (!mention) return
    const close = (event: PointerEvent) => { if (!(event.target as Element)?.closest('[data-outline-mention]')) closeMention() }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [!!mention])

  const ranking = mention ? mentionRanking(mention.query) : null
  const matches = ranking?.items ?? []
  useLayoutEffect(() => {
    const menu = mentionMenuRef.current
    if (!mention || !menu) { mentionScrollContext.current = ''; return }
    const context = JSON.stringify([mention.rowId, mention.from, mention.query])
    if (context !== mentionScrollContext.current || selected === 0) menu.scrollTop = 0
    mentionScrollContext.current = context
    if (selected > matches.length) {
      selectedRef.current = matches.length; setSelected(matches.length)
      return
    }
    const option = menu.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!option) return
    // Scroll this popup alone. scrollIntoView can also move the outline/page;
    // focusing the option would take keyboard input away from the editor.
    const bounds = menu.getBoundingClientRect(), item = option.getBoundingClientRect()
    const top = bounds.top + menu.clientTop, bottom = top + menu.clientHeight
    if (item.top < top) menu.scrollTop -= top - item.top
    else if (item.bottom > bottom) menu.scrollTop += item.bottom - bottom
  }, [mention, selected, matches.length, props.tasks])

  return <div ref={container} className="outline-editor-host">
    <EditorContent editor={editor} />
    {notice && <div role="status" className="outline-editor-notice" onClick={() => setNotice('')}>{notice} ×</div>}
    {mention && createPortal(<div ref={mentionMenuRef} data-outline-mention data-testid="outline-mention-menu" role="listbox" className="outline-mention-menu" style={{ top: Math.min(mention.top + 6, window.innerHeight - 320), left: Math.max(8, Math.min(mention.left, window.innerWidth - 340)) }}>
      {matches.map((task, index) => <button key={task.id} role="option" aria-selected={selected === index} className={selected === index ? 'selected' : ''} onPointerDown={event => { event.preventDefault(); chooseMention(task) }}><span>{task.title}</span><small>{task.status}</small></button>)}
      {ranking && ranking.total > matches.length && <div className="outline-mention-more" data-testid="outline-mention-more">{t('outline.editor.moreMatches', { count: String(ranking.total - matches.length) })}</div>}
      <button data-testid="outline-new-task-option" role="option" aria-selected={selected === matches.length} className={selected === matches.length ? 'selected' : ''} onPointerDown={event => { event.preventDefault(); chooseMention() }}>{mention.query.trim() ? t('outline.editor.newTaskNamed', { title: mention.query.trim() }) : t('outline.editor.newTask')}</button>
    </div>, document.body)}
  </div>
}
