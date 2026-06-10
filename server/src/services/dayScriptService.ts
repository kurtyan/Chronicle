import { getDb } from '../db'
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
}

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
  separator?: boolean
}

interface ParsedBlock {
  sortOrder: number
  startTime: string
  endTime: string
  headerText: string
  progressText: string
  progressHtml: string
  progressLines: ParsedLine[]
  completed: boolean
  taskIds: string[]
}

type RichDayScriptBlock = DayScriptBlock & { progressLines?: ParsedLine[] }

interface ExistingSync {
  blockId: string
  taskId: string
  syncedProgress: string
  syncedProgressHtml: string
}

type ActivityMap = Map<string, DayScriptFocusActivity>

const TIME_VALUE_PATTERN = '(?:\\d{1,2}:\\d{2}|\\d{3,4})'
const TIME_HEADER_RE = new RegExp(`^(${TIME_VALUE_PATTERN})\\s*-\\s*(${TIME_VALUE_PATTERN})(?:\\s+|$)(.*)$`)
const TIME_LIKE_RE = new RegExp(`^${TIME_VALUE_PATTERN}\\s*-\\s*${TIME_VALUE_PATTERN}`)
const SEPARATOR_RE = /^-{4,}$/
const NEW_TASK_HEADER_RE = new RegExp(`^(${TIME_VALUE_PATTERN}\\s*-\\s*${TIME_VALUE_PATTERN})(\\s+)new task\\s+(.+?)\\s*(✅)?\\s*$`, 'i')

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
    lines.push({ text: '----', taskIds: [], html: '<hr>', separator: true })
    return
  }

  if (type === 'image' || type === 'imageResize') {
    lines.push({ text: '', taskIds: [], html: renderProgressLineHtml(node) })
    return
  }

  if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem' || type === 'codeBlock') {
    const line = collectInlineText(node.content ?? [])
    line.html = renderProgressLineHtml(node)
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
    for (const child of node.content ?? []) visit(child)
  }

  for (const node of nodes) visit(node)
  return { text: text.replace(/\u00a0/g, ' '), taskIds: [...taskIds], html: '' }
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

function rewriteNewTaskHeaders(document: JsonNode): { document: JsonNode; createdTasks: Task[] } {
  const cloned = cloneNode(document)
  const createdTasks: Task[] = []

  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem' || type === 'codeBlock') {
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

      const title = match[3].replace(/\s*✅\s*/g, ' ').trim()
      if (!title) return
      const startTime = parseTimeValue(match[1].split('-')[0])
      const endTime = parseTimeValue(match[1].split('-')[1])
      if (!startTime || !endTime) return

      const task = createTask({
        title,
        type: 'TODO',
        priority: 'MEDIUM',
        tags: ['ktlo'],
        status: 'PENDING',
      })
      createdTasks.push(task)

      node.content = [
        { type: 'text', text: `${startTime}-${endTime}${match[2]}` },
        taskMentionNode(task),
        ...(match[4] ? [{ type: 'text', text: ' ✅' }] : []),
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

function progressLinesToHtml(lines: ParsedLine[]): string {
  return lines.map((line) => line.html).join('')
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

function buildLogHtml(scriptDate: string, block: { startTime: string; endTime: string }, progress: string, progressHtml?: string): string {
  const header = `<p>Day Script progress · ${escapeHtml(scriptDate)} · ${escapeHtml(block.startTime)}-${escapeHtml(block.endTime)}</p>`
  const body = progressHtml || progressToHtml(progress)
  return body ? `${header}${body}` : header
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

function plannedTimestamp(scriptDate: string, time: string): number {
  const [year, month, day] = scriptDate.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
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
  const blockKey = buildActivityKey(block, taskId)
  const activity = activityMap.get(activityMapKey(blockKey, taskId))
  if (!activity || !Number.isFinite(activity.firstEditedAt) || activity.firstEditedAt <= 0) return null

  const plannedStartAt = plannedTimestamp(scriptDate, block.startTime)
  const plannedEndAt = plannedTimestamp(scriptDate, block.endTime)
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
  let allowDetachedNotes = false

  lines.forEach((line, lineIndex) => {
    const visible = line.text.trimEnd()
    if (line.separator || SEPARATOR_RE.test(visible.trim())) {
      current = null
      allowDetachedNotes = true
      return
    }

    const header = parseTimeHeader(visible)

    if (header) {
      const startTime = header.startTime
      const endTime = header.endTime
      const startMinutes = timeToMinutes(startTime)
      const endMinutes = timeToMinutes(endTime)
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        validationErrors.push({ lineIndex, message: 'Invalid time range.' })
        current = null
        return
      }

      const bodyText = header.bodyText.trim()
      current = {
        sortOrder: blocks.length,
        startTime,
        endTime,
        headerText: bodyText.replace(/\s*✅\s*/g, ' ').trim(),
        progressText: '',
        progressHtml: '',
        progressLines: [],
        completed: bodyText.includes('✅'),
        taskIds: line.taskIds.filter((taskId) => Boolean(getTaskById(taskId))),
      }
      allowDetachedNotes = false
      blocks.push(current)
      return
    }

    if (TIME_LIKE_RE.test(visible)) {
      validationErrors.push({ lineIndex, message: 'Malformed time header.' })
      return
    }

    if (!current) {
      if ((visible.trim() || line.html) && !allowDetachedNotes) validationErrors.push({ lineIndex, message: 'Progress line must follow a timed block.' })
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

function assignBlockIds(parsedBlocks: ParsedBlock[], existingBlocks: DayScriptBlock[]): RichDayScriptBlock[] {
  const unusedExisting = [...existingBlocks]

  return parsedBlocks.map((block, index) => {
    const sameShapeIndex = unusedExisting.findIndex((candidate) =>
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
      progressText: block.progressText,
      progressHtml: block.progressHtml,
      progressLines: block.progressLines,
      completed: block.completed,
      taskIds: block.taskIds,
    }
  })
}

function getExistingSyncs(scriptDate: string): ExistingSync[] {
  return queryAll(
    `SELECT s.block_id, s.task_id, s.synced_progress, s.synced_progress_html
     FROM day_script_progress_syncs s
     JOIN day_script_blocks b ON b.id = s.block_id
     WHERE b.script_date = ?`,
    [scriptDate]
  ).map((row) => ({
    blockId: row.block_id,
    taskId: row.task_id,
    syncedProgress: row.synced_progress,
    syncedProgressHtml: row.synced_progress_html ?? '',
  }))
}

function upsertBlocks(scriptDate: string, blocks: DayScriptBlock[], now: number): void {
  const keepIds = new Set(blocks.map((block) => block.id))
  const existingIds = queryAll('SELECT id FROM day_script_blocks WHERE script_date = ?', [scriptDate]).map((row) => row.id as string)

  for (const block of blocks) {
    run(
      `INSERT INTO day_script_blocks (
        id, script_date, sort_order, start_time, end_time, header_text, progress_text, completed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        script_date = excluded.script_date,
        sort_order = excluded.sort_order,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        header_text = excluded.header_text,
        progress_text = excluded.progress_text,
        completed = excluded.completed,
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

function syncBlockProgress(scriptDate: string, block: RichDayScriptBlock, existingSyncs: Map<string, ExistingSync>, activityMap: ActivityMap, completedAt: number): {
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  executionRecords: DayScriptExecutionRecord[]
  conflicts: ProgressSyncConflict[]
} {
  const createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const executionRecords: DayScriptExecutionRecord[] = []
  const conflicts: ProgressSyncConflict[] = []

  if (!block.completed) return { createdLogs, executionRecords, conflicts }

  const progress = normalizeProgress(block.progressText)
  const progressHtml = block.progressHtml || progressLinesToHtml(block.progressLines ?? [])
  if (!progress && !progressHtml) return { createdLogs, executionRecords, conflicts }

  for (const taskId of block.taskIds) {
    const syncKey = `${block.id}:${taskId}`
    const existing = existingSyncs.get(syncKey)
    const task = getTaskById(taskId)
    if (!task) continue

    if (!existing) {
      const entry = createTaskEntry(taskId, buildLogHtml(scriptDate, block, progress, progressHtml), 'log')
      run(
        'INSERT OR REPLACE INTO day_script_progress_syncs(block_id, task_id, synced_progress, synced_progress_html, last_entry_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [block.id, taskId, progress, progressHtml, entry.id, completedAt]
      )
      const executionRecord = createExecutionRecord(scriptDate, block, taskId, entry.id, activityMap, completedAt)
      if (executionRecord) executionRecords.push(executionRecord)
      createdLogs.push({ taskId, entryId: entry.id, blockId: block.id })
      continue
    }

    if (existing.syncedProgress === progress && existing.syncedProgressHtml === progressHtml) continue

    if (progress.startsWith(existing.syncedProgress)) {
      const delta = normalizeProgress(progress.slice(existing.syncedProgress.length))
      const deltaHtml = progressDeltaHtmlFromSync(block.progressLines ?? [], existing.syncedProgress, existing.syncedProgressHtml)
      if (!delta && !deltaHtml) {
        run(
          'UPDATE day_script_progress_syncs SET synced_progress = ?, synced_progress_html = ?, updated_at = ? WHERE block_id = ? AND task_id = ?',
          [progress, progressHtml, completedAt, block.id, taskId]
        )
        continue
      }
      const entry = createTaskEntry(taskId, buildLogHtml(scriptDate, block, delta, deltaHtml), 'log')
      run(
        'UPDATE day_script_progress_syncs SET synced_progress = ?, synced_progress_html = ?, last_entry_id = ?, updated_at = ? WHERE block_id = ? AND task_id = ?',
        [progress, progressHtml, entry.id, completedAt, block.id, taskId]
      )
      const executionRecord = createExecutionRecord(scriptDate, block, taskId, entry.id, activityMap, completedAt)
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

export function saveDayScript(scriptDate: string, document: JsonNode, expectedRevision: number, focusActivities?: DayScriptFocusActivity[]): SaveDayScriptResult {
  const normalizedDocument = normalizeDoc(document)
  const existing = getExistingScript(scriptDate)
  if ((existing?.revision ?? 0) !== expectedRevision) {
    throw new Error('REVISION_CONFLICT')
  }

  const { validationErrors } = parseDocument(normalizedDocument)
  if (validationErrors.length > 0) {
    return {
      script: existing ?? {
        scriptDate,
        revision: expectedRevision,
        document: normalizedDocument,
        blocks: [],
        updatedAt: Date.now(),
      },
      createdTasks: [],
      createdLogs: [],
      executionRecords: [],
      validationErrors,
      conflicts: [],
    }
  }

  const now = Date.now()
  let rewrittenDocument = normalizedDocument
  let nextBlocks: RichDayScriptBlock[] = []
  const createdTasks: Task[] = []
  const createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const executionRecords: DayScriptExecutionRecord[] = []
  const conflicts: ProgressSyncConflict[] = []
  const activityMap = normalizeFocusActivities(focusActivities)

  const transaction = getDb().transaction(() => {
    const rewriteResult = rewriteNewTaskHeaders(normalizedDocument)
    rewrittenDocument = rewriteResult.document
    createdTasks.push(...rewriteResult.createdTasks)

    const parsed = parseDocument(rewrittenDocument)
    if (parsed.validationErrors.length > 0) {
      throw new Error('UNEXPECTED_DAY_SCRIPT_VALIDATION_AFTER_REWRITE')
    }
    nextBlocks = assignBlockIds(parsed.blocks, existing?.blocks ?? [])

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

    const syncMap = new Map<string, ExistingSync>()
    for (const sync of getExistingSyncs(scriptDate)) {
      syncMap.set(`${sync.blockId}:${sync.taskId}`, sync)
    }

    for (const block of nextBlocks) {
      const result = syncBlockProgress(scriptDate, block, syncMap, activityMap, now)
      createdLogs.push(...result.createdLogs)
      executionRecords.push(...result.executionRecords)
      conflicts.push(...result.conflicts)
    }
  })

  transaction()

  return {
    script: getDayScript(scriptDate),
    createdTasks,
    createdLogs,
    executionRecords,
    validationErrors: [],
    conflicts,
  }
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
      if (!block || !task || !block.completed || !block.taskIds.includes(item.taskId)) continue
      const progress = normalizeProgress(block.progressText)
      const progressHtml = (block as RichDayScriptBlock).progressHtml || progressLinesToHtml((block as RichDayScriptBlock).progressLines ?? [])
      if (!progress && !progressHtml) continue

      const existingSync = queryOne(
        'SELECT synced_progress, synced_progress_html FROM day_script_progress_syncs WHERE block_id = ? AND task_id = ?',
        [item.blockId, item.taskId]
      ) as { synced_progress: string; synced_progress_html?: string } | null
      if (existingSync?.synced_progress === progress && (existingSync.synced_progress_html ?? '') === progressHtml) continue

      const existingProgress = existingSync?.synced_progress ?? ''
      const logProgress = existingProgress && progress.startsWith(existingProgress)
        ? normalizeProgress(progress.slice(existingProgress.length))
        : progress

      const logHtml = existingProgress && progress.startsWith(existingProgress)
        ? progressDeltaHtmlFromSync((block as RichDayScriptBlock).progressLines ?? [], existingProgress, existingSync?.synced_progress_html ?? '')
        : progressHtml
      if (!logProgress && !logHtml) continue
      const entry = createTaskEntry(item.taskId, buildLogHtml(scriptDate, block, logProgress, logHtml), 'log')
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
