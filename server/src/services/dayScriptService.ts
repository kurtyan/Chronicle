import { getDb, getMetaValue } from '../db'
import { createTask, createTaskEntry, getTaskById, type Task } from './taskService'

type JsonNode = {
  type?: string
  text?: string
  attrs?: Record<string, any>
  marks?: Array<{ type?: string; attrs?: Record<string, any> }>
  content?: JsonNode[]
}

export interface DayScriptBlock {
  id: string
  sortOrder: number
  startTime: string
  endTime: string
  headerText: string
  progressText: string
  progressHtml?: string
  completed: boolean
  taskIds: string[]
  source: DayScriptBlockSource
  originScriptDate: string | null
  originBlockId: string | null
  originSource: DayScriptBlockSource | null
}

export type DayScriptBlockSource = 'manual' | 'task_next_step' | 'task_recommended_next_step' | 'carry_over'

export interface DayScriptDocument {
  scriptDate: string
  revision: number
  document: JsonNode
  blocks: DayScriptBlock[]
  updatedAt: number
}

export interface DayScriptValidationError {
  lineIndex: number
  message: string
}

export interface ProgressSyncConflict {
  blockId: string
  taskId: string
  taskTitle: string
  startTime: string
  endTime: string
  existingProgress: string
  currentProgress: string
}

export interface SaveDayScriptResult {
  script: DayScriptDocument
  createdTasks: Task[]
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  executionRecords: DayScriptExecutionRecord[]
  validationErrors: DayScriptValidationError[]
  conflicts: ProgressSyncConflict[]
}

export interface SubmitDayScriptProgressResult {
  script: DayScriptDocument
  createdTasks: Task[]
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  executionRecords: DayScriptExecutionRecord[]
  validationErrors: DayScriptValidationError[]
  conflicts: ProgressSyncConflict[]
}

export interface DayScriptFocusActivity {
  blockKey: string
  taskId: string
  firstEditedAt: number
}

export interface DayScriptExecutionRecord {
  id: string
  scriptDate: string
  blockId: string
  taskId: string
  progressEntryId: string
  workSessionId: string | null
  plannedStartAt: number
  plannedEndAt: number
  actualStartedAt: number
  actualCompletedAt: number
  plannedMinutes: number
  actualMinutes: number
  startDelayMinutes: number
  overrunMinutes: number
  createdAt: number
}

interface ParsedLine {
  text: string
  taskIds: string[]
  html: string
  newTaskBadge: boolean
  attrs?: Record<string, any>
}

interface ParsedBlock {
  blockId: string | null
  sortOrder: number
  startTime: string
  endTime: string
  headerText: string
  headerRemainder: string
  headerRemainderHtml: string
  progressText: string
  progressHtml: string
  progressLines: ParsedLine[]
  completed: boolean
  appendOnSubmit: boolean
  taskIds: string[]
  newTaskCreated: boolean
  source: DayScriptBlockSource
  originScriptDate: string | null
  originBlockId: string | null
  originSource: DayScriptBlockSource | null
}

type RichDayScriptBlock = DayScriptBlock & {
  headerRemainder?: string
  headerRemainderHtml?: string
  progressLines?: ParsedLine[]
  appendOnSubmit?: boolean
  newTaskCreated?: boolean
}

interface ExistingSync {
  blockId: string
  taskId: string
  syncedProgress: string
  syncedProgressHtml: string
  lastEntryId: string | null
}

type ActivityMap = Map<string, DayScriptFocusActivity>

const TIME_VALUE_PATTERN = '(?:\\d{1,2}:\\d{2}|\\d{3,4})'
const TIME_HEADER_RE = new RegExp(`^(${TIME_VALUE_PATTERN})\\s*-\\s*(${TIME_VALUE_PATTERN})(?:\\s+|$)(.*)$`)
const TIME_LIKE_RE = new RegExp(`^${TIME_VALUE_PATTERN}\\s*-\\s*${TIME_VALUE_PATTERN}`)
const FOCUS_MARKER_RE = /✅|🐲/gu
const NEW_TASK_HEADER_RE = new RegExp(`^(?:((${TIME_VALUE_PATTERN})\\s*-\\s*(${TIME_VALUE_PATTERN}))(\\s+))?new task(?:\\s+(.+?))?\\s*((?:(?:✅|🐲)\\s*)*)$`, 'iu')
const BLOCK_SOURCES: DayScriptBlockSource[] = ['manual', 'task_next_step', 'task_recommended_next_step', 'carry_over']

function queryAll(sql: string, params: any[] = []): any[] {
  return getDb().prepare(sql).all(...params)
}

function queryOne(sql: string, params: any[] = []): any | null {
  return getDb().prepare(sql).get(...params)
}

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params)
}

function emptyDoc(): JsonNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

function normalizeDoc(document?: JsonNode | null): JsonNode {
  if (!document || document.type !== 'doc') return emptyDoc()
  return document
}

function extractTaskIdFromMark(mark?: { type?: string; attrs?: Record<string, any> }): string | null {
  if (!mark || mark.type !== 'link') return null
  if (typeof mark.attrs?.taskId === 'string' && mark.attrs.taskId) return mark.attrs.taskId
  const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : ''
  const match = href.match(/[?&]task=([^&]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function collectBlockLines(node: JsonNode, lines: ParsedLine[]): void {
  const type = node.type ?? ''

  if (type === 'horizontalRule') {
    lines.push({ text: '----', taskIds: [], html: '<hr>', newTaskBadge: false, attrs: node.attrs })
    return
  }

  if (type === 'image' || type === 'imageResize') {
    lines.push({ text: '', taskIds: [], html: renderProgressLineHtml(node), newTaskBadge: false, attrs: node.attrs })
    return
  }

  if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem' || type === 'codeBlock') {
    const line = collectInlineText(node.content ?? [])
    line.newTaskBadge = hasNewTaskBadge(node.content ?? [])
    line.html = renderProgressLineHtml(node)
    line.attrs = node.attrs
    lines.push(line)
    return
  }

  for (const child of node.content ?? []) {
    collectBlockLines(child, lines)
  }
}

function collectInlineText(nodes: JsonNode[]): ParsedLine {
  let text = ''
  const taskIds = new Set<string>()

  const visit = (node: JsonNode) => {
    if (node.type === 'hardBreak') {
      text += '\n'
      return
    }
    if (node.type === 'text') {
      text += node.text ?? ''
      for (const mark of node.marks ?? []) {
        const taskId = extractTaskIdFromMark(mark)
        if (taskId) taskIds.add(taskId)
      }
      return
    }
    if (node.type === 'taskMention') {
      const label = typeof node.attrs?.label === 'string' ? node.attrs.label : ''
      const taskId = typeof node.attrs?.taskId === 'string' ? node.attrs.taskId : ''
      text += label
      if (taskId) taskIds.add(taskId)
      return
    }
    if (node.type === 'newTaskBadge') return
    for (const child of node.content ?? []) visit(child)
  }

  for (const node of nodes) visit(node)
  return { text: text.replace(/\u00a0/g, ' '), taskIds: [...taskIds], html: '', newTaskBadge: false }
}

function hasNewTaskBadge(nodes: JsonNode[]): boolean {
  return nodes.some((node) => node.type === 'newTaskBadge' || hasNewTaskBadge(node.content ?? []))
}

function cloneNode(node: JsonNode): JsonNode {
  return {
    ...node,
    attrs: node.attrs ? { ...node.attrs } : undefined,
    marks: node.marks ? node.marks.map((mark) => ({ ...mark, attrs: mark.attrs ? { ...mark.attrs } : undefined })) : undefined,
    content: node.content ? node.content.map(cloneNode) : undefined,
  }
}

function taskMentionNode(task: Task): JsonNode {
  return {
    type: 'text',
    text: `@${task.title}`,
    marks: [{
      type: 'link',
      attrs: {
        href: `/today?task=${encodeURIComponent(task.id)}`,
        taskId: task.id,
      },
    }],
  }
}

function newTaskBadgeNode(): JsonNode {
  return {
    type: 'newTaskBadge',
    attrs: { label: 'new' },
  }
}

function parseTimeValue(value: string): string | null {
  const trimmed = value.trim()
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  const compactMatch = trimmed.match(/^(\d{3,4})$/)
  const hours = colonMatch ? Number(colonMatch[1]) : compactMatch ? Number(trimmed.slice(0, -2)) : NaN
  const minutes = colonMatch ? Number(colonMatch[2]) : compactMatch ? Number(trimmed.slice(-2)) : NaN
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function parseTimeHeader(text: string): { startTime: string; endTime: string; bodyText: string; rangeText: string } | null {
  const match = text.match(TIME_HEADER_RE)
  if (!match) return null
  const startTime = parseTimeValue(match[1])
  const endTime = parseTimeValue(match[2])
  if (!startTime || !endTime) return null
  return {
    startTime,
    endTime,
    bodyText: match[3],
    rangeText: match[0].slice(0, match[0].length - match[3].length).trimEnd(),
  }
}

function replaceLeadingText(nodes: JsonNode[] = [], length: number, replacement: string): JsonNode[] {
  let remaining = length
  let replaced = false
  return nodes.flatMap((node) => {
    if (remaining <= 0 || node.type !== 'text') return [node]
    const text = node.text ?? ''
    if (!replaced) {
      replaced = true
      const keep = text.slice(Math.min(text.length, remaining))
      remaining -= Math.min(text.length, remaining)
      return [{ ...node, text: `${replacement}${keep}` }]
    }
    const remove = Math.min(text.length, remaining)
    remaining -= remove
    const nextText = text.slice(remove)
    return nextText ? [{ ...node, text: nextText }] : []
  })
}

function normalizeTimeHeaders(document: JsonNode): JsonNode {
  const cloned = cloneNode(document)

  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem') {
      const line = collectInlineText(node.content ?? [])
      const header = parseTimeHeader(line.text.trimEnd())
      if (!header) return

      const normalizedRange = `${header.startTime}-${header.endTime}`
      if (header.rangeText !== normalizedRange) {
        node.content = replaceLeadingText(node.content, header.rangeText.length, normalizedRange)
      }
      return
    }

    for (const child of node.content ?? []) visit(child)
  }

  for (const child of cloned.content ?? []) visit(child)
  return cloned
}

function formatMinutesAsTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440
  const hours = Math.floor(normalized / 60)
  const minutes = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function plannedDurationMinutes(startTime: string, endTime: string): number | null {
  const start = timeToMinutes(startTime)
  const end = timeToMinutes(endTime)
  if (start === null || end === null || start === end) return null
  return end > start ? end - start : end + 1440 - start
}

function ceilTimestampToFiveMinutes(timestamp: number): number {
  const interval = 5 * 60_000
  return Math.ceil(timestamp / interval) * interval
}

function rewritePlannedTimeHeaders(document: JsonNode, replacements: Map<number, { startTime: string; endTime: string }>): JsonNode {
  if (replacements.size === 0) return document
  const cloned = cloneNode(document)
  let blockIndex = 0

  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem') {
      const line = collectInlineText(node.content ?? [])
      const visible = line.text.trimEnd()
      const header = parseTimeHeader(visible)
      const newTaskHeader = visible.match(NEW_TASK_HEADER_RE)
      const isFocusLine = Boolean(header || line.taskIds.length > 0 || newTaskHeader)
      if (!isFocusLine) return

      const replacement = replacements.get(blockIndex)
      blockIndex += 1
      if (!replacement || !header) return

      node.content = replaceLeadingText(
        node.content,
        header.rangeText.length,
        `${replacement.startTime}-${replacement.endTime}`
      )
      return
    }

    for (const child of node.content ?? []) visit(child)
  }

  for (const child of cloned.content ?? []) visit(child)
  return cloned
}

function blockHasExistingSync(block: RichDayScriptBlock, syncMap: Map<string, ExistingSync>): boolean {
  return block.taskIds.some((taskId) => syncMap.has(`${block.id}:${taskId}`))
}

function rescheduleSelectedPlannedFocus(document: JsonNode, blocks: RichDayScriptBlock[], now: number, syncMap: Map<string, ExistingSync>, sortOrders: Set<number>): { document: JsonNode; changed: boolean } {
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => {
      if (!sortOrders.has(block.sortOrder)) return false
      if (!block.startTime || !block.endTime) return false
      if (plannedDurationMinutes(block.startTime, block.endTime) === null) return false
      if (block.completed || block.appendOnSubmit) return false
      if (blockHasExistingSync(block, syncMap)) return false
      return true
    })

  if (candidates.length === 0) return { document, changed: false }
  let nextStartAt = ceilTimestampToFiveMinutes(now)

  const replacements = new Map<number, { startTime: string; endTime: string }>()
  for (const { block, index } of candidates) {
    const duration = plannedDurationMinutes(block.startTime, block.endTime)
    if (duration === null) continue
    const nextStart = new Date(nextStartAt)
    const startMinutes = nextStart.getHours() * 60 + nextStart.getMinutes()
    const replacement = {
      startTime: formatMinutesAsTime(startMinutes),
      endTime: formatMinutesAsTime(startMinutes + duration),
    }
    if (block.startTime !== replacement.startTime || block.endTime !== replacement.endTime) {
      replacements.set(index, replacement)
    }
    nextStartAt += duration * 60_000
  }

  return { document: rewritePlannedTimeHeaders(document, replacements), changed: replacements.size > 0 }
}

function rewriteNewTaskHeaders(document: JsonNode): { document: JsonNode; createdTasks: Task[] } {
  const cloned = cloneNode(document)
  const createdTasks: Task[] = []

  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem') {
      const line = collectInlineText(node.content ?? [])
      const header = parseTimeHeader(line.text.trimEnd())
      if (header) {
        const normalizedRange = `${header.startTime}-${header.endTime}`
        if (header.rangeText !== normalizedRange) {
          node.content = replaceLeadingText(node.content, header.rangeText.length, normalizedRange)
        }
      }

      const match = line.text.trimEnd().match(NEW_TASK_HEADER_RE)
      if (!match) return

      const title = stripFocusMarkers(match[5])
      if (!title) return
      const startTime = match[2] ? parseTimeValue(match[2]) : ''
      const endTime = match[3] ? parseTimeValue(match[3]) : ''
      if ((match[2] || match[3]) && (!startTime || !endTime)) return

      const task = createTask({
        title,
        type: 'TODO',
        priority: 'MEDIUM',
        tags: ['ktlo'],
        status: 'PENDING',
      })
      createdTasks.push(task)

      node.content = [
        ...(startTime && endTime ? [{ type: 'text', text: `${startTime}-${endTime}${match[4] ?? ' '}` }] : []),
        newTaskBadgeNode(),
        { type: 'text', text: ' ' },
        taskMentionNode(task),
        ...(match[6]?.trim() ? [{ type: 'text', text: ` ${match[6].trim().replace(/\s+/g, ' ')}` }] : []),
      ]
      return
    }

    for (const child of node.content ?? []) visit(child)
  }

  for (const child of cloned.content ?? []) visit(child)
  return { document: cloned, createdTasks }
}

function timeToMinutes(value: string): number | null {
  const normalized = parseTimeValue(value)
  if (!normalized) return null
  const [hours, minutes] = normalized.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

function normalizeProgress(progressText: string): string {
  return progressText.replace(/\r\n/g, '\n').trim()
}

function normalizeActionText(text: string): string {
  return normalizeProgress(text).replace(/\s+/g, ' ').toLowerCase()
}

function focusMarkers(text: string): string[] {
  return text.match(FOCUS_MARKER_RE) ?? []
}

function markerState(text: string): { completed: boolean; appendOnSubmit: boolean; conflict: boolean } {
  const markers = focusMarkers(text)
  const completed = markers.includes('✅')
  const appendOnSubmit = markers.includes('🐲')
  return { completed, appendOnSubmit, conflict: completed && appendOnSubmit }
}

function stripFocusMarkers(text: string): string {
  return text.replace(/\s*(?:✅|🐲)\s*/gu, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeBlockSource(value: unknown): DayScriptBlockSource | null {
  return typeof value === 'string' && (BLOCK_SOURCES as string[]).includes(value)
    ? value as DayScriptBlockSource
    : null
}

function inferLegacyBlockSource(headerText: string): DayScriptBlockSource {
  if (/^recommended\s+@.+?:/i.test(headerText)) return 'task_recommended_next_step'
  if (/^next step\s+@.+?:/i.test(headerText)) return 'task_next_step'
  if (/^carry[- ]over\s+@.+?:/i.test(headerText)) return 'carry_over'
  return 'manual'
}

function sourceFromLine(line: ParsedLine, headerText: string): DayScriptBlockSource {
  return normalizeBlockSource(line.attrs?.source)
    ?? normalizeBlockSource(line.attrs?.dayScriptSource)
    ?? inferLegacyBlockSource(headerText)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/`/g, '&#96;')
}

function renderMarks(html: string, marks?: Array<{ type?: string; attrs?: Record<string, any> }>): string {
  return [...(marks ?? [])].reverse().reduce((value, mark) => {
    switch (mark.type) {
      case 'bold':
        return `<strong>${value}</strong>`
      case 'italic':
        return `<em>${value}</em>`
      case 'strike':
        return `<s>${value}</s>`
      case 'code':
        return `<code>${value}</code>`
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : ''
        const taskId = typeof mark.attrs?.taskId === 'string' ? mark.attrs.taskId : ''
        const attrs = [
          href ? `href="${escapeAttribute(href)}"` : '',
          taskId ? `data-task-id="${escapeAttribute(taskId)}"` : '',
        ].filter(Boolean).join(' ')
        return `<a ${attrs}>${value}</a>`
      }
      default:
        return value
    }
  }, html)
}

function renderInlineContent(nodes: JsonNode[] = []): string {
  return nodes.map((node) => renderNodeHtml(node)).join('')
}

function renderNodeHtml(node: JsonNode): string {
  const type = node.type ?? ''
  switch (type) {
    case 'text':
      return renderMarks(escapeHtml(node.text ?? ''), node.marks)
    case 'hardBreak':
      return '<br>'
    case 'newTaskBadge':
      return ''
    case 'paragraph':
      return `<p>${renderInlineContent(node.content)}</p>`
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
      return `<h${level}>${renderInlineContent(node.content)}</h${level}>`
    }
    case 'blockquote':
      return `<blockquote>${renderInlineContent(node.content)}</blockquote>`
    case 'bulletList':
      return `<ul>${(node.content ?? []).map(renderNodeHtml).join('')}</ul>`
    case 'orderedList':
      return `<ol>${(node.content ?? []).map(renderNodeHtml).join('')}</ol>`
    case 'listItem':
      return `<li>${renderInlineContent(node.content)}</li>`
    case 'codeBlock': {
      const wrap = node.attrs?.softWrap === false ? 'off' : 'on'
      return `<pre data-code-wrap="${wrap}"><code>${escapeHtml(collectInlineText(node.content ?? []).text)}</code></pre>`
    }
    case 'image':
    case 'imageResize': {
      const attrs = node.attrs ?? {}
      const src = typeof attrs.src === 'string' ? attrs.src : ''
      const fullpath = typeof attrs.fullpath === 'string' ? attrs.fullpath : ''
      const filename = typeof attrs.filename === 'string' ? attrs.filename : ''
      const width = typeof attrs.width === 'string' || typeof attrs.width === 'number' ? String(attrs.width) : ''
      const htmlAttrs = [
        `src="${escapeAttribute(src)}"`,
        fullpath ? `data-fullpath="${escapeAttribute(fullpath)}"` : '',
        filename ? `data-filename="${escapeAttribute(filename)}"` : '',
        width ? `width="${escapeAttribute(width)}"` : '',
      ].filter(Boolean).join(' ')
      return `<p><img ${htmlAttrs}></p>`
    }
    default:
      return renderInlineContent(node.content)
  }
}

function renderProgressLineHtml(node: JsonNode): string {
  const rendered = renderNodeHtml(node)
  if (node.type === 'listItem') return `<ul>${rendered}</ul>`
  return rendered
}

function isTrailingBlankProgressLine(line: ParsedLine): boolean {
  if (line.text.trim()) return false
  const html = line.html.trim()
  if (!html) return true
  if (/<(?:img|pre|code|ul|ol|li|blockquote|hr|h[1-6])\b/i.test(html)) return false
  const text = html
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<\/?p\b[^>]*>/gi, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
  return text.length === 0
}

function trimTrailingBlankProgressLines(lines: ParsedLine[]): ParsedLine[] {
  let end = lines.length
  while (end > 0 && isTrailingBlankProgressLine(lines[end - 1])) end -= 1
  return lines.slice(0, end)
}

function progressLinesToHtml(lines: ParsedLine[]): string {
  return trimTrailingBlankProgressLines(lines).map((line) => line.html).join('')
}

function progressDeltaHtml(lines: ParsedLine[], existingProgress: string): string {
  const existing = normalizeProgress(existingProgress)
  if (!existing) return progressLinesToHtml(lines)

  let consumed = ''
  const remaining: ParsedLine[] = []
  for (const line of lines) {
    const next = consumed ? `${consumed}\n${line.text}` : line.text
    const normalizedNext = normalizeProgress(next)
    if (!line.text.trim()) {
      if (normalizeProgress(consumed) === existing && line.html) remaining.push(line)
      continue
    }

    if (normalizedNext && existing.startsWith(normalizedNext) && normalizedNext.length <= existing.length) {
      consumed = next
      continue
    }

    if (normalizeProgress(consumed) === existing) {
      remaining.push(line)
      continue
    }

    const deltaText = normalizeProgress(normalizeProgress(next).slice(existing.length))
    if (deltaText) remaining.push({ text: deltaText, taskIds: [], html: progressToHtml(deltaText) })
    consumed = next
  }
  return progressLinesToHtml(remaining)
}

function progressDeltaHtmlFromSync(lines: ParsedLine[], existingProgress: string, existingProgressHtml: string): string {
  const currentHtml = progressLinesToHtml(lines)
  if (existingProgressHtml && currentHtml.startsWith(existingProgressHtml)) {
    return currentHtml.slice(existingProgressHtml.length)
  }
  return progressDeltaHtml(lines, existingProgress)
}

function progressToHtml(text: string): string {
  if (!text.trim()) return ''
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function extractHeaderRemainder(headerText: string, taskId?: string): string {
  if (!taskId) return ''
  const task = getTaskById(taskId)
  if (!task) return ''
  const mention = `@${task.title}`
  const index = headerText.indexOf(mention)
  if (index < 0) return ''
  return stripFocusMarkers(headerText.slice(index + mention.length))
}

function buildLogHtml(
  _scriptDate: string,
  block: { startTime: string; endTime: string; headerRemainder?: string; headerRemainderHtml?: string },
  progress: string,
  progressHtml?: string,
  includeHeaderRemainder = true
): string {
  const headerBody = includeHeaderRemainder ? (block.headerRemainderHtml || progressToHtml(block.headerRemainder ?? '')) : ''
  const body = progressHtml || progressToHtml(progress)
  return `${headerBody}${body}`
}

function buildBlockLogHtml(block: RichDayScriptBlock, progress: string, progressHtml?: string, includeHeaderRemainder = true): string {
  if (block.source !== 'manual') return progressHtml || progressToHtml(progress)
  if (includeHeaderRemainder && progressHtml && block.headerRemainderHtml && progressHtml.startsWith(block.headerRemainderHtml)) {
    return buildLogHtml('', block, progress, progressHtml, false)
  }
  return buildLogHtml('', block, progress, progressHtml, includeHeaderRemainder)
}

function blockCompletionFallback(block: Pick<RichDayScriptBlock, 'source' | 'headerRemainder'>): string {
  const action = normalizeProgress(block.headerRemainder ?? '').replace(/^[:：]\s*/, '')
  if (block.source === 'carry_over') return `完成延续事项：${action || '未命名事项'}`
  return `完成计划项：${action || '未命名事项'}`
}

function blockSyncText(block: Pick<RichDayScriptBlock, 'source' | 'headerRemainder' | 'progressText'>): string {
  if (block.source !== 'manual') {
    const body = normalizeProgress(block.progressText)
    return body || blockCompletionFallback(block)
  }
  return normalizeProgress([block.headerRemainder, block.progressText].filter((part) => part?.trim()).join('\n'))
}

function blockSyncHtml(block: Pick<RichDayScriptBlock, 'source' | 'headerRemainder' | 'headerRemainderHtml' | 'progressHtml' | 'progressLines'>): string {
  if (block.source !== 'manual') {
    const body = block.progressHtml || progressLinesToHtml(block.progressLines ?? [])
    return body || progressToHtml(blockCompletionFallback(block))
  }
  return `${block.headerRemainderHtml ?? ''}${block.progressHtml || progressLinesToHtml(block.progressLines ?? [])}`
}

function buildActivityKey(block: Pick<DayScriptBlock, 'sortOrder' | 'startTime' | 'endTime' | 'headerText'>, taskId: string): string {
  return [
    block.sortOrder,
    block.startTime,
    block.endTime,
    block.headerText.replace(/\s+/g, ' ').trim(),
    taskId,
  ].join('|')
}

function activityMapKey(blockKey: string, taskId: string): string {
  return `${blockKey}::${taskId}`
}

function getStartOfDayOffset(): number {
  const offset = Number(getMetaValue('start_of_day_offset') ?? 5)
  if (!Number.isFinite(offset)) return 5
  return Math.max(0, Math.min(23, Math.trunc(offset)))
}

function plannedTimestamp(scriptDate: string, time: string): number {
  const [year, month, day] = scriptDate.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const startOfDayOffset = getStartOfDayOffset()
  const naturalDayOffset = startOfDayOffset > 0 && hour < startOfDayOffset ? 1 : 0
  return new Date(year, month - 1, day + naturalDayOffset, hour, minute, 0, 0).getTime()
}

function plannedRangeTimestamps(scriptDate: string, startTime: string, endTime: string): { startAt: number; endAt: number } {
  const startAt = plannedTimestamp(scriptDate, startTime)
  const [endHour, endMinute] = endTime.split(':').map(Number)
  const startDate = new Date(startAt)
  let endAt = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate(),
    endHour,
    endMinute,
    0,
    0
  ).getTime()
  if (endAt <= startAt) endAt += 24 * 60 * 60_000
  return { startAt, endAt }
}

function addDays(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(year, month - 1, day + offset)
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-')
}

function minutesBetween(start: number, end: number): number {
  return Math.round((end - start) / 60_000)
}

function rowToExecutionRecord(row: any): DayScriptExecutionRecord {
  return {
    id: row.id,
    scriptDate: row.script_date,
    blockId: row.block_id,
    taskId: row.task_id,
    progressEntryId: row.progress_entry_id,
    workSessionId: row.work_session_id ?? null,
    plannedStartAt: row.planned_start_at,
    plannedEndAt: row.planned_end_at,
    actualStartedAt: row.actual_started_at,
    actualCompletedAt: row.actual_completed_at,
    plannedMinutes: row.planned_minutes,
    actualMinutes: row.actual_minutes,
    startDelayMinutes: row.start_delay_minutes,
    overrunMinutes: row.overrun_minutes,
    createdAt: row.created_at,
  }
}

function findMatchingWorkSessionId(taskId: string, actualStartedAt: number, actualCompletedAt: number): string | null {
  const row = queryOne(
    `SELECT id
     FROM work_sessions
     WHERE task_id = ?
       AND started_at <= ?
       AND (ended_at IS NULL OR ended_at >= ?)
     ORDER BY started_at DESC
     LIMIT 1`,
    [taskId, actualCompletedAt, actualStartedAt]
  ) as { id: string } | null
  return row?.id ?? null
}

function createExecutionRecord(scriptDate: string, block: DayScriptBlock, taskId: string, entryId: string, activityMap: ActivityMap, completedAt: number): DayScriptExecutionRecord | null {
  if (!block.startTime || !block.endTime) return null
  if (queryOne(
    'SELECT id FROM day_script_execution_records WHERE progress_entry_id = ? LIMIT 1',
    [entryId]
  )) return null
  const blockKey = buildActivityKey(block, taskId)
  const activity = activityMap.get(activityMapKey(blockKey, taskId))
  if (!activity || !Number.isFinite(activity.firstEditedAt) || activity.firstEditedAt <= 0) return null

  const { startAt: plannedStartAt, endAt: plannedEndAt } = plannedRangeTimestamps(scriptDate, block.startTime, block.endTime)
  const actualStartedAt = Math.min(activity.firstEditedAt, completedAt)
  const actualCompletedAt = completedAt
  const id = crypto.randomUUID()
  const record: DayScriptExecutionRecord = {
    id,
    scriptDate,
    blockId: block.id,
    taskId,
    progressEntryId: entryId,
    workSessionId: findMatchingWorkSessionId(taskId, actualStartedAt, actualCompletedAt),
    plannedStartAt,
    plannedEndAt,
    actualStartedAt,
    actualCompletedAt,
    plannedMinutes: minutesBetween(plannedStartAt, plannedEndAt),
    actualMinutes: minutesBetween(actualStartedAt, actualCompletedAt),
    startDelayMinutes: minutesBetween(plannedStartAt, actualStartedAt),
    overrunMinutes: minutesBetween(plannedEndAt, actualCompletedAt),
    createdAt: completedAt,
  }

  run(
    `INSERT INTO day_script_execution_records (
      id, script_date, block_id, task_id, progress_entry_id, work_session_id,
      planned_start_at, planned_end_at, actual_started_at, actual_completed_at,
      planned_minutes, actual_minutes, start_delay_minutes, overrun_minutes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.scriptDate,
      record.blockId,
      record.taskId,
      record.progressEntryId,
      record.workSessionId,
      record.plannedStartAt,
      record.plannedEndAt,
      record.actualStartedAt,
      record.actualCompletedAt,
      record.plannedMinutes,
      record.actualMinutes,
      record.startDelayMinutes,
      record.overrunMinutes,
      record.createdAt,
    ]
  )
  return record
}

function normalizeFocusActivities(items?: DayScriptFocusActivity[]): ActivityMap {
  const map: ActivityMap = new Map()
  for (const item of items ?? []) {
    if (!item || typeof item.blockKey !== 'string' || typeof item.taskId !== 'string') continue
    if (!Number.isFinite(item.firstEditedAt) || item.firstEditedAt <= 0) continue
    const key = activityMapKey(item.blockKey, item.taskId)
    const existing = map.get(key)
    if (!existing || item.firstEditedAt < existing.firstEditedAt) map.set(key, item)
  }
  return map
}

function parseDocument(document: JsonNode): { blocks: ParsedBlock[]; validationErrors: DayScriptValidationError[] } {
  const lines: ParsedLine[] = []
  collectBlockLines(document, lines)

  const validationErrors: DayScriptValidationError[] = []
  const blocks: ParsedBlock[] = []
  let current: ParsedBlock | null = null

  lines.forEach((line, lineIndex) => {
    const visible = line.text.trimEnd()

    const header = parseTimeHeader(visible)
    const newTaskHeader = visible.match(NEW_TASK_HEADER_RE)

    if (!header && !newTaskHeader && TIME_LIKE_RE.test(visible)) {
      validationErrors.push({ lineIndex, message: 'Malformed time header.' })
      current = null
      return
    }

    if (header || line.taskIds.length > 0 || newTaskHeader) {
      if (line.taskIds.length > 1) {
        validationErrors.push({ lineIndex, message: 'Focus line can reference only one task.' })
        current = null
        return
      }

      const startTime = header?.startTime ?? (newTaskHeader?.[2] ? parseTimeValue(newTaskHeader[2]) ?? '' : '')
      const endTime = header?.endTime ?? (newTaskHeader?.[3] ? parseTimeValue(newTaskHeader[3]) ?? '' : '')
      const startMinutes = timeToMinutes(startTime)
      const endMinutes = timeToMinutes(endTime)
      if ((header || (newTaskHeader?.[2] && newTaskHeader?.[3])) && (startMinutes === null || endMinutes === null || endMinutes === startMinutes)) {
        validationErrors.push({ lineIndex, message: 'Invalid time range.' })
        current = null
        return
      }

      const bodyText = (header?.bodyText ?? visible).trim()
      const markers = markerState(bodyText)
      if (newTaskHeader && (markers.completed || markers.appendOnSubmit)) {
        validationErrors.push({ lineIndex, message: 'Focus line cannot combine new task with ✅ or 🐲.' })
      }
      if (newTaskHeader && !stripFocusMarkers(newTaskHeader[5] ?? '')) {
        validationErrors.push({ lineIndex, message: 'New task line needs a title.' })
      }
      if (markers.conflict) {
        validationErrors.push({ lineIndex, message: 'Focus line cannot use both ✅ and 🐲.' })
        current = null
        return
      }
      const effectiveMarkers = newTaskHeader
        ? { completed: false, appendOnSubmit: false }
        : markers
      const taskIds = line.taskIds.filter((taskId) => Boolean(getTaskById(taskId)))
      const headerRemainder = extractHeaderRemainder(bodyText, taskIds[0])
      const source = sourceFromLine(line, bodyText)
      current = {
        blockId: nullableString(line.attrs?.blockId),
        sortOrder: blocks.length,
        startTime,
        endTime,
        headerText: stripFocusMarkers(bodyText),
        headerRemainder,
        headerRemainderHtml: progressToHtml(headerRemainder),
        progressText: '',
        progressHtml: '',
        progressLines: [],
        completed: effectiveMarkers.completed,
        appendOnSubmit: effectiveMarkers.appendOnSubmit,
        taskIds,
        newTaskCreated: line.newTaskBadge,
        source,
        originScriptDate: nullableString(line.attrs?.originScriptDate),
        originBlockId: nullableString(line.attrs?.originBlockId),
        originSource: normalizeBlockSource(line.attrs?.originSource),
      }
      blocks.push(current)
      return
    }

    if (TIME_LIKE_RE.test(visible)) {
      validationErrors.push({ lineIndex, message: 'Malformed time header.' })
      return
    }

    if (!current) {
      if (!isTrailingBlankProgressLine(line)) validationErrors.push({ lineIndex, message: 'Progress line must follow a focus line.' })
      return
    }

    current.progressText = current.progressText
      ? `${current.progressText}\n${line.text}`
      : line.text
    current.progressLines.push(line)
  })

  return {
    blocks: blocks.map((block) => ({
      ...block,
      progressText: normalizeProgress(block.progressText),
      progressHtml: progressLinesToHtml(block.progressLines),
      headerText: block.headerText.trim(),
    })),
    validationErrors,
  }
}

function getExistingScript(scriptDate: string): DayScriptDocument | null {
  const row = queryOne('SELECT * FROM day_scripts WHERE script_date = ?', [scriptDate])
  if (!row) return null
  const blocks = queryAll(
    `SELECT b.*, bt.task_id
     FROM day_script_blocks b
     LEFT JOIN day_script_block_tasks bt ON bt.block_id = b.id
     WHERE b.script_date = ?
     ORDER BY b.sort_order ASC`,
    [scriptDate]
  )

  const blockMap = new Map<string, DayScriptBlock>()
  for (const rowItem of blocks) {
    const existing = blockMap.get(rowItem.id)
    if (existing) {
      if (rowItem.task_id) existing.taskIds.push(rowItem.task_id)
      continue
    }
    blockMap.set(rowItem.id, {
      id: rowItem.id,
      sortOrder: rowItem.sort_order,
      startTime: rowItem.start_time,
      endTime: rowItem.end_time,
      headerText: rowItem.header_text,
      progressText: rowItem.progress_text,
      completed: Boolean(rowItem.completed),
      taskIds: rowItem.task_id ? [rowItem.task_id] : [],
      source: normalizeBlockSource(rowItem.source) ?? 'manual',
      originScriptDate: rowItem.origin_script_date ?? null,
      originBlockId: rowItem.origin_block_id ?? null,
      originSource: normalizeBlockSource(rowItem.origin_source),
    })
  }

  let document = emptyDoc()
  try {
    document = JSON.parse(row.document_json)
  } catch {
    document = emptyDoc()
  }

  return {
    scriptDate: row.script_date,
    revision: row.revision,
    document,
    blocks: [...blockMap.values()],
    updatedAt: row.updated_at,
  }
}

function blockLineage(block: Pick<DayScriptBlock, 'id' | 'source' | 'originScriptDate' | 'originBlockId' | 'originSource'>, scriptDate: string): {
  originScriptDate: string
  originBlockId: string
  originSource: DayScriptBlockSource
} {
  return {
    originScriptDate: block.originScriptDate ?? scriptDate,
    originBlockId: block.originBlockId ?? block.id,
    originSource: block.originSource ?? block.source,
  }
}

function rowsToBlocks(rows: any[]): DayScriptBlock[] {
  const blockMap = new Map<string, DayScriptBlock>()
  for (const rowItem of rows) {
    const existing = blockMap.get(rowItem.id)
    if (existing) {
      if (rowItem.task_id) existing.taskIds.push(rowItem.task_id)
      continue
    }
    blockMap.set(rowItem.id, {
      id: rowItem.id,
      sortOrder: rowItem.sort_order,
      startTime: rowItem.start_time,
      endTime: rowItem.end_time,
      headerText: rowItem.header_text,
      progressText: rowItem.progress_text,
      completed: Boolean(rowItem.completed),
      taskIds: rowItem.task_id ? [rowItem.task_id] : [],
      source: normalizeBlockSource(rowItem.source) ?? 'manual',
      originScriptDate: rowItem.origin_script_date ?? null,
      originBlockId: rowItem.origin_block_id ?? null,
      originSource: normalizeBlockSource(rowItem.origin_source),
    })
  }
  return [...blockMap.values()]
}

function assignBlockIds(parsedBlocks: ParsedBlock[], existingBlocks: DayScriptBlock[]): RichDayScriptBlock[] {
  const unusedExisting = [...existingBlocks]

  return parsedBlocks.map((block, index) => {
    const explicitIdIndex = block.blockId
      ? unusedExisting.findIndex((candidate) => candidate.id === block.blockId)
      : -1
    const sameShapeIndex = explicitIdIndex >= 0 ? explicitIdIndex : unusedExisting.findIndex((candidate) =>
      candidate.startTime === block.startTime
      && candidate.endTime === block.endTime
      && candidate.headerText === block.headerText
    )

    const existing = sameShapeIndex >= 0 ? unusedExisting.splice(sameShapeIndex, 1)[0] : null
    return {
      id: existing?.id ?? crypto.randomUUID(),
      sortOrder: index,
      startTime: block.startTime,
      endTime: block.endTime,
      headerText: block.headerText,
      headerRemainder: block.headerRemainder,
      headerRemainderHtml: block.headerRemainderHtml,
      progressText: block.progressText,
      progressHtml: block.progressHtml,
      progressLines: block.progressLines,
      completed: block.completed,
      appendOnSubmit: block.appendOnSubmit,
      taskIds: block.taskIds,
      newTaskCreated: block.newTaskCreated,
      source: block.source,
      originScriptDate: block.originScriptDate ?? existing?.originScriptDate ?? null,
      originBlockId: block.originBlockId ?? existing?.originBlockId ?? null,
      originSource: block.originSource ?? existing?.originSource ?? null,
    }
  })
}

function withAssignedBlockIds(document: JsonNode, blocks: RichDayScriptBlock[]): JsonNode {
  const cloned = cloneNode(document)
  let blockIndex = 0

  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem') {
      const line = collectInlineText(node.content ?? [])
      const visible = line.text.trimEnd()
      const header = parseTimeHeader(visible)
      const newTaskHeader = visible.match(NEW_TASK_HEADER_RE)
      if (!header && line.taskIds.length === 0 && !newTaskHeader) return
      const block = blocks[blockIndex]
      blockIndex += 1
      if (block) node.attrs = { ...(node.attrs ?? {}), blockId: block.id }
      return
    }
    for (const child of node.content ?? []) visit(child)
  }

  for (const child of cloned.content ?? []) visit(child)
  return cloned
}

function getExistingSyncs(scriptDate: string): ExistingSync[] {
  return queryAll(
    `SELECT s.block_id, s.task_id, s.synced_progress, s.synced_progress_html, s.last_entry_id
     FROM day_script_progress_syncs s
     JOIN day_script_blocks b ON b.id = s.block_id
     WHERE b.script_date = ?`,
    [scriptDate]
  ).map((row) => ({
    blockId: row.block_id,
    taskId: row.task_id,
      syncedProgress: row.synced_progress,
      syncedProgressHtml: row.synced_progress_html ?? '',
      lastEntryId: row.last_entry_id ?? null,
  }))
}

function upsertBlocks(scriptDate: string, blocks: DayScriptBlock[], now: number): void {
  const keepIds = new Set(blocks.map((block) => block.id))
  const existingIds = queryAll('SELECT id FROM day_script_blocks WHERE script_date = ?', [scriptDate]).map((row) => row.id as string)

  for (const block of blocks) {
    run(
      `INSERT INTO day_script_blocks (
        id, script_date, sort_order, start_time, end_time, header_text, progress_text, completed,
        source, origin_script_date, origin_block_id, origin_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        script_date = excluded.script_date,
        sort_order = excluded.sort_order,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        header_text = excluded.header_text,
        progress_text = excluded.progress_text,
        completed = excluded.completed,
        source = excluded.source,
        origin_script_date = excluded.origin_script_date,
        origin_block_id = excluded.origin_block_id,
        origin_source = excluded.origin_source,
        updated_at = excluded.updated_at`,
      [
        block.id,
        scriptDate,
        block.sortOrder,
        block.startTime,
        block.endTime,
        block.headerText,
        block.progressText,
        block.completed ? 1 : 0,
        block.source,
        block.originScriptDate,
        block.originBlockId,
        block.originSource,
        now,
        now,
      ]
    )

    run('DELETE FROM day_script_block_tasks WHERE block_id = ?', [block.id])
    for (const taskId of block.taskIds) {
      run('INSERT OR IGNORE INTO day_script_block_tasks(block_id, task_id) VALUES (?, ?)', [block.id, taskId])
    }
    if (block.taskIds.length === 0) {
      run('DELETE FROM day_script_progress_syncs WHERE block_id = ?', [block.id])
    } else {
      const placeholders = block.taskIds.map(() => '?').join(', ')
      run(`DELETE FROM day_script_progress_syncs WHERE block_id = ? AND task_id NOT IN (${placeholders})`, [block.id, ...block.taskIds])
    }
  }

  for (const id of existingIds) {
    if (!keepIds.has(id)) {
      run('DELETE FROM day_script_blocks WHERE id = ?', [id])
    }
  }
}

function syncBlockProgress(scriptDate: string, block: RichDayScriptBlock, existingSyncs: Map<string, ExistingSync>, activityMap: ActivityMap, completedAt: number, newlyCreatedTaskIds: Set<string> = new Set()): {
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  executionRecords: DayScriptExecutionRecord[]
  conflicts: ProgressSyncConflict[]
} {
  const createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const executionRecords: DayScriptExecutionRecord[] = []
  const conflicts: ProgressSyncConflict[] = []

  const progress = blockSyncText(block)
  const progressHtml = blockSyncHtml(block)
  if (!progress && !progressHtml) return { createdLogs, executionRecords, conflicts }

  for (const taskId of block.taskIds) {
    const syncKey = `${block.id}:${taskId}`
    const existing = existingSyncs.get(syncKey)
    const task = getTaskById(taskId)
    if (!task) continue
    if (block.newTaskCreated && !existing && newlyCreatedTaskIds.has(taskId)) continue

    if (!existing) {
      const entry = createTaskEntry(taskId, buildBlockLogHtml(block, progress, progressHtml), 'log')
      run(
        'INSERT OR REPLACE INTO day_script_progress_syncs(block_id, task_id, synced_progress, synced_progress_html, last_entry_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [block.id, taskId, progress, progressHtml, entry.id, completedAt]
      )
      const executionRecord = block.completed ? createExecutionRecord(scriptDate, block, taskId, entry.id, activityMap, completedAt) : null
      if (executionRecord) executionRecords.push(executionRecord)
      createdLogs.push({ taskId, entryId: entry.id, blockId: block.id })
      continue
    }

    if (existing.syncedProgress === progress && existing.syncedProgressHtml === progressHtml) {
      if (block.completed && existing.lastEntryId) {
        const executionRecord = createExecutionRecord(scriptDate, block, taskId, existing.lastEntryId, activityMap, completedAt)
        if (executionRecord) executionRecords.push(executionRecord)
      }
      continue
    }

    const canAppendDelta = progress.startsWith(existing.syncedProgress)
      && (!existing.syncedProgressHtml || progressHtml.startsWith(existing.syncedProgressHtml))

    if (canAppendDelta) {
      const delta = normalizeProgress(progress.slice(existing.syncedProgress.length))
      const deltaHtml = existing.syncedProgress || existing.syncedProgressHtml
        ? progressHtml.slice(existing.syncedProgressHtml.length)
        : progressHtml
      if (!delta && !deltaHtml) {
        run(
          'UPDATE day_script_progress_syncs SET synced_progress = ?, synced_progress_html = ?, updated_at = ? WHERE block_id = ? AND task_id = ?',
          [progress, progressHtml, completedAt, block.id, taskId]
        )
        continue
      }
      const entry = createTaskEntry(taskId, buildBlockLogHtml(block, delta, deltaHtml, false), 'log')
      run(
        'UPDATE day_script_progress_syncs SET synced_progress = ?, synced_progress_html = ?, last_entry_id = ?, updated_at = ? WHERE block_id = ? AND task_id = ?',
        [progress, progressHtml, entry.id, completedAt, block.id, taskId]
      )
      const executionRecord = block.completed ? createExecutionRecord(scriptDate, block, taskId, entry.id, activityMap, completedAt) : null
      if (executionRecord) executionRecords.push(executionRecord)
      createdLogs.push({ taskId, entryId: entry.id, blockId: block.id })
      continue
    }

    conflicts.push({
      blockId: block.id,
      taskId,
      taskTitle: task.title,
      startTime: block.startTime,
      endTime: block.endTime,
      existingProgress: existing.syncedProgress,
      currentProgress: progress,
    })
  }

  return { createdLogs, executionRecords, conflicts }
}

export function getDayScript(scriptDate: string): DayScriptDocument {
  return getExistingScript(scriptDate) ?? {
    scriptDate,
    revision: 0,
    document: emptyDoc(),
    blocks: [],
    updatedAt: 0,
  }
}

export function getCarryOverDayScriptBlocks(scriptDate: string, windowDays = 7): DayScriptBlock[] {
  const startDate = addDays(scriptDate, -windowDays)
  const todayBlocks = getExistingScript(scriptDate)?.blocks ?? []
  const todayLineages = new Set(todayBlocks.map((block) => {
    const lineage = blockLineage(block, scriptDate)
    return `${lineage.originScriptDate}:${lineage.originBlockId}`
  }))
  const todayTaskText = new Set(todayBlocks.flatMap((block) =>
    block.taskIds.map((taskId) => `${taskId}:${normalizeActionText(block.headerText)}`)
  ))

  const rows = queryAll(
    `SELECT b.*, bt.task_id
     FROM day_script_blocks b
     JOIN day_script_block_tasks bt ON bt.block_id = b.id
     JOIN tasks t ON t.id = bt.task_id
     WHERE b.script_date >= ?
       AND b.script_date < ?
       AND b.completed = 0
       AND t.status IN ('PENDING', 'DOING')
     ORDER BY b.script_date ASC, b.sort_order ASC`,
    [startDate, scriptDate]
  )
  const blocks = rowsToBlocks(rows)
  const latestByLineage = new Map<string, DayScriptBlock & { scriptDate: string }>()

  for (const block of blocks) {
    const row = rows.find((item) => item.id === block.id)
    const blockDate = row?.script_date as string
    const lineage = blockLineage(block, blockDate)
    const lineageKey = `${lineage.originScriptDate}:${lineage.originBlockId}`
    if (todayLineages.has(lineageKey)) continue
    if (block.taskIds.some((taskId) => todayTaskText.has(`${taskId}:${normalizeActionText(block.headerText)}`))) continue

    const completedLater = queryOne(
      `SELECT 1
       FROM day_script_blocks
       WHERE script_date > ?
         AND script_date < ?
         AND completed = 1
         AND COALESCE(origin_script_date, script_date) = ?
         AND COALESCE(origin_block_id, id) = ?
       LIMIT 1`,
      [blockDate, scriptDate, lineage.originScriptDate, lineage.originBlockId]
    )
    if (completedLater) continue

    const existing = latestByLineage.get(lineageKey)
    if (!existing || blockDate > existing.scriptDate || (blockDate === existing.scriptDate && block.sortOrder > existing.sortOrder)) {
      latestByLineage.set(lineageKey, {
        ...block,
        source: 'carry_over',
        originScriptDate: lineage.originScriptDate,
        originBlockId: lineage.originBlockId,
        originSource: lineage.originSource,
        scriptDate: blockDate,
      })
    }
  }

  return [...latestByLineage.values()]
    .sort((a, b) => a.scriptDate.localeCompare(b.scriptDate) || a.sortOrder - b.sortOrder)
    .map(({ scriptDate: _scriptDate, ...block }) => block)
}

export function saveDayScript(scriptDate: string, document: JsonNode, expectedRevision: number, _focusActivities?: DayScriptFocusActivity[]): SaveDayScriptResult {
  const normalizedDocument = normalizeDoc(document)
  const existing = getExistingScript(scriptDate)
  if ((existing?.revision ?? 0) !== expectedRevision) {
    throw new Error('REVISION_CONFLICT')
  }

  const parsedDraft = parseDocument(normalizedDocument)
  const { validationErrors } = parsedDraft
  if (validationErrors.length > 0) {
    const now = Date.now()
    const nextRevision = (existing?.revision ?? 0) + 1
    const transaction = getDb().transaction(() => {
      if (existing) {
        run(
          'UPDATE day_scripts SET document_json = ?, revision = ?, updated_at = ? WHERE script_date = ?',
          [JSON.stringify(normalizedDocument), nextRevision, now, scriptDate]
        )
      } else {
        run(
          'INSERT INTO day_scripts(script_date, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [scriptDate, JSON.stringify(normalizedDocument), nextRevision, now, now]
        )
      }
      // Keep recovery drafts durable, but never reconcile derived blocks while
      // the document is invalid. Reconciliation can delete existing sync and
      // execution history for a temporarily malformed focus line.
    })
    transaction()
    const savedScript = getExistingScript(scriptDate)
    return {
      script: savedScript ?? {
        scriptDate,
        revision: nextRevision,
        document: normalizedDocument,
        blocks: existing?.blocks ?? [],
        updatedAt: now,
      },
      createdTasks: [],
      createdLogs: [],
      executionRecords: [],
      validationErrors,
      conflicts: [],
    }
  }

  const now = Date.now()
  let rewrittenDocument = normalizeTimeHeaders(normalizedDocument)
  let nextBlocks: RichDayScriptBlock[] = []
  const createdTasks: Task[] = []

  const transaction = getDb().transaction(() => {
    const parsed = parseDocument(rewrittenDocument)
    nextBlocks = assignBlockIds(parsed.blocks, existing?.blocks ?? [])
    rewrittenDocument = withAssignedBlockIds(rewrittenDocument, nextBlocks)

    if (existing) {
      run(
        'UPDATE day_scripts SET document_json = ?, revision = ?, updated_at = ? WHERE script_date = ?',
        [JSON.stringify(rewrittenDocument), existing.revision + 1, now, scriptDate]
      )
    } else {
      run(
        'INSERT INTO day_scripts(script_date, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [scriptDate, JSON.stringify(rewrittenDocument), 1, now, now]
      )
    }

    upsertBlocks(scriptDate, nextBlocks, now)
  })

  transaction()

  return {
    script: getDayScript(scriptDate),
    createdTasks,
    createdLogs: [],
    executionRecords: [],
    validationErrors: [],
    conflicts: [],
  }
}

export function submitDayScriptProgress(scriptDate: string, focusActivities?: DayScriptFocusActivity[]): SubmitDayScriptProgressResult {
  const existing = getExistingScript(scriptDate)
  if (!existing) return { script: getDayScript(scriptDate), createdTasks: [], createdLogs: [], executionRecords: [], validationErrors: [], conflicts: [] }

  const parsed = parseDocument(existing.document)
  if (parsed.validationErrors.length > 0) {
    return { script: existing, createdTasks: [], createdLogs: [], executionRecords: [], validationErrors: parsed.validationErrors, conflicts: [] }
  }

  const now = Date.now()
  let richBlocks = assignBlockIds(parsed.blocks, existing.blocks)
  const activityMap = normalizeFocusActivities(focusActivities)
  const createdTasks: Task[] = []
  const createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const executionRecords: DayScriptExecutionRecord[] = []
  const conflicts: ProgressSyncConflict[] = []

  const transaction = getDb().transaction(() => {
    let document = existing.document
    let documentChanged = false
    const rewriteResult = rewriteNewTaskHeaders(existing.document)
    if (rewriteResult.createdTasks.length > 0) {
      document = rewriteResult.document
      documentChanged = true
      createdTasks.push(...rewriteResult.createdTasks)

      const rewrittenParsed = parseDocument(document)
      if (rewrittenParsed.validationErrors.length > 0) {
        throw new Error('UNEXPECTED_DAY_SCRIPT_VALIDATION_AFTER_REWRITE')
      }
      richBlocks = assignBlockIds(rewrittenParsed.blocks, existing.blocks)
    }

    const syncMap = new Map<string, ExistingSync>()
    for (const sync of getExistingSyncs(scriptDate)) {
      syncMap.set(`${sync.blockId}:${sync.taskId}`, sync)
    }

    if (documentChanged) {
      document = withAssignedBlockIds(document, richBlocks)
      run(
        'UPDATE day_scripts SET document_json = ?, revision = ?, updated_at = ? WHERE script_date = ?',
        [JSON.stringify(document), existing.revision + 1, now, scriptDate]
      )
      upsertBlocks(scriptDate, richBlocks, now)
    }

    for (const task of createdTasks) {
      const block = richBlocks.find((item) => item.taskIds.includes(task.id))
      if (!block) continue
      const bodyHtml = block.progressHtml || progressLinesToHtml(block.progressLines ?? [])
      if (bodyHtml || block.progressText.trim()) {
        createTaskEntry(task.id, bodyHtml || progressToHtml(block.progressText), 'body')
      }
      run(
        'INSERT OR REPLACE INTO day_script_progress_syncs(block_id, task_id, synced_progress, synced_progress_html, last_entry_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [block.id, task.id, blockSyncText(block), blockSyncHtml(block), null, now]
      )
    }

    for (const block of richBlocks) {
      if (!block.completed && !block.appendOnSubmit) continue
      const result = syncBlockProgress(scriptDate, block, syncMap, activityMap, now, new Set(createdTasks.map((task) => task.id)))
      createdLogs.push(...result.createdLogs)
      executionRecords.push(...result.executionRecords)
      conflicts.push(...result.conflicts)
    }
  })

  transaction()
  return { script: getDayScript(scriptDate), createdTasks, createdLogs, executionRecords, validationErrors: [], conflicts }
}

export function rescheduleDayScriptFocus(scriptDate: string, expectedRevision: number, sortOrders: number[]): { script: DayScriptDocument; changed: boolean } {
  const existing = getExistingScript(scriptDate)
  if (!existing || existing.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')

  const parsed = parseDocument(existing.document)
  if (parsed.validationErrors.length > 0) return { script: existing, changed: false }

  const requestedSortOrders = new Set(sortOrders.filter(Number.isInteger))
  if (requestedSortOrders.size === 0) return { script: existing, changed: false }

  const now = Date.now()
  let nextDocument = existing.document
  let changed = false
  const transaction = getDb().transaction(() => {
    const richBlocks = assignBlockIds(parsed.blocks, existing.blocks)
    const syncMap = new Map<string, ExistingSync>()
    for (const sync of getExistingSyncs(scriptDate)) syncMap.set(`${sync.blockId}:${sync.taskId}`, sync)

    const result = rescheduleSelectedPlannedFocus(existing.document, richBlocks, now, syncMap, requestedSortOrders)
    if (!result.changed) return

    const rescheduled = parseDocument(result.document)
    if (rescheduled.validationErrors.length > 0) throw new Error('UNEXPECTED_DAY_SCRIPT_VALIDATION_AFTER_RESCHEDULE')
    const rescheduledBlocks = assignBlockIds(rescheduled.blocks, existing.blocks)
    nextDocument = withAssignedBlockIds(result.document, rescheduledBlocks)
    run(
      'UPDATE day_scripts SET document_json = ?, revision = ?, updated_at = ? WHERE script_date = ?',
      [JSON.stringify(nextDocument), existing.revision + 1, now, scriptDate]
    )
    upsertBlocks(scriptDate, rescheduledBlocks, now)
    changed = true
  })

  transaction()
  return { script: changed ? getDayScript(scriptDate) : existing, changed }
}

export function getDayScriptExecutionRecords(scriptDate: string, filters?: { taskId?: string; start?: number; end?: number }): DayScriptExecutionRecord[] {
  const conditions = ['script_date = ?']
  const params: any[] = [scriptDate]
  if (filters?.taskId) {
    conditions.push('task_id = ?')
    params.push(filters.taskId)
  }
  if (filters?.start !== undefined) {
    conditions.push('actual_completed_at >= ?')
    params.push(filters.start)
  }
  if (filters?.end !== undefined) {
    conditions.push('actual_started_at <= ?')
    params.push(filters.end)
  }
  return queryAll(
    `SELECT *
     FROM day_script_execution_records
     WHERE ${conditions.join(' AND ')}
     ORDER BY actual_started_at ASC, created_at ASC`,
    params
  ).map(rowToExecutionRecord)
}

export function confirmDayScriptProgressSync(scriptDate: string, items: Array<{ blockId: string; taskId: string }>): Array<{ taskId: string; entryId: string; blockId: string }> {
  const existing = getExistingScript(scriptDate)
  if (!existing) return []

  const parsed = parseDocument(existing.document)
  const richBlocks = parsed.validationErrors.length === 0
    ? assignBlockIds(parsed.blocks, existing.blocks)
    : existing.blocks
  const blockMap = new Map(richBlocks.map((block) => [block.id, block]))
  const created: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const now = Date.now()

  const transaction = getDb().transaction(() => {
    for (const item of items) {
      const block = blockMap.get(item.blockId)
      const task = getTaskById(item.taskId)
      if (!block || !task || !block.taskIds.includes(item.taskId)) continue
      const richBlock = block as RichDayScriptBlock
      if (!richBlock.completed) continue
      if (richBlock.newTaskCreated) continue
      const progress = blockSyncText(richBlock)
      const progressHtml = blockSyncHtml(richBlock)
      if (!progress && !progressHtml) continue

      const existingSync = queryOne(
        'SELECT synced_progress, synced_progress_html FROM day_script_progress_syncs WHERE block_id = ? AND task_id = ?',
        [item.blockId, item.taskId]
      ) as { synced_progress: string; synced_progress_html?: string } | null
      if (existingSync?.synced_progress === progress && (existingSync.synced_progress_html ?? '') === progressHtml) continue

      const existingProgress = existingSync?.synced_progress ?? ''
      const existingProgressHtml = existingSync?.synced_progress_html ?? ''
      const canAppendDelta = Boolean(existingProgress)
        && progress.startsWith(existingProgress)
        && (!existingProgressHtml || progressHtml.startsWith(existingProgressHtml))
      const logProgress = canAppendDelta
        ? normalizeProgress(progress.slice(existingProgress.length))
        : progress

      const logHtml = canAppendDelta
        ? progressHtml.slice(existingProgressHtml.length)
        : progressHtml
      if (!logProgress && !logHtml) continue
      const entry = createTaskEntry(
        item.taskId,
        canAppendDelta
          ? buildBlockLogHtml(richBlock, logProgress, logHtml, false)
          : buildBlockLogHtml(richBlock, progress, progressHtml),
        'log'
      )
      run(
        'INSERT OR REPLACE INTO day_script_progress_syncs(block_id, task_id, synced_progress, synced_progress_html, last_entry_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [item.blockId, item.taskId, progress, progressHtml, entry.id, now]
      )
      created.push({ taskId: item.taskId, entryId: entry.id, blockId: item.blockId })
    }
  })

  transaction()
  return created
}
