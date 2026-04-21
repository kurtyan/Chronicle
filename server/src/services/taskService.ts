import { getDb } from '../db'
import { indexTask, removeTaskFromIndex, indexEntry, removeEntryFromIndex } from './searchService'

function generateTaskId(): string {
  const row = getDb().prepare('SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as maxId FROM tasks').get() as { maxId: number | null }
  const next = (row.maxId ?? 0) + 1
  return `T${String(next).padStart(10, '0')}`
}

export function getNextTaskId(): string {
  return generateTaskId()
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
  type: 'body' | 'log'
  createdAt: number
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
    type: row.type as 'body' | 'log',
    createdAt: row.created_at,
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
  const id = generateTaskId()
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
    indexEntry(id, entryId, data.body.trim(), 'body')
  }

  indexTask(id, data.title)

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
    if (data.status === 'DOING' && existing.status === 'DONE') {
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
  if (data.title !== undefined) {
    indexTask(id, data.title)
  }
  return getTaskById(id)
}

export function markTaskDone(id: string): Task | null {
  return updateTask(id, { status: 'DONE' })
}

export function deleteTask(id: string): boolean {
  const result = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
  getDb().prepare('DELETE FROM task_entries WHERE task_id = ?').run(id)
  removeTaskFromIndex(id)
  return result.changes > 0
}

// --- Task Entries ---

export function getTaskEntries(taskId: string): TaskEntry[] {
  return queryAll(
    'SELECT * FROM task_entries WHERE task_id = ? ORDER BY created_at ASC',
    [taskId]
  ).map(rowToTaskEntry)
}

export function createTaskEntry(taskId: string, content: string, type: 'body' | 'log' = 'log'): TaskEntry {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')

  const id = crypto.randomUUID()
  const now = Date.now()

  run(
    'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, taskId, content, type, now]
  )
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, taskId])

  indexEntry(taskId, id, content, type)

  return { id, taskId, content, type, createdAt: now }
}

export function updateTaskEntry(entryId: string, content: string): TaskEntry | null {
  const existing = queryOne('SELECT * FROM task_entries WHERE id = ?', [entryId])
  if (!existing) return null

  run('UPDATE task_entries SET content = ? WHERE id = ?', [content, entryId])
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', [Date.now(), existing.task_id])
  indexEntry(existing.task_id, entryId, content, existing.type as 'body' | 'log')
  return rowToTaskEntry(queryOne('SELECT * FROM task_entries WHERE id = ?', [entryId])!)
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

export function startWorkSession(taskId: string): WorkSession {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')

  // Close any existing open session
  run('UPDATE work_sessions SET ended_at = ? WHERE ended_at IS NULL', [Date.now()])

  const id = crypto.randomUUID()
  const now = Date.now()
  run(
    'INSERT INTO work_sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, NULL)',
    [id, taskId, now]
  )
  return { id, taskId, startedAt: now, endedAt: null }
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
  run('UPDATE tasks SET status = ? WHERE id = ?', ['DROPPED', id])

  // Insert a drop entry
  const entryId = crypto.randomUUID()
  run(
    'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
    [entryId, id, reason, 'log', Date.now()]
  )

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

export function createAfkEvent(reason: string, triggeredAt: number, userNote?: string): AfkEvent {
  const submittedAt = Date.now()

  // Reject if the AFK time range overlaps with any work session
  const overlap = queryOne(
    'SELECT COUNT(*) as count FROM work_sessions WHERE started_at < ? AND ended_at > ?',
    [submittedAt, triggeredAt]
  )
  if (overlap && overlap.count > 0) {
    throw new Error('AFK event overlaps with an existing work session')
  }

  const id = crypto.randomUUID()
  run(
    'INSERT INTO afk_events(id, triggered_at, reason, user_note, submitted_at) VALUES (?, ?, ?, ?, ?)',
    [id, triggeredAt, reason, userNote ?? null, submittedAt]
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
