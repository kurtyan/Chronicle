import { getDb } from '../db'
import { createTaskEntry, getTaskById } from './taskService'

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
  createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>
  validationErrors: DayScriptValidationError[]
  conflicts: ProgressSyncConflict[]
}

interface ParsedLine {
  text: string
  taskIds: string[]
}

interface ParsedBlock {
  sortOrder: number
  startTime: string
  endTime: string
  headerText: string
  progressText: string
  completed: boolean
  taskIds: string[]
}

interface ExistingSync {
  blockId: string
  taskId: string
  syncedProgress: string
}

const TIME_HEADER_RE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s+|$)(.*)$/
const TIME_LIKE_RE = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/

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

  if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem') {
    const line = collectInlineText(node.content ?? [])
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
  return { text: text.replace(/\u00a0/g, ' '), taskIds: [...taskIds] }
}

function timeToMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
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

function progressToHtml(text: string): string {
  if (!text.trim()) return ''
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function buildLogHtml(scriptDate: string, block: { startTime: string; endTime: string }, progress: string): string {
  const header = `<p>Day Script progress · ${escapeHtml(scriptDate)} · ${escapeHtml(block.startTime)}-${escapeHtml(block.endTime)}</p>`
  const body = progressToHtml(progress)
  return body ? `${header}${body}` : header
}

function parseDocument(document: JsonNode): { blocks: ParsedBlock[]; validationErrors: DayScriptValidationError[] } {
  const lines: ParsedLine[] = []
  collectBlockLines(document, lines)

  const validationErrors: DayScriptValidationError[] = []
  const blocks: ParsedBlock[] = []
  let current: ParsedBlock | null = null

  lines.forEach((line, lineIndex) => {
    const visible = line.text.trimEnd()
    const headerMatch = visible.match(TIME_HEADER_RE)

    if (headerMatch) {
      const startTime = headerMatch[1]
      const endTime = headerMatch[2]
      const startMinutes = timeToMinutes(startTime)
      const endMinutes = timeToMinutes(endTime)
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        validationErrors.push({ lineIndex, message: 'Invalid time range.' })
        current = null
        return
      }

      const bodyText = headerMatch[3].trim()
      current = {
        sortOrder: blocks.length,
        startTime,
        endTime,
        headerText: bodyText.replace(/\s*✅\s*/g, ' ').trim(),
        progressText: '',
        completed: bodyText.includes('✅'),
        taskIds: line.taskIds.filter((taskId) => Boolean(getTaskById(taskId))),
      }
      blocks.push(current)
      return
    }

    if (TIME_LIKE_RE.test(visible)) {
      validationErrors.push({ lineIndex, message: 'Malformed time header.' })
      return
    }

    if (!current) {
      if (visible.trim()) validationErrors.push({ lineIndex, message: 'Progress line must follow a timed block.' })
      return
    }

    current.progressText = current.progressText
      ? `${current.progressText}\n${line.text}`
      : line.text
  })

  return {
    blocks: blocks.map((block) => ({
      ...block,
      progressText: normalizeProgress(block.progressText),
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

function assignBlockIds(parsedBlocks: ParsedBlock[], existingBlocks: DayScriptBlock[]): DayScriptBlock[] {
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
      completed: block.completed,
      taskIds: block.taskIds,
    }
  })
}

function getExistingSyncs(scriptDate: string): ExistingSync[] {
  return queryAll(
    `SELECT s.block_id, s.task_id, s.synced_progress
     FROM day_script_progress_syncs s
     JOIN day_script_blocks b ON b.id = s.block_id
     WHERE b.script_date = ?`,
    [scriptDate]
  ).map((row) => ({
    blockId: row.block_id,
    taskId: row.task_id,
    syncedProgress: row.synced_progress,
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

function syncBlockProgress(scriptDate: string, block: DayScriptBlock, existingSyncs: Map<string, ExistingSync>): { createdLogs: Array<{ taskId: string; entryId: string; blockId: string }>; conflicts: ProgressSyncConflict[] } {
  const createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const conflicts: ProgressSyncConflict[] = []

  if (!block.completed) return { createdLogs, conflicts }

  const progress = normalizeProgress(block.progressText)
  if (!progress) return { createdLogs, conflicts }

  for (const taskId of block.taskIds) {
    const syncKey = `${block.id}:${taskId}`
    const existing = existingSyncs.get(syncKey)
    const task = getTaskById(taskId)
    if (!task) continue

    if (!existing) {
      const entry = createTaskEntry(taskId, buildLogHtml(scriptDate, block, progress), 'log')
      run(
        'INSERT OR REPLACE INTO day_script_progress_syncs(block_id, task_id, synced_progress, last_entry_id, updated_at) VALUES (?, ?, ?, ?, ?)',
        [block.id, taskId, progress, entry.id, Date.now()]
      )
      createdLogs.push({ taskId, entryId: entry.id, blockId: block.id })
      continue
    }

    if (existing.syncedProgress === progress) continue

    if (progress.startsWith(existing.syncedProgress)) {
      const delta = normalizeProgress(progress.slice(existing.syncedProgress.length))
      if (!delta) continue
      const entry = createTaskEntry(taskId, buildLogHtml(scriptDate, block, delta), 'log')
      run(
        'UPDATE day_script_progress_syncs SET synced_progress = ?, last_entry_id = ?, updated_at = ? WHERE block_id = ? AND task_id = ?',
        [progress, entry.id, Date.now(), block.id, taskId]
      )
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

  return { createdLogs, conflicts }
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

export function saveDayScript(scriptDate: string, document: JsonNode, expectedRevision: number): SaveDayScriptResult {
  const normalizedDocument = normalizeDoc(document)
  const existing = getExistingScript(scriptDate)
  if ((existing?.revision ?? 0) !== expectedRevision) {
    throw new Error('REVISION_CONFLICT')
  }

  const { blocks: parsedBlocks, validationErrors } = parseDocument(normalizedDocument)
  if (validationErrors.length > 0) {
    return {
      script: existing ?? {
        scriptDate,
        revision: expectedRevision,
        document: normalizedDocument,
        blocks: [],
        updatedAt: Date.now(),
      },
      createdLogs: [],
      validationErrors,
      conflicts: [],
    }
  }

  const nextBlocks = assignBlockIds(parsedBlocks, existing?.blocks ?? [])
  const now = Date.now()
  const createdLogs: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const conflicts: ProgressSyncConflict[] = []

  const transaction = getDb().transaction(() => {
    if (existing) {
      run(
        'UPDATE day_scripts SET document_json = ?, revision = ?, updated_at = ? WHERE script_date = ?',
        [JSON.stringify(normalizedDocument), existing.revision + 1, now, scriptDate]
      )
    } else {
      run(
        'INSERT INTO day_scripts(script_date, document_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [scriptDate, JSON.stringify(normalizedDocument), 1, now, now]
      )
    }

    upsertBlocks(scriptDate, nextBlocks, now)

    const syncMap = new Map<string, ExistingSync>()
    for (const sync of getExistingSyncs(scriptDate)) {
      syncMap.set(`${sync.blockId}:${sync.taskId}`, sync)
    }

    for (const block of nextBlocks) {
      const result = syncBlockProgress(scriptDate, block, syncMap)
      createdLogs.push(...result.createdLogs)
      conflicts.push(...result.conflicts)
    }
  })

  transaction()

  return {
    script: getDayScript(scriptDate),
    createdLogs,
    validationErrors: [],
    conflicts,
  }
}

export function confirmDayScriptProgressSync(scriptDate: string, items: Array<{ blockId: string; taskId: string }>): Array<{ taskId: string; entryId: string; blockId: string }> {
  const existing = getExistingScript(scriptDate)
  if (!existing) return []

  const blockMap = new Map(existing.blocks.map((block) => [block.id, block]))
  const created: Array<{ taskId: string; entryId: string; blockId: string }> = []
  const now = Date.now()

  const transaction = getDb().transaction(() => {
    for (const item of items) {
      const block = blockMap.get(item.blockId)
      const task = getTaskById(item.taskId)
      if (!block || !task || !block.completed || !block.taskIds.includes(item.taskId)) continue
      const progress = normalizeProgress(block.progressText)
      if (!progress) continue

      const existingSync = queryOne(
        'SELECT synced_progress FROM day_script_progress_syncs WHERE block_id = ? AND task_id = ?',
        [item.blockId, item.taskId]
      ) as { synced_progress: string } | null
      if (existingSync?.synced_progress === progress) continue

      const existingProgress = existingSync?.synced_progress ?? ''
      const logProgress = existingProgress && progress.startsWith(existingProgress)
        ? normalizeProgress(progress.slice(existingProgress.length))
        : progress
      if (!logProgress) continue

      const entry = createTaskEntry(item.taskId, buildLogHtml(scriptDate, block, logProgress), 'log')
      run(
        'INSERT OR REPLACE INTO day_script_progress_syncs(block_id, task_id, synced_progress, last_entry_id, updated_at) VALUES (?, ?, ?, ?, ?)',
        [item.blockId, item.taskId, progress, entry.id, now]
      )
      created.push({ taskId: item.taskId, entryId: entry.id, blockId: item.blockId })
    }
  })

  transaction()
  return created
}
