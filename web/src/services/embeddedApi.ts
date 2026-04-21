import initSqlJs, { type Database } from 'sql.js'
import { readFile, writeFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import type { ApiInterface } from './apiTypes'
import type { Task, CreateTaskRequest, UpdateTaskRequest, TaskEntry, WorkSession, SearchResult, TaskType, TaskStatus, TaskExtraInfo, AfkEvent } from '@/types'

const DB_FILENAME = 'tasks.db'
const DB_DIR = BaseDirectory.AppData

function taskRowToTask(row: any): Task {
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

function entryRowToTaskEntry(row: any): TaskEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    content: row.content,
    type: row.type as 'body' | 'log',
    createdAt: row.created_at,
  }
}

function sessionRowToWorkSession(row: any): WorkSession {
  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export class EmbeddedApiProvider implements ApiInterface {
  private db: Database | null = null
  private initPromise: Promise<void> | null = null

  private async ensureDb(): Promise<Database> {
    if (this.db) return this.db
    if (this.initPromise) {
      await this.initPromise
      return this.db!
    }

    this.initPromise = (async () => {
      const SQL = await initSqlJs({
        locateFile: (f: string) => f === 'sql-wasm.wasm' ? '/sql-wasm.wasm' : f,
      })

      let dbBuffer: Uint8Array | null = null
      try {
        dbBuffer = await readFile(DB_FILENAME, { baseDir: DB_DIR })
      } catch {
        // No existing DB
      }

      this.db = dbBuffer ? new SQL.Database(dbBuffer) : new SQL.Database()

      if (!dbBuffer) {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            type TEXT NOT NULL,
            priority TEXT NOT NULL,
            tags TEXT,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER,
            completed_at INTEGER,
            due_date INTEGER
          )
        `)
        this.db.run(`
          CREATE TABLE IF NOT EXISTS task_entries (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            content TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'log',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id)
          )
        `)
        this.db.run(`
          CREATE TABLE IF NOT EXISTS work_sessions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            FOREIGN KEY (task_id) REFERENCES tasks(id)
          )
        `)
        await this.persist()
      } else {
        // Migration: add updated_at column if missing
        try {
          this.db.run('ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')
          this.db.run('UPDATE tasks SET updated_at = created_at WHERE updated_at = 0')
          await this.persist()
        } catch { /* Column exists or no tasks table */ }
      }
    })()

    await this.initPromise
    return this.db!
  }

  private async persist(): Promise<void> {
    if (!this.db) return
    const data = this.db.export()
    await writeFile(DB_FILENAME, new Uint8Array(data), { baseDir: DB_DIR })
  }

  private queryOne(sql: string, params: any[] = []): any | null {
    const db = this.db!
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const result = stmt.step() ? stmt.getAsObject() : null
    stmt.free()
    return result
  }

  private queryAll(sql: string, params: any[] = []): any[] {
    const db = this.db!
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows: any[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  private run(sql: string, params: any[] = []): void {
    this.db!.run(sql, params)
  }

  private async runAndPersist(sql: string, params: any[] = []): Promise<void> {
    this.run(sql, params)
    await this.persist()
  }

  // --- Tasks ---

  async fetchTodos(type?: string, status?: string): Promise<Task[]> {
    await this.ensureDb()
    let sql = 'SELECT * FROM tasks'
    const conditions: string[] = []
    const params: any[] = []

    if (type) { conditions.push('type = ?'); params.push(type) }
    if (status) {
      const statuses = status.split(',')
      if (statuses.length > 0) {
        const placeholders = statuses.map(() => '?').join(', ')
        conditions.push(`status IN (${placeholders})`)
        params.push(...statuses)
      }
    }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY updated_at DESC'

    return this.queryAll(sql, params).map(taskRowToTask)
  }

  async getTaskById(id: string): Promise<Task | null> {
    await this.ensureDb()
    const row = this.queryOne('SELECT * FROM tasks WHERE id = ?', [id])
    return row ? taskRowToTask(row) : null
  }

  async createTask(data: CreateTaskRequest): Promise<Task> {
    await this.ensureDb()
    const now = Date.now()
    const id = crypto.randomUUID()
    const status = data.status ?? 'PENDING'

    await this.runAndPersist(
      `INSERT INTO tasks (id, title, type, priority, tags, status, created_at, updated_at, started_at, completed_at, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, data.title, data.type, data.priority,
        JSON.stringify(data.tags ?? []),
        status, now, now,
        status === 'DOING' ? now : null,
        null,
        data.dueDate ?? null,
      ]
    )

    if (data.body && data.body.trim()) {
      const entryId = crypto.randomUUID()
      await this.runAndPersist(
        'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
        [entryId, id, data.body.trim(), 'body', now]
      )
    }

    return (await this.getTaskById(id))!
  }

  async updateTask(id: string, data: UpdateTaskRequest): Promise<Task | null> {
    await this.ensureDb()
    const existing = await this.getTaskById(id)
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
        updates.push('started_at = ?'); params.push(Date.now())
      }
      if (data.status === 'DOING' && existing.status === 'DONE') {
        updates.push('completed_at = ?'); params.push(null)
      }
      if (data.status === 'DONE' && existing.status !== 'DONE') {
        updates.push('completed_at = ?'); params.push(Date.now())
      }
    }

    if (updates.length === 0) return existing
    params.push(id)
    await this.runAndPersist(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, params)
    return this.getTaskById(id)
  }

  async deleteTask(id: string): Promise<void> {
    await this.ensureDb()
    await this.runAndPersist('DELETE FROM task_entries WHERE task_id = ?', [id])
    await this.runAndPersist('DELETE FROM tasks WHERE id = ?', [id])
  }

  async markTaskDone(id: string): Promise<Task | null> {
    return this.updateTask(id, { status: 'DONE' })
  }

  // --- Task Entries ---

  async fetchTaskEntries(taskId: string): Promise<TaskEntry[]> {
    await this.ensureDb()
    return this.queryAll(
      'SELECT * FROM task_entries WHERE task_id = ? ORDER BY created_at ASC',
      [taskId]
    ).map(entryRowToTaskEntry)
  }

  async submitTaskEntry(taskId: string, content: string, type: 'body' | 'log' = 'log'): Promise<TaskEntry> {
    await this.ensureDb()
    const task = await this.getTaskById(taskId)
    if (!task) throw new Error('Task not found')

    const id = crypto.randomUUID()
    const now = Date.now()
    await this.runAndPersist(
      'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, taskId, content, type, now]
    )
    return { id, taskId, content, type, createdAt: now }
  }

  async updateTaskEntry(_taskId: string, entryId: string, content: string): Promise<TaskEntry | null> {
    await this.ensureDb()
    const existing = this.queryOne('SELECT * FROM task_entries WHERE id = ?', [entryId])
    if (!existing) return null

    await this.runAndPersist('UPDATE task_entries SET content = ? WHERE id = ?', [content, entryId])
    const updated = this.queryOne('SELECT * FROM task_entries WHERE id = ?', [entryId])
    return updated ? entryRowToTaskEntry(updated) : null
  }

  // --- Work Sessions ---

  async takeOverTask(taskId: string): Promise<WorkSession> {
    await this.ensureDb()
    const task = await this.getTaskById(taskId)
    if (!task) throw new Error('Task not found')

    await this.runAndPersist('UPDATE work_sessions SET ended_at = ? WHERE ended_at IS NULL', [Date.now()])

    const id = crypto.randomUUID()
    const now = Date.now()
    await this.runAndPersist(
      'INSERT INTO work_sessions (id, task_id, started_at, ended_at) VALUES (?, ?, ?, NULL)',
      [id, taskId, now]
    )
    return { id, taskId, startedAt: now, endedAt: null }
  }

  async doAfk(): Promise<void> {
    await this.ensureDb()
    await this.runAndPersist('UPDATE work_sessions SET ended_at = ? WHERE ended_at IS NULL', [Date.now()])
  }

  async getCurrentSession(): Promise<WorkSession | null> {
    await this.ensureDb()
    const row = this.queryOne('SELECT * FROM work_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    return row ? sessionRowToWorkSession(row) : null
  }

  async fetchSessions(start: number, end: number): Promise<WorkSession[]> {
    await this.ensureDb()
    return this.queryAll(
      'SELECT * FROM work_sessions WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC',
      [end, start]
    ).map(sessionRowToWorkSession)
  }

  async dropTask(taskId: string, reason: string): Promise<Task | null> {
    await this.ensureDb()
    const task = await this.getTaskById(taskId)
    if (!task) return null

    await this.runAndPersist('UPDATE work_sessions SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [Date.now(), taskId])
    await this.runAndPersist('UPDATE tasks SET status = ? WHERE id = ?', ['DROPPED', taskId])

    const entryId = crypto.randomUUID()
    await this.runAndPersist(
      'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
      [entryId, taskId, reason, 'log', Date.now()]
    )
    return this.getTaskById(taskId)
  }

  // --- Reports ---

  async fetchTodayTasks(): Promise<Task[]> {
    await this.ensureDb()
    // 1. All unfinished high-priority tasks
    const highPriority = this.queryAll(
      "SELECT * FROM tasks WHERE priority = 'HIGH' AND status IN ('PENDING', 'DOING') ORDER BY updated_at DESC"
    ).map(taskRowToTask)

    // 2. 1 earliest unfinished daily improvement
    const dailyImproveRows = this.queryAll(
      "SELECT * FROM tasks WHERE type = 'DAILY_IMPROVE' AND status IN ('PENDING', 'DOING') ORDER BY created_at ASC LIMIT 1"
    )
    const dailyImprove = dailyImproveRows.length > 0 ? taskRowToTask(dailyImproveRows[0]) : null

    // 3. 1 earliest unfinished to read
    const toReadRows = this.queryAll(
      "SELECT * FROM tasks WHERE type = 'TOREAD' AND status IN ('PENDING', 'DOING') ORDER BY created_at ASC LIMIT 1"
    )
    const toRead = toReadRows.length > 0 ? taskRowToTask(toReadRows[0]) : null

    const ids = new Set(highPriority.map(t => t.id))
    const result = [...highPriority]
    if (dailyImprove && !ids.has(dailyImprove.id)) result.push(dailyImprove)
    if (toRead && !ids.has(toRead.id)) result.push(toRead)

    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async fetchTodayReport(): Promise<{
    totalToday: number
    completedToday: number
    inProgress: number
    tasks: Task[]
  }> {
    await this.ensureDb()
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const ts = startOfDay.getTime()

    const todayResult = this.db!.exec(
      `SELECT * FROM tasks WHERE created_at >= ${ts} ORDER BY created_at DESC`
    )

    const rows: Task[] = todayResult.length > 0 ? todayResult[0].columns.map((_col: string, i: number) => {
      const obj: Record<string, unknown> = {}
      todayResult[0].columns.forEach((c: string, j: number) => { obj[c] = todayResult[0].values[i][j] })
      return obj
    }).map((row: Record<string, unknown>) => taskRowToTask(row)) : []

    const completedResult = this.db!.exec(
      `SELECT COUNT(*) as count FROM tasks WHERE completed_at >= ${ts}`
    )
    const inProgressResult = this.db!.exec(
      `SELECT COUNT(*) as count FROM tasks WHERE status = 'DOING'`
    )

    return {
      totalToday: todayResult.length > 0 ? todayResult[0].values.length : 0,
      completedToday: Number(completedResult[0]?.values[0][0] ?? 0),
      inProgress: Number(inProgressResult[0]?.values[0][0] ?? 0),
      tasks: rows,
    }
  }

  async fetchSummary(): Promise<{
    byType: Record<string, number>
    byPriority: Record<string, number>
    totalTasks: number
  }> {
    await this.ensureDb()
    const result = this.db!.exec('SELECT type, priority FROM tasks')
    const byType: Record<string, number> = {}
    const byPriority: Record<string, number> = {}

    if (result.length > 0) {
      const cols = result[0].columns
      for (const row of result[0].values) {
        const type = row[cols.indexOf('type')] as string
        const priority = row[cols.indexOf('priority')] as string
        byType[type] = (byType[type] || 0) + 1
        byPriority[priority] = (byPriority[priority] || 0) + 1
      }
    }

    return {
      byType,
      byPriority,
      totalTasks: result.length > 0 ? result[0].values.length : 0,
    }
  }

  async fetchRangeStats(start: number, end: number): Promise<{
    total: number
    completed: number
    inProgress: number
  }> {
    await this.ensureDb()
    const totalResult = this.db!.exec(
      `SELECT COUNT(*) as count FROM tasks WHERE created_at >= ${start} AND created_at <= ${end}`
    )
    const completedResult = this.db!.exec(
      `SELECT COUNT(*) as count FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ${start} AND completed_at <= ${end}`
    )
    const inProgressResult = this.db!.exec(
      `SELECT COUNT(DISTINCT t.id) as count FROM tasks t INNER JOIN work_sessions ws ON ws.task_id = t.id WHERE ws.started_at >= ${start} AND ws.started_at <= ${end} AND t.status != 'DONE' AND t.status != 'DROPPED'`
    )
    return {
      total: totalResult.length > 0 ? Number(totalResult[0].values[0][0]) : 0,
      completed: completedResult.length > 0 ? Number(completedResult[0].values[0][0]) : 0,
      inProgress: inProgressResult.length > 0 ? Number(inProgressResult[0].values[0][0]) : 0,
    }
  }

  async searchTasks(query: string, _limit = 50): Promise<{
    results: SearchResult[]
    tokens: string[]
    total: number
  }> {
    await this.ensureDb()
    const trimmed = query.trim()
    if (!trimmed) return { results: [], tokens: [], total: 0 }

    const like = `%${trimmed}%`
    const tasks = this.queryAll(
      'SELECT id, title, type, status, tags FROM tasks WHERE title LIKE ? OR tags LIKE ?',
      [like, like]
    ).map((row: any) => ({
      taskId: row.id,
      taskTitle: row.title,
      taskType: row.type as TaskType,
      taskStatus: row.status as TaskStatus,
      taskTags: row.tags ? JSON.parse(row.tags) : [],
      matchType: 'task' as const,
      matchedContent: '',
      originalTitle: row.title,
      matchedOriginal: '',
      tokens: [trimmed],
      exactMatch: true,
      rank: 0,
    }))

    const entries = this.queryAll(
      'SELECT task_id, content, type FROM task_entries WHERE content LIKE ?',
      [like]
    ).map((row: any) => ({
      taskId: row.task_id,
      taskTitle: '',
      taskType: 'TODO' as TaskType,
      taskStatus: 'PENDING' as TaskStatus,
      taskTags: [] as string[],
      matchType: (row.type === 'body' ? 'entry_body' : 'entry_log') as SearchResult['matchType'],
      matchedContent: row.content,
      originalTitle: '',
      matchedOriginal: row.content,
      tokens: [trimmed],
      exactMatch: false,
      rank: 1,
    }))

    const taskMap = new Map<string, SearchResult>()
    for (const t of tasks) taskMap.set(t.taskId, t)
    for (const e of entries) {
      if (!taskMap.has(e.taskId)) {
        taskMap.set(e.taskId, e as unknown as SearchResult)
      }
    }

    const results = [...taskMap.values()]
    return { results, tokens: [trimmed], total: results.length }
  }

  // --- Task Extra Info (stub: in-memory store) ---
  private extraInfoStore: Map<string, Map<string, string>> = new Map()

  async getTaskExtraInfo(taskId: string): Promise<TaskExtraInfo[]> {
    const map = this.extraInfoStore.get(taskId)
    if (!map) return []
    return [...map.entries()].map(([key, value]) => ({ taskId, key, value }))
  }

  async getTaskExtraInfoValue(taskId: string, key: string): Promise<string | null> {
    return this.extraInfoStore.get(taskId)?.get(key) ?? null
  }

  async setTaskExtraInfo(taskId: string, key: string, value: string): Promise<TaskExtraInfo> {
    if (!this.extraInfoStore.has(taskId)) this.extraInfoStore.set(taskId, new Map())
    this.extraInfoStore.get(taskId)!.set(key, value)
    return { taskId, key, value }
  }

  async deleteTaskExtraInfo(taskId: string, key: string): Promise<boolean> {
    const map = this.extraInfoStore.get(taskId)
    if (!map) return false
    return map.delete(key)
  }

  // --- AFK Events (stub: in-memory store) ---
  private afkEvents: AfkEvent[] = []

  async createAfkEvent(reason: string, triggeredAt: number): Promise<AfkEvent> {
    const event: AfkEvent = {
      id: crypto.randomUUID(),
      triggeredAt,
      reason,
      userNote: null,
      submittedAt: null,
    }
    this.afkEvents.push(event)
    return event
  }

  async updateAfkEvent(id: string, userNote: string): Promise<AfkEvent | null> {
    const event = this.afkEvents.find(e => e.id === id)
    if (!event) return null
    event.userNote = userNote
    event.submittedAt = Date.now()
    return event
  }

  async getAfkEvents(start?: number, end?: number): Promise<AfkEvent[]> {
    let events = [...this.afkEvents]
    if (start !== undefined && end !== undefined) {
      events = events.filter(e => e.triggeredAt >= start && e.triggeredAt <= end)
    }
    return events.sort((a, b) => b.triggeredAt - a.triggeredAt)
  }
}

export const embeddedApi = new EmbeddedApiProvider()
