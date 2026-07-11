import { getDb, getMetaValue, setMetaValue } from '../db'
import { upsertTaskSearchDocument, upsertTaskEntrySearchDocument, removeTaskSearchDocuments, removeSearchDocument, sourceForEntryType } from './searchIndexService'

const AGENT_CONVERSATIONS_KEY = 'agent_conversations'
const AGENT_CONVERSATIONS_BACKFILL_VERSION_KEY = 'agent_conversations_backfill_version'
const CURRENT_AGENT_CONVERSATIONS_BACKFILL_VERSION = '1'
const TASK_ID_SEQUENCE_KEY = 'task_id_sequence'

export type AgentConversationAgent = 'devin' | 'claude'

export interface AgentConversation {
  agent: AgentConversationAgent
  conversationId: string
  launchable: boolean
  createdAt: number
  sourceEntryId?: string
}

const AGENT_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/

export function isLaunchableAgentConversation(agent: unknown, conversationId: unknown): agent is AgentConversationAgent {
  return (agent === 'claude' || agent === 'devin')
    && typeof conversationId === 'string'
    && AGENT_CONVERSATION_ID_RE.test(conversationId)
}

function currentTaskSequence(): number {
  const row = getDb().prepare('SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as maxId FROM tasks').get() as { maxId: number | null }
  const persisted = Number(getMetaValue(TASK_ID_SEQUENCE_KEY) ?? 0)
  return Math.max(Number.isFinite(persisted) ? persisted : 0, row.maxId ?? 0)
}

export function allocateTaskId(): string {
  const next = currentTaskSequence() + 1
  setMetaValue(TASK_ID_SEQUENCE_KEY, String(next))
  return `T${String(next).padStart(10, '0')}`
}

export function getNextTaskId(): string {
  return `T${String(currentTaskSequence() + 1).padStart(10, '0')}`
}

export interface Task {
  id: string
  title: string
  type: string
  priority: string
  tags: string[]
  status: string
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  dueDate: number | null
}

export interface TaskEntry {
  id: string
  taskId: string
  content: string
  type: 'body' | 'log' | 'pinned'
  createdAt: number
}

export interface TaskLogDraft {
  taskId: string
  content: string
  updatedAt: number
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

function htmlToSearchableText(content: string): string {
  return decodeHtmlEntities(content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|pre|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractAgentConversationsFromContent(content: string, options: { sourceEntryId?: string; createdAt?: number } = {}): AgentConversation[] {
  const text = htmlToSearchableText(content)
  const createdAt = options.createdAt ?? Date.now()
  const conversations: AgentConversation[] = []
  const seen = new Set<string>()
  const pattern = /\b(devin|claude|cladue)\s+-r\s+([^\s<>"'`]+)/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const agent = match[1].toLowerCase() === 'devin' ? 'devin' : 'claude'
    const conversationId = match[2].trim()
    if (!conversationId || !isLaunchableAgentConversation(agent, conversationId)) continue

    const key = `${agent}:${conversationId}`
    if (seen.has(key)) continue
    seen.add(key)

    conversations.push({
      agent,
      conversationId,
      launchable: true,
      createdAt,
      ...(options.sourceEntryId ? { sourceEntryId: options.sourceEntryId } : {}),
    })
  }

  return conversations
}

function normalizeAgentConversation(value: any): AgentConversation | null {
  const agent = value?.agent === 'devin' ? 'devin' : value?.agent === 'claude' ? 'claude' : null
  const conversationId = typeof value?.conversationId === 'string' ? value.conversationId.trim() : ''
  if (!agent || !conversationId) return null

  return {
    agent,
    conversationId,
    launchable: isLaunchableAgentConversation(agent, conversationId),
    createdAt: Number.isFinite(value?.createdAt) ? Number(value.createdAt) : 0,
    ...(typeof value?.sourceEntryId === 'string' && value.sourceEntryId ? { sourceEntryId: value.sourceEntryId } : {}),
  }
}

function parseStoredAgentConversations(value: string | null): AgentConversation[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeAgentConversation).filter((item): item is AgentConversation => Boolean(item))
  } catch {
    return []
  }
}

function mergeAgentConversations(existing: AgentConversation[], incoming: AgentConversation[]): AgentConversation[] {
  const result: AgentConversation[] = []
  const seen = new Set<string>()

  for (const item of [...existing, ...incoming]) {
    const normalized = normalizeAgentConversation(item)
    if (!normalized) continue
    const key = `${normalized.agent}:${normalized.conversationId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }

  return result.sort((a, b) => a.createdAt - b.createdAt)
}

function getStoredAgentConversations(taskId: string): AgentConversation[] {
  return parseStoredAgentConversations(getTaskExtraInfoValue(taskId, AGENT_CONVERSATIONS_KEY))
}

function saveStoredAgentConversations(taskId: string, conversations: AgentConversation[]) {
  if (conversations.length === 0) return
  setTaskExtraInfo(taskId, AGENT_CONVERSATIONS_KEY, JSON.stringify(conversations))
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    priority: row.priority,
    tags: row.tags ? JSON.parse(row.tags) : [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dueDate: row.due_date,
  }
}

function rowToTaskEntry(row: any): TaskEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    content: row.content,
    type: row.type === 'body' ? 'body' : row.type === 'pinned' ? 'pinned' : 'log',
    createdAt: row.created_at,
  }
}

function hasLegacyPlanItemDetailsTable(): boolean {
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_item_details'")
    .get()
  return Boolean(row)
}

function rowToTaskLogDraft(row: any): TaskLogDraft {
  return {
    taskId: row.task_id,
    content: row.content,
    updatedAt: row.updated_at,
  }
}

function queryOne(sql: string, params: any[] = []): any | null {
  return getDb().prepare(sql).get(...params)
}

function queryAll(sql: string, params: any[] = []): any[] {
  return getDb().prepare(sql).all(...params)
}

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params)
}

export function getAllTasks(filters?: { type?: string; priority?: string; status?: string[] }): Task[] {
  let sql = 'SELECT * FROM tasks'
  const conditions: string[] = []
  const params: any[] = []

  if (filters?.type) { conditions.push('type = ?'); params.push(filters.type) }
  if (filters?.priority) { conditions.push('priority = ?'); params.push(filters.priority) }
  if (filters?.status && filters.status.length > 0) {
    const placeholders = filters.status.map(() => '?').join(', ')
    conditions.push(`status IN (${placeholders})`)
    params.push(...filters.status)
  }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY updated_at DESC'

  return queryAll(sql, params).map(rowToTask)
}

export function getTaskById(id: string): Task | null {
  const row = queryOne('SELECT * FROM tasks WHERE id = ?', [id])
  return row ? rowToTask(row) : null
}

export function createTask(data: {
  title: string
  type: string
  priority: string
  tags?: string[]
  status?: string
  dueDate?: number
  body?: string
}): Task {
  const now = Date.now()
  const id = allocateTaskId()
  const status = data.status ?? 'PENDING'

  run(
    `INSERT INTO tasks (id, title, type, priority, tags, status, created_at, updated_at, started_at, completed_at, due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.title,
      data.type,
      data.priority,
      JSON.stringify(data.tags ?? []),
      status,
      now,
      now,
      status === 'DOING' ? now : null,
      null,
      data.dueDate ?? null,
    ]
  )

  // Create body entry if provided
  if (data.body && data.body.trim()) {
    const entryId = crypto.randomUUID()
    run(
      'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
      [entryId, id, data.body.trim(), 'body', now]
    )
    upsertTaskEntrySearchDocument(id, entryId, sourceForEntryType('body'), data.body.trim(), now)
  }

  upsertTaskSearchDocument(id, data.title, data.tags ?? [])

  return getTaskById(id)!
}

export function updateTask(id: string, data: {
  title?: string
  type?: string
  priority?: string
  tags?: string[]
  status?: string
  dueDate?: number
}): Task | null {
  const existing = getTaskById(id)
  if (!existing) return null

  const updates: string[] = ['updated_at = ?']
  const params: any[] = [Date.now()]

  if (data.title !== undefined) { updates.push('title = ?'); params.push(data.title) }
  if (data.type !== undefined) { updates.push('type = ?'); params.push(data.type) }
  if (data.priority !== undefined) { updates.push('priority = ?'); params.push(data.priority) }
  if (data.tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(data.tags)) }
  if (data.dueDate !== undefined) { updates.push('due_date = ?'); params.push(data.dueDate) }

  if (data.status !== undefined) {
    updates.push('status = ?')
    params.push(data.status)

    if (data.status === 'DOING' && existing.status !== 'DOING') {
      updates.push('started_at = ?')
      params.push(Date.now())
    }
    if (data.status !== 'DONE' && existing.status === 'DONE') {
      updates.push('completed_at = ?')
      params.push(null)
    }
    if (data.status === 'DONE' && existing.status !== 'DONE') {
      updates.push('completed_at = ?')
      params.push(Date.now())
    }
  }

  if (updates.length === 0) return existing

  params.push(id)
  run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, params)
  if (data.status === 'DONE' && existing.status !== 'DONE') {
    // A completed task cannot remain the active time-tracking session.
    run('UPDATE work_sessions SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [Date.now(), id])
  }
  if (data.title !== undefined || data.tags !== undefined) {
    const current = getTaskById(id)
    if (current) upsertTaskSearchDocument(id, current.title, current.tags)
  }
  return getTaskById(id)
}

export function markTaskDone(id: string): Task | null {
  return updateTask(id, { status: 'DONE' })
}

export function deleteTask(id: string): boolean {
  const db = getDb()
  const existing = getTaskById(id)
  if (!existing) return false

  const transaction = db.transaction(() => {
    if (hasLegacyPlanItemDetailsTable()) {
      db.prepare(`
        DELETE FROM plan_item_details
        WHERE entry_id IN (SELECT id FROM task_entries WHERE task_id = ?)
      `).run(id)
    }
    db.prepare('DELETE FROM task_entries WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM work_sessions WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM task_extra_info WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM work_overview_hidden_signals WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM note_links WHERE target_id = ?').run(id)
    removeTaskSearchDocuments(id)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  })

  transaction()
  return true
}

// --- Task Entries ---

export function getTaskEntries(taskId: string): TaskEntry[] {
  return queryAll(
    `SELECT *
     FROM task_entries
     WHERE task_id = ? AND type != 'pinned'
     ORDER BY created_at ASC`,
    [taskId]
  ).map(rowToTaskEntry)
}

export function getPinnedEntry(taskId: string): TaskEntry | undefined {
  const row = queryOne(
    `SELECT *
     FROM task_entries
     WHERE task_id = ? AND type = 'pinned'
     ORDER BY created_at ASC
     LIMIT 1`,
    [taskId]
  )
  return row ? rowToTaskEntry(row) : undefined
}

export function createTaskEntry(taskId: string, content: string, type: 'body' | 'log' | 'pinned' = 'log'): TaskEntry {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')

  const id = crypto.randomUUID()
  const now = Date.now()

  run(
    'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, taskId, content, type, now]
  )
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, taskId])

  upsertTaskEntrySearchDocument(taskId, id, sourceForEntryType(type), content, now)

  return { id, taskId, content, type, createdAt: now }
}

export function createTaskEntries(taskIds: string[], content: string, type: 'body' | 'log' | 'pinned' = 'log'): TaskEntry[] {
  const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))]
  if (uniqueTaskIds.length === 0) return []

  for (const taskId of uniqueTaskIds) {
    if (!getTaskById(taskId)) throw new Error(`Task not found: ${taskId}`)
  }

  const db = getDb()
  const now = Date.now()
  const entries = uniqueTaskIds.map((taskId) => ({
    id: crypto.randomUUID(),
    taskId,
    content,
    type,
    createdAt: now,
  }))

  const insertEntry = db.prepare(
    'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const updateTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')

  const transaction = db.transaction(() => {
    for (const entry of entries) {
      insertEntry.run(entry.id, entry.taskId, entry.content, entry.type, entry.createdAt)
      updateTask.run(now, entry.taskId)
      upsertTaskEntrySearchDocument(entry.taskId, entry.id, sourceForEntryType(entry.type), entry.content, now)
    }
  })

  transaction()
  return entries
}

export function updateTaskEntry(taskId: string, entryId: string, content: string, type?: 'body' | 'log' | 'pinned'): TaskEntry | null {
  const existing = queryOne('SELECT * FROM task_entries WHERE id = ? AND task_id = ?', [entryId, taskId])
  if (!existing) return null

  const updates: string[] = ['content = ?']
  const params: any[] = [content]
  if (type !== undefined) {
    updates.push('type = ?')
    params.push(type)
  }
  params.push(entryId)

  run(`UPDATE task_entries SET ${updates.join(', ')} WHERE id = ?`, params)
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', [Date.now(), taskId])
  const nextType = type ?? (existing.type === 'body' ? 'body' : existing.type === 'pinned' ? 'pinned' : 'log')
  upsertTaskEntrySearchDocument(taskId, entryId, sourceForEntryType(nextType), content)
  const updated = queryOne(
    `SELECT *
     FROM task_entries
     WHERE id = ? AND task_id = ?`,
    [entryId, taskId]
  )
  return updated ? rowToTaskEntry(updated) : null
}

export function appendToPinnedEntry(taskId: string, content: string): TaskEntry {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')
  if (!content.trim()) throw new Error('Content is required')

  const now = Date.now()
  const existing = getPinnedEntry(taskId)

  if (existing) {
    const separator = existing.content.trim().endsWith('<hr>') || existing.content.trim().endsWith('<hr />') || existing.content.trim().endsWith('<hr/>') ? '' : '<hr>'
    const newContent = `${existing.content.trim()}${separator}${content.trim()}`
    run('UPDATE task_entries SET content = ? WHERE id = ?', [newContent, existing.id])
    run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, taskId])
    upsertTaskEntrySearchDocument(taskId, existing.id, sourceForEntryType('pinned'), newContent)
    const updated = queryOne('SELECT * FROM task_entries WHERE id = ?', [existing.id])
    return updated ? rowToTaskEntry(updated) : existing
  }

  return createTaskEntry(taskId, content.trim(), 'pinned')
}

export function unpinEntry(taskId: string, entryId: string): TaskEntry | null {
  const existing = queryOne('SELECT * FROM task_entries WHERE id = ? AND task_id = ? AND type = ?', [entryId, taskId, 'pinned'])
  if (!existing) return null

  if (!existing.content || !existing.content.trim()) {
    return deleteTaskEntry(taskId, entryId) ? null : null
  }

  return updateTaskEntry(taskId, entryId, existing.content, 'log')
}

export function deleteTaskEntry(taskId: string, entryId: string): boolean {
  const existing = queryOne('SELECT * FROM task_entries WHERE id = ? AND task_id = ?', [entryId, taskId])
  if (!existing) return false

  const db = getDb()
  const transaction = db.transaction(() => {
    if (hasLegacyPlanItemDetailsTable()) {
      db.prepare('DELETE FROM plan_item_details WHERE entry_id = ?').run(entryId)
    }
    db.prepare('UPDATE day_script_progress_syncs SET last_entry_id = NULL WHERE last_entry_id = ?').run(entryId)
    db.prepare('DELETE FROM task_entries WHERE id = ? AND task_id = ?').run(entryId, taskId)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now(), taskId)
    removeSearchDocument(`entry:${entryId}`)
  })

  transaction()
  return true
}

// --- Task Log Drafts ---

export function getTaskLogDraft(taskId: string): TaskLogDraft | null {
  const row = queryOne('SELECT * FROM task_log_drafts WHERE task_id = ?', [taskId])
  return row ? rowToTaskLogDraft(row) : null
}

export function saveTaskLogDraft(taskId: string, content: string): TaskLogDraft | null {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')

  if (!content.trim()) {
    deleteTaskLogDraft(taskId)
    return null
  }

  const now = Date.now()
  run(
    `INSERT INTO task_log_drafts (task_id, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [taskId, content, now]
  )
  return { taskId, content, updatedAt: now }
}

export function deleteTaskLogDraft(taskId: string): boolean {
  const result = run('DELETE FROM task_log_drafts WHERE task_id = ?', [taskId])
  return result.changes > 0
}

// --- Work Sessions ---

export interface WorkSession {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
}

function rowToWorkSession(row: any): WorkSession {
  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export function startWorkSession(taskId: string, startedAt = Date.now()): WorkSession {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')

  const id = crypto.randomUUID()
  getDb().transaction(() => {
    // Closing and opening must be one transaction: a concurrent read must
    // never observe two current tasks or an unintended untracked gap.
    run('UPDATE work_sessions SET ended_at = ? WHERE ended_at IS NULL', [Date.now()])
    run(
      'INSERT INTO work_sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, NULL)',
      [id, taskId, startedAt]
    )
  })()
  return { id, taskId, startedAt, endedAt: null }
}

export function endAllSessions(): void {
  run('UPDATE work_sessions SET ended_at = ? WHERE ended_at IS NULL', [Date.now()])
}

export function getCurrentSession(): WorkSession | null {
  const row = queryOne('SELECT * FROM work_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
  return row ? rowToWorkSession(row) : null
}

export function getSessionsForRange(start: number, end: number): WorkSession[] {
  return queryAll(
    'SELECT * FROM work_sessions WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC',
    [end, start]
  ).map(rowToWorkSession)
}

export function dropTask(id: string, reason: string): Task | null {
  const task = getTaskById(id)
  if (!task) return null

  // Close current session if any
  run('UPDATE work_sessions SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [Date.now(), id])

  // Update task status to DROPPED
  const now = Date.now()
  run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['DROPPED', now, id])

  // Insert a drop entry
  const entryId = crypto.randomUUID()
  run(
    'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
    [entryId, id, reason, 'log', now]
  )

  upsertTaskEntrySearchDocument(id, entryId, sourceForEntryType('log'), reason, now)

  return getTaskById(id)
}

// --- Today View ---

export function getTodayTasks(): Task[] {
  // 1. All unfinished high-priority tasks
  const highPriority = getAllTasks({ priority: 'HIGH', status: ['PENDING', 'DOING'] })

  // 2. 1 earliest unfinished daily improvement
  const dailyImprove = getAllTasks({ type: 'DAILY_IMPROVE', status: ['PENDING', 'DOING'] })
    .sort((a, b) => a.createdAt - b.createdAt)[0]

  // 3. 1 earliest unfinished to read
  const toRead = getAllTasks({ type: 'TOREAD', status: ['PENDING', 'DOING'] })
    .sort((a, b) => a.createdAt - b.createdAt)[0]

  const result = [...highPriority]
  const ids = new Set(highPriority.map(t => t.id))
  if (dailyImprove && !ids.has(dailyImprove.id)) result.push(dailyImprove)
  if (toRead && !ids.has(toRead.id)) result.push(toRead)

  return result.sort((a, b) => b.updatedAt - a.updatedAt)
}

// --- Task Extra Info ---

export interface TaskExtraInfo {
  taskId: string
  key: string
  value: string
}

export function setTaskExtraInfo(taskId: string, key: string, value: string): TaskExtraInfo {
  run(
    'INSERT OR REPLACE INTO task_extra_info(task_id, key, value) VALUES (?, ?, ?)',
    [taskId, key, value]
  )
  return { taskId, key, value }
}

export function getTaskExtraInfo(taskId: string): TaskExtraInfo[] {
  return queryAll(
    'SELECT task_id, key, value FROM task_extra_info WHERE task_id = ?',
    [taskId]
  ).map((row) => ({ taskId: row.task_id, key: row.key, value: row.value }))
}

export function getTaskExtraInfoValue(taskId: string, key: string): string | null {
  const row = queryOne(
    'SELECT value FROM task_extra_info WHERE task_id = ? AND key = ?',
    [taskId, key]
  )
  return row ? row.value : null
}

export function deleteTaskExtraInfo(taskId: string, key: string): boolean {
  const result = run(
    'DELETE FROM task_extra_info WHERE task_id = ? AND key = ?',
    [taskId, key]
  )
  return result.changes > 0
}

export function addAgentConversationsForTask(taskId: string, conversations: AgentConversation[]): AgentConversation[] {
  if (conversations.length === 0) return getTaskAgentConversations(taskId)
  const merged = mergeAgentConversations(getStoredAgentConversations(taskId), conversations)
  saveStoredAgentConversations(taskId, merged)
  return getTaskAgentConversations(taskId)
}

export function extractAndAddAgentConversationsFromEntry(entry: TaskEntry): AgentConversation[] {
  if (entry.type !== 'log') return getTaskAgentConversations(entry.taskId)
  const extracted = extractAgentConversationsFromContent(entry.content, {
    sourceEntryId: entry.id,
    createdAt: entry.createdAt,
  })
  return addAgentConversationsForTask(entry.taskId, extracted)
}

export function getTaskAgentConversations(taskId: string): AgentConversation[] {
  const stored = getStoredAgentConversations(taskId)
  const legacyClaudeId = getTaskExtraInfoValue(taskId, 'claude_conversation_id')?.trim()
  const legacy = legacyClaudeId
    ? [{
        agent: 'claude' as const,
        conversationId: legacyClaudeId,
        launchable: isLaunchableAgentConversation('claude', legacyClaudeId),
        createdAt: 0,
      }]
    : []
  return mergeAgentConversations(legacy, stored)
}

export function backfillAgentConversationsFromTaskLogs(): void {
  if (getMetaValue(AGENT_CONVERSATIONS_BACKFILL_VERSION_KEY) === CURRENT_AGENT_CONVERSATIONS_BACKFILL_VERSION) return

  const rows = queryAll(`
    SELECT id, task_id, content, type, created_at
    FROM task_entries
    WHERE type = 'log'
    ORDER BY created_at ASC
  `)
  const byTask = new Map<string, AgentConversation[]>()

  for (const row of rows) {
    const taskId = row.task_id
    const extracted = extractAgentConversationsFromContent(row.content, {
      sourceEntryId: row.id,
      createdAt: row.created_at,
    })
    if (extracted.length === 0) continue
    byTask.set(taskId, mergeAgentConversations(byTask.get(taskId) ?? [], extracted))
  }

  for (const [taskId, conversations] of byTask.entries()) {
    const merged = mergeAgentConversations(getStoredAgentConversations(taskId), conversations)
    saveStoredAgentConversations(taskId, merged)
  }

  setMetaValue(AGENT_CONVERSATIONS_BACKFILL_VERSION_KEY, CURRENT_AGENT_CONVERSATIONS_BACKFILL_VERSION)
}

export function getAllTasksWithPinned(): Array<Task & { pinned: boolean }> {
  const tasks = getAllTasks()
  const pinnedIds = new Set(
    queryAll(
      "SELECT task_id FROM task_extra_info WHERE key = 'pinned' AND value = 'true'"
    ).map((r) => r.task_id)
  )
  return tasks.map((t) => ({ ...t, pinned: pinnedIds.has(t.id) }))
}

export function togglePinned(taskId: string): boolean {
  const currentValue = getTaskExtraInfoValue(taskId, 'pinned')
  if (currentValue === 'true') {
    setTaskExtraInfo(taskId, 'pinned', 'false')
    return false
  }
  setTaskExtraInfo(taskId, 'pinned', 'true')
  return true
}

export function getPinnedTaskIds(): Set<string> {
  return new Set(
    queryAll(
      "SELECT task_id FROM task_extra_info WHERE key = 'pinned' AND value = 'true'"
    ).map((r) => r.task_id)
  )
}

// --- AFK Events ---

export interface AfkEvent {
  id: string
  triggeredAt: number
  reason: string
  userNote: string | null
  submittedAt: number | null
}

function rowToAfkEvent(row: any): AfkEvent {
  return {
    id: row.id,
    triggeredAt: row.triggered_at,
    reason: row.reason,
    userNote: row.user_note,
    submittedAt: row.submitted_at,
  }
}

export function createAfkEvent(reason: string, triggeredAt: number, userNote?: string, submittedAt?: number): AfkEvent {
  let effectiveSubmittedAt = submittedAt ?? Date.now()

  const firstResumedSession = queryOne(
    'SELECT started_at FROM work_sessions WHERE started_at > ? AND started_at < ? ORDER BY started_at ASC LIMIT 1',
    [triggeredAt, effectiveSubmittedAt]
  )

  if (firstResumedSession && submittedAt === undefined) {
    effectiveSubmittedAt = firstResumedSession.started_at
  }

  // Reject if the AFK time range overlaps with any work session
  const overlap = queryOne(
    'SELECT COUNT(*) as count FROM work_sessions WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)',
    [effectiveSubmittedAt, triggeredAt]
  )
  if (overlap && overlap.count > 0) {
    throw new Error('AFK event overlaps with an existing work session')
  }

  const id = crypto.randomUUID()
  run(
    'INSERT INTO afk_events(id, triggered_at, reason, user_note, submitted_at) VALUES (?, ?, ?, ?, ?)',
    [id, triggeredAt, reason, userNote ?? null, effectiveSubmittedAt]
  )
  return rowToAfkEvent(queryOne('SELECT * FROM afk_events WHERE id = ?', [id])!)
}

export function updateAfkEvent(id: string, userNote: string): AfkEvent | null {
  run(
    'UPDATE afk_events SET user_note = ?, submitted_at = ? WHERE id = ?',
    [userNote, Date.now(), id]
  )
  const row = queryOne('SELECT * FROM afk_events WHERE id = ?', [id])
  return row ? rowToAfkEvent(row) : null
}

export function getAfkEvents(start?: number, end?: number): AfkEvent[] {
  let sql = 'SELECT * FROM afk_events ORDER BY triggered_at DESC'
  const params: any[] = []
  if (start !== undefined && end !== undefined) {
    sql = 'SELECT * FROM afk_events WHERE triggered_at >= ? AND triggered_at <= ? ORDER BY triggered_at DESC'
    params.push(start, end)
  }
  return queryAll(sql, params).map(rowToAfkEvent)
}
