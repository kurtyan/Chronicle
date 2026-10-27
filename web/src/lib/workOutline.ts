import type { OutlineDocument, OutlineLine } from '../services/workOutlineApi'

export const outlineId = () => crypto.randomUUID()
/** The server stores one-line labels of at most 1000 characters; a longer or multi-line Task title must not block every save. */
export const outlineLabel = (value: unknown, fallback: string) => String(value || fallback).replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, 1000) || fallback
export const emptyOutlineLine = (depth = 0): OutlineLine => ({ type: 'outlineLine', attrs: { id: outlineId(), depth }, content: [] })
export const emptyOutlineDocument = (): OutlineDocument => ({ type: 'doc', schemaVersion: 1, content: [emptyOutlineLine()] })
export const outlineTaskId = (line: OutlineLine) => line.content?.find(node => node.type === 'taskRef')?.attrs.taskId ?? null
export const outlineLineText = (line: OutlineLine) => (line.content ?? []).map(node => node.type === 'text' ? node.text : `@${node.attrs.label}`).join('')
export const outlineTaskIds = (doc: OutlineDocument) => [...new Set(doc.content.map(outlineTaskId).filter((id): id is string => !!id))]

/** Only canonical line JSON is stored. Parent/child relations are projections. */
export function normalizeOutlineDocument(value: unknown): OutlineDocument {
  const input = value as { content?: unknown[] } | null
  const seen = new Set<string>()
  let previousDepth = 0
  const lines: OutlineLine[] = []
  for (const raw of input?.content ?? []) {
    const row = raw as Partial<OutlineLine>
    if (row.type !== 'outlineLine') continue
    const id = typeof row.attrs?.id === 'string' && row.attrs.id && !seen.has(row.attrs.id) ? row.attrs.id : outlineId()
    seen.add(id)
    const depth = lines.length ? Math.min(previousDepth + 1, Math.max(0, Math.floor(Number(row.attrs?.depth) || 0))) : 0
    const content: OutlineLine['content'] = []
    let linked = false
    for (const item of row.content ?? []) {
      if (item.type === 'text' && typeof item.text === 'string' && item.text) content.push({ type: 'text', text: item.text.replace(/[\r\n]/g, ' ') })
      if (item.type === 'taskRef' && !linked && typeof item.attrs?.taskId === 'string' && item.attrs.taskId) {
        linked = true
        content.push({ type: 'taskRef', attrs: { taskId: item.attrs.taskId, label: outlineLabel(item.attrs.label, item.attrs.taskId) } })
      }
    }
    lines.push({ type: 'outlineLine', attrs: { id, depth }, content })
    previousDepth = depth
  }
  return { type: 'doc', schemaVersion: 1, content: lines.length ? lines : [emptyOutlineLine()] }
}

export function getSubtreeEnd(lines: OutlineLine[], index: number) {
  let end = index + 1
  while (end < lines.length && lines[end].attrs.depth > lines[index].attrs.depth) end++
  return end
}

/** With `activeOnly`, only unfinished leaves and their ancestors stay visible. */
export function visibleOutlineRows(doc: OutlineDocument, collapsed: Set<string>, statuses: Record<string, string>, activeOnly = false) {
  const lines = doc.content
  const counts = lines.map(() => ({ count: 0, done: 0 }))
  const parents: number[] = []
  const parentIndex: number[] = []
  lines.forEach((line, index) => {
    while (parents.length && lines[parents[parents.length - 1]].attrs.depth >= line.attrs.depth) parents.pop()
    parentIndex[index] = parents.length ? parents[parents.length - 1] : -1
    parents.push(index)
  })
  for (let i = lines.length - 1; i >= 0; i--) {
    const id = outlineTaskId(lines[i])
    const parent = parentIndex[i]
    if (parent >= 0) {
      counts[parent].count += counts[i].count + (id ? 1 : 0)
      counts[parent].done += counts[i].done + (id && statuses[id] === 'DONE' ? 1 : 0)
    }
  }
  const inherited: boolean[] = []
  const hidden: boolean[] = []
  const keep: boolean[] = []
  if (activeOnly) {
    // A leaf is finished when it, or an ancestor task, is DONE; parents survive while any descendant does.
    const done: boolean[] = []
    lines.forEach((line, index) => {
      const taskId = outlineTaskId(line)
      const parent = parentIndex[index]
      done[index] = taskId ? statuses[taskId] === 'DONE' : parent >= 0 && done[parent]
    })
    for (let i = lines.length - 1; i >= 0; i--) {
      const leaf = !(i + 1 < lines.length && lines[i + 1].attrs.depth > lines[i].attrs.depth)
      if (leaf && !done[i]) keep[i] = true
      if (keep[i] && parentIndex[i] >= 0) keep[parentIndex[i]] = true
    }
  }
  return lines.flatMap((line, index) => {
    const parent = parentIndex[index]
    const taskId = outlineTaskId(line)
    inherited[index] = taskId ? statuses[taskId] === 'DONE' : parent >= 0 && inherited[parent]
    hidden[index] = parent >= 0 && (hidden[parent] || collapsed.has(lines[parent].attrs.id))
    const dimmed = taskId ? statuses[taskId] === 'DONE' : inherited[index] || (counts[index].count > 0 && counts[index].count === counts[index].done)
    if (activeOnly && !keep[index]) return []
    return hidden[index] ? [] : [{ line, index, dimmed, hasChildren: index + 1 < lines.length && lines[index + 1].attrs.depth > line.attrs.depth }]
  })
}

export function indentOutlineRows(doc: OutlineDocument, ids: string[], direction: 1 | -1): OutlineDocument {
  const selected = new Set(ids)
  const lines = doc.content.map(line => ({ ...line, attrs: { ...line.attrs } }))
  const roots: number[] = []
  let includedUntil = -1
  for (let i = 0; i < lines.length; i++) if (selected.has(lines[i].attrs.id) && i >= includedUntil) {
    roots.push(i); includedUntil = getSubtreeEnd(lines, i)
  }
  if (!roots.length) return doc
  if (direction === 1 && roots.some(i => i === 0 || lines[i - 1].attrs.depth < lines[i].attrs.depth)) return doc
  if (direction === -1 && roots.some(i => lines[i].attrs.depth === 0)) return doc
  const ranges = roots.map(i => [i, getSubtreeEnd(lines, i)])
  for (const [start, end] of ranges) for (let i = start; i < end; i++) lines[i].attrs.depth += direction
  return normalizeOutlineDocument({ ...doc, content: lines })
}

export function moveOutlineBranch(doc: OutlineDocument, rowId: string, direction: 1 | -1): OutlineDocument {
  const lines = [...doc.content]
  const start = lines.findIndex(line => line.attrs.id === rowId)
  if (start < 0) return doc
  const end = getSubtreeEnd(lines, start)
  let target = direction === 1 ? end : start - 1
  if (direction === -1) while (target >= 0 && lines[target].attrs.depth > lines[start].attrs.depth) target--
  if (target < 0 || target >= lines.length || lines[target].attrs.depth !== lines[start].attrs.depth) return doc
  if (direction === 1) {
    const targetEnd = getSubtreeEnd(lines, target)
    lines.splice(start, targetEnd - start, ...lines.slice(target, targetEnd), ...lines.slice(start, end))
  } else lines.splice(target, end - target, ...lines.slice(start, end), ...lines.slice(target, start))
  return { ...doc, content: lines }
}

/**
 * Draft title for a Task created from a row: the Task title of the nearest ancestor
 * row that is linked to a Task, then " - ", then the row's own text. `resolve` returns
 * null for a link that should not count (for example a deleted Task).
 */
export function outlineDraftTitle(doc: OutlineDocument, rowId: string, resolve: (taskId: string, label: string) => string | null): string {
  const lines = doc.content
  const index = lines.findIndex(line => line.attrs.id === rowId)
  if (index < 0) return ''
  let depth = lines[index].attrs.depth
  let parent = ''
  for (let i = index - 1; i >= 0 && depth > 0 && !parent; i--) {
    if (lines[i].attrs.depth >= depth) continue
    depth = lines[i].attrs.depth
    const link = lines[i].content?.find(node => node.type === 'taskRef')
    if (link?.type === 'taskRef') parent = resolve(link.attrs.taskId, link.attrs.label)?.trim() ?? ''
  }
  const own = outlineLineText(lines[index]).trim()
  return outlineLabel(parent && own ? `${parent} - ${own}` : parent || own, '')
}

export function splitOutlineLine(doc: OutlineDocument, rowId: string, offset: number): { document: OutlineDocument; newRowId: string } {
  const index = doc.content.findIndex(line => line.attrs.id === rowId)
  if (index < 0) return { document: doc, newRowId: rowId }
  const line = doc.content[index]
  const before: OutlineLine['content'] = [], after: OutlineLine['content'] = []
  let remaining = Math.max(0, offset)
  for (const node of line.content ?? []) {
    const size = node.type === 'text' ? node.text.length : 1
    if (remaining >= size) before.push(node)
    else if (node.type === 'text') {
      if (remaining > 0) before.push({ type: 'text', text: node.text.slice(0, remaining) })
      after.push({ type: 'text', text: node.text.slice(remaining) })
    } else after.push(node)
    remaining = Math.max(0, remaining - size)
  }
  const next = { ...emptyOutlineLine(line.attrs.depth), content: after }
  const lines = [...doc.content]
  lines[index] = { ...line, content: before }
  // The original row keeps its children. The new sibling follows the subtree.
  lines.splice(getSubtreeEnd(lines, index), 0, next)
  return { document: { ...doc, content: lines }, newRowId: next.attrs.id }
}

/** Clipboard fragments carry absolute source depths; rebase the entire fragment
 * before document validation forces its first row to the root. */
export function normalizePastedOutline(value: unknown): OutlineDocument {
  const doc = value as { content?: OutlineLine[] }
  if (!Array.isArray(doc?.content)) return emptyOutlineDocument()
  const initial = Number(doc.content[0]?.attrs?.depth) || 0
  return normalizeOutlineDocument({ content: doc.content.map(line => ({ ...line, attrs: { ...line.attrs, depth: (Number(line.attrs?.depth) || 0) - initial } })) })
}

export function parseOutlineText(text: string): OutlineDocument {
  return outlineClipboardRows(text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(value => ({ content: value ? [{ type: 'text', text: value }] : [] })))
}

type ClipboardRow = { content: NonNullable<OutlineLine['content']>; depth?: number; indent?: number }
const listMarker = /^(?:[-*+•◦▪▫‣⁃●○■□◆◇–—]|\d+[.)、]|[a-zA-Z][.)]|[（(]\d+[）)])\s+/u

/** Compare observed indentation levels, rather than assuming every source uses
 * exactly two spaces. Tabs advance to a two-column stop, including mixed input. */
function outlineClipboardRows(rows: ClipboardRow[]): OutlineDocument {
  const indentation: number[] = []
  const content = rows.map(row => {
    const nodes = row.content.map(node => ({ ...node }))
    const first = nodes[0]
    let width = row.indent ?? 0
    if (first?.type === 'text') {
      const prefix = first.text.match(/^[\t \u00a0\u2002\u2003\u3000]*/)?.[0] ?? ''
      for (const character of prefix) width += character === '\t' ? 2 - width % 2 : character === '\u3000' || character === '\u2003' ? 2 : 1
      first.text = first.text.slice(prefix.length).replace(listMarker, '')
      if (!first.text) nodes.shift()
    }
    if (row.depth === undefined && nodes.length) {
      while (indentation.length && width < indentation[indentation.length - 1]) indentation.pop()
      if (!indentation.length || width > indentation[indentation.length - 1]) indentation.push(width)
    }
    return { ...emptyOutlineLine(row.depth ?? Math.max(0, indentation.length - 1)), content: nodes }
  })
  return normalizePastedOutline({ content })
}

/** A transient clipboard tree, with only text and the few attributes we read.
 * It is never rendered, stored, or used as another source of outline state. */
export interface OutlineClipboardNode {
  text?: string
  tag?: string
  attrs?: Record<string, string>
  children?: OutlineClipboardNode[]
}

export function parseOutlineClipboardNodes(nodes: OutlineClipboardNode[], validTaskIds: ReadonlySet<string>): OutlineDocument | null {
  const rows: ClipboardRow[] = []
  const ignored = new Set(['script', 'style', 'meta', 'link', 'base', 'title', 'head', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'img', 'input'])
  const blocks = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr'])
  const isList = (node: OutlineClipboardNode) => node.tag === 'ul' || node.tag === 'ol'
  const textOf = (node: OutlineClipboardNode): string => ignored.has(node.tag ?? '') ? '' : node.text ?? (node.children ?? []).map(textOf).join('')
  const append = (target: ClipboardRow['content'], text: string) => {
    if (!text) return
    const last = target[target.length - 1]
    if (last?.type === 'text') last.text += text
    else target.push({ type: 'text', text })
  }
  const inline = (node: OutlineClipboardNode, target: ClipboardRow['content'], lists?: OutlineClipboardNode[]) => {
    if (ignored.has(node.tag ?? '')) return
    if (isList(node)) { lists?.push(node); return }
    if (node.text !== undefined) { append(target, node.text.replace(/[\r\n]+[\t ]*/g, ' ')); return }
    const taskId = node.attrs?.['data-task-id'] ?? node.attrs?.['data-outline-task']
    if (taskId && validTaskIds.has(taskId)) {
      target.push({ type: 'taskRef', attrs: { taskId, label: (textOf(node).replace(/^\s*@/, '').replace(/\s+/g, ' ').trim() || taskId).slice(0, 1000) } })
      return
    }
    if (node.tag === 'br') { append(target, ' '); return }
    const block = blocks.has(node.tag ?? '')
    const previous = target[target.length - 1]
    if (block && previous && !(previous.type === 'text' && /\s$/.test(previous.text))) append(target, ' ')
    for (const child of node.children ?? []) inline(child, target, lists)
    if (block && target.length) append(target, ' ')
  }
  const emit = (content: ClipboardRow['content'], depth?: number, indent?: number, empty = false) => {
    // One Task per canonical row. Preserve additional explicit references as
    // adjacent rows rather than silently discarding them during normalization.
    const parts: ClipboardRow['content'][] = [[]]
    for (const node of content) {
      if (node.type === 'taskRef' && parts[parts.length - 1].some(value => value.type === 'taskRef')) parts.push([])
      parts[parts.length - 1].push(node)
    }
    for (const part of parts) {
      const last = part[part.length - 1]
      if (last?.type === 'text') { last.text = last.text.trimEnd(); if (!last.text) part.pop() }
      if (part.length || empty) rows.push({ content: part, depth, indent })
    }
  }
  const list = (node: OutlineClipboardNode, depth: number) => {
    for (const child of node.children ?? []) {
      if (isList(child)) { list(child, depth + 1); continue }
      if (child.tag !== 'li') continue
      const content: ClipboardRow['content'] = [], nested: OutlineClipboardNode[] = []
      for (const item of child.children ?? []) inline(item, content, nested)
      emit(content, depth, undefined, true)
      for (const item of nested) list(item, depth + 1)
    }
  }
  const visit = (children: OutlineClipboardNode[], indent = 0, preserveWhitespace = false) => {
    let pending: ClipboardRow['content'] = []
    const flush = () => { emit(pending, undefined, indent); pending = [] }
    const walk = (node: OutlineClipboardNode, preserve = preserveWhitespace) => {
      if (ignored.has(node.tag ?? '')) return
      if (isList(node)) { flush(); list(node, 0); return }
      if (node.tag === 'br') { flush(); return }
      if (node.text !== undefined && preserve) {
        node.text.replace(/\r\n?/g, '\n').split('\n').forEach((value, index) => { if (index) flush(); append(pending, value) })
        return
      }
      preserve ||= /(?:^|;)\s*white-space\s*:\s*(?:pre|pre-wrap|pre-line|break-spaces)(?:\s|;|$)/i.test(node.attrs?.style ?? '')
      if (blocks.has(node.tag ?? '')) {
        flush()
        // Apple/Chrome can export indentation as inline margins instead of lists.
        // Read numeric values only; never attach or evaluate the pasted style.
        const style = node.attrs?.style ?? ''
        const margins = [...style.matchAll(/(?:^|;)\s*(?:margin-left|padding-left)\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt|em|rem)(?:\s|;|$)/gi)]
        const offset = margins.reduce((value, match) => value + Number(match[1]) * (match[2].toLowerCase() === 'pt' ? 4 / 3 : /^(?:em|rem)$/i.test(match[2]) ? 16 : 1), 0)
        if (node.tag === 'pre') {
          for (const value of textOf(node).replace(/\r\n?/g, '\n').split('\n')) rows.push({ content: value ? [{ type: 'text', text: value }] : [], indent: indent + offset })
        } else visit(node.children ?? [], indent + offset, preserve)
      } else if (node.children && !(node.attrs?.['data-task-id'] || node.attrs?.['data-outline-task'])) {
        for (const child of node.children) walk(child, preserve)
      } else inline(node, pending)
    }
    for (const node of children) walk(node)
    flush()
  }
  visit(nodes)
  return rows.length ? outlineClipboardRows(rows) : null
}

/** Template contents are inert: scripts, event handlers, and external resources
 * are never inserted in the page. Only the extracted text/Task IDs reach Tiptap. */
export function parseOutlineHtml(html: string, validTaskIds: ReadonlySet<string>): OutlineDocument | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const extract = (node: ChildNode): OutlineClipboardNode => node.nodeType === 3 ? { text: node.textContent ?? '' } : {
    tag: node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : '',
    attrs: node.nodeType === 1 ? Object.fromEntries(['data-task-id', 'data-outline-task', 'style'].flatMap(name => {
      const value = (node as Element).getAttribute(name)
      return value === null ? [] : [[name, value]]
    })) : {},
    children: Array.from(node.childNodes).map(extract),
  }
  return parseOutlineClipboardNodes(Array.from(template.content.childNodes).map(extract), validTaskIds)
}

export function outlineDocumentText(doc: OutlineDocument) {
  return doc.content.map(line => `${'\t'.repeat(line.attrs.depth)}- ${outlineLineText(line)}`).join('\n')
}

export function bindOutlineTask(doc: OutlineDocument, rowId: string, taskId: string, label: string): OutlineDocument {
  return { ...doc, content: doc.content.map(line => line.attrs.id !== rowId ? line : {
    ...line, content: [...(line.content ?? []).filter(node => node.type !== 'taskRef'), { type: 'text', text: ' ' }, { type: 'taskRef', attrs: { taskId, label: outlineLabel(label, taskId) } }],
  }) }
}

const STATUS_RANK: Record<string, number> = { DOING: 0, PENDING: 1, ON_HOLD: 2, DONE: 3, DROPPED: 4 }
export const MENTION_LIMIT = 50

/**
 * Ranks Tasks for the @ menu. Every whitespace-separated token must match the title or ID:
 * a title prefix beats a title substring, which beats an ID match; ties favour active and recently updated Tasks.
 * `total` counts every match so the menu can say how many were cut by `limit`.
 */
export function rankOutlineTasks<T extends { id: string; title: string; status: string; updatedAt?: number }>(tasks: readonly T[], query: string, limit = MENTION_LIMIT): { items: T[]; total: number } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches: Array<{ task: T; score: number }> = []
  for (const task of tasks) {
    const title = task.title.toLowerCase(), id = task.id.toLowerCase()
    let score = 0, matched = true
    for (const token of tokens) {
      if (title.startsWith(token)) continue
      if (title.includes(token)) score += 1
      else if (id.includes(token)) score += 2
      else { matched = false; break }
    }
    if (matched) matches.push({ task, score })
  }
  matches.sort((a, b) => a.score - b.score || (STATUS_RANK[a.task.status] ?? 5) - (STATUS_RANK[b.task.status] ?? 5) || (b.task.updatedAt ?? 0) - (a.task.updatedAt ?? 0))
  return { items: matches.slice(0, limit).map(match => match.task), total: matches.length }
}
