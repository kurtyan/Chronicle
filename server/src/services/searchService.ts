import { getDb } from '../db'
import { tokenize } from './tokenizer'

// --- Index write operations ---

export function indexTask(taskId: string, title: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks_fts WHERE task_id = ? AND source = ?').run(taskId, 'task')
  db.prepare('INSERT INTO tasks_fts(task_id, source, content) VALUES (?, ?, ?)').run(
    taskId, 'task', tokenize(title)
  )
}

export function indexEntry(taskId: string, _entryId: string, content: string, type: 'body' | 'log'): void {
  const db = getDb()
  const source = type === 'body' ? 'entry_body' : 'entry_log'
  db.prepare('DELETE FROM tasks_fts WHERE task_id = ? AND source = ?').run(taskId, source)
  db.prepare('INSERT INTO tasks_fts(task_id, source, content) VALUES (?, ?, ?)').run(
    taskId, source, tokenize(content)
  )
}

export function removeTaskFromIndex(taskId: string): void {
  getDb().prepare('DELETE FROM tasks_fts WHERE task_id = ?').run(taskId)
}

export function removeEntryFromIndex(taskId: string, type: 'body' | 'log'): void {
  const source = type === 'body' ? 'entry_body' : 'entry_log'
  getDb().prepare('DELETE FROM tasks_fts WHERE task_id = ? AND source = ?').run(taskId, source)
}

// --- Populate FTS index from existing data ---

export function populateFtsIndex(): void {
  const db = getDb()
  const exists = db.prepare("SELECT COUNT(*) as cnt FROM tasks_fts WHERE source = 'task'").get() as { cnt: number }
  if (exists.cnt > 0) return

  db.prepare('BEGIN').run()

  const tasks = db.prepare('SELECT id, title FROM tasks').all() as Array<{ id: string; title: string }>
  for (const t of tasks) {
    db.prepare('INSERT INTO tasks_fts(task_id, source, content) VALUES (?, ?, ?)').run(
      t.id, 'task', tokenize(t.title)
    )
  }

  const entries = db.prepare('SELECT task_id, type, content FROM task_entries').all() as Array<{ task_id: string; type: string; content: string }>
  for (const e of entries) {
    const source = e.type === 'body' ? 'entry_body' : 'entry_log'
    db.prepare('INSERT INTO tasks_fts(task_id, source, content) VALUES (?, ?, ?)').run(
      e.task_id, source, tokenize(e.content)
    )
  }

  db.prepare('COMMIT').run()
}

// --- Rebuild FTS index from scratch (use after tokenizer changes) ---

export function rebuildFtsIndex(): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks_fts').run()

  db.prepare('BEGIN').run()

  const tasks = db.prepare('SELECT id, title FROM tasks').all() as Array<{ id: string; title: string }>
  for (const t of tasks) {
    db.prepare('INSERT INTO tasks_fts(task_id, source, content) VALUES (?, ?, ?)').run(
      t.id, 'task', tokenize(t.title)
    )
  }

  const entries = db.prepare('SELECT task_id, type, content FROM task_entries').all() as Array<{ task_id: string; type: string; content: string }>
  for (const e of entries) {
    const source = e.type === 'body' ? 'entry_body' : 'entry_log'
    db.prepare('INSERT INTO tasks_fts(task_id, source, content) VALUES (?, ?, ?)').run(
      e.task_id, source, tokenize(e.content)
    )
  }

  db.prepare('COMMIT').run()
}

// --- Search query ---

export interface SearchResult {
  taskId: string
  taskTitle: string
  taskType: string
  taskStatus: string
  taskTags: string[]
  matchType: 'task' | 'entry_body' | 'entry_log'
  matchedContent: string
  // Original text for highlighting
  originalTitle: string
  matchedOriginal: string
  // Tokens from the query for highlighting
  tokens: string[]
  rank: number
}

export interface SearchResponse {
  results: SearchResult[]
  tokens: string[]
}

export function searchTasks(query: string, limit = 50): SearchResponse {
  const trimmed = query.trim()
  if (!trimmed) return { results: [], tokens: [] }

  const db = getDb()

  const tokenized = tokenize(trimmed)
  const tokens = tokenized.split(' ').filter(Boolean)

  // FTS5 MATCH with unicode61 tokenizer (pre-tokenized by nodejieba)
  const ftsResults = db.prepare(`
    SELECT f.task_id, f.source, f.content, f.rank
    FROM tasks_fts f
    WHERE tasks_fts MATCH ?
    ORDER BY f.rank
    LIMIT ?
  `).all(tokenized, limit) as Array<{
    task_id: string
    source: string
    content: string
    rank: number
  }>

  if (ftsResults.length === 0) {
    // Tag fallback even for empty FTS results
    const tagMatches = db.prepare(
      `SELECT id, title, type, status, tags FROM tasks WHERE tags LIKE ?`
    ).all(`%${trimmed}%`) as Array<{
      id: string
      title: string
      type: string
      status: string
      tags: string
    }>
    if (tagMatches.length > 0) {
      const results = tagMatches.map(t => ({
        taskId: t.id,
        taskTitle: t.title,
        taskType: t.type,
        taskStatus: t.status,
        taskTags: JSON.parse(t.tags || '[]'),
        matchType: 'task' as const,
        matchedContent: '',
        originalTitle: t.title,
        matchedOriginal: '',
        tokens,
        rank: 0.5,
      }))
      return { results, tokens }
    }
    return { results: [], tokens }
  }

  const taskIds = [...new Set(ftsResults.map(r => r.task_id))]
  const placeholders = taskIds.map(() => '?').join(', ')
  const tasks = db.prepare(
    `SELECT id, title, type, status, tags FROM tasks WHERE id IN (${placeholders})`
  ).all(...taskIds) as Array<{
    id: string
    title: string
    type: string
    status: string
    tags: string
  }>

  const taskMap = new Map(tasks.map(t => [t.id, t]))

  // Tag fallback
  const tagMatches = db.prepare(
    `SELECT id, title, type, status, tags FROM tasks WHERE tags LIKE ?`
  ).all(`%${trimmed}%`) as typeof tasks

  for (const tm of tagMatches) {
    if (!taskMap.has(tm.id)) {
      taskMap.set(tm.id, tm)
      ftsResults.push({ task_id: tm.id, source: 'task', content: '', rank: 0.5 })
    }
  }

  // Fetch original entry content for highlighting
  const entryResultIds = ftsResults.filter(r => r.source !== 'task').map(r => r.task_id)
  let entryOriginalMap = new Map<string, string>()
  if (entryResultIds.length > 0) {
    const entryPlaceholders = entryResultIds.map(() => '?').join(', ')
    // Need to match by task_id AND source type
    const entries = db.prepare(`
      SELECT task_id, type, content FROM task_entries WHERE task_id IN (${entryPlaceholders})
    `).all(...entryResultIds) as Array<{ task_id: string; type: string; content: string }>
    // Since we can have multiple entries per task, we'll look up by task_id + type
    for (const f of ftsResults) {
      if (f.source === 'task') continue
      const entryType = f.source === 'entry_body' ? 'body' : 'log'
      const entry = entries.find(e => e.task_id === f.task_id && e.type === entryType)
      if (entry) entryOriginalMap.set(f.task_id + ':' + f.source, entry.content)
    }
  }

  // De-duplicate: keep highest-ranked match per task, enrich with original text
  const bestPerTask = new Map<string, SearchResult>()
  for (const f of ftsResults) {
    const task = taskMap.get(f.task_id)
    if (!task) continue

    const matchedOrig = f.source === 'task' ? '' : (entryOriginalMap.get(f.task_id + ':' + f.source) || '')

    const result: SearchResult = {
      taskId: f.task_id,
      taskTitle: task.title,
      taskType: task.type,
      taskStatus: task.status,
      taskTags: JSON.parse(task.tags || '[]'),
      matchType: f.source === 'task' ? 'task' : f.source === 'entry_body' ? 'entry_body' : 'entry_log',
      matchedContent: f.source === 'task' ? '' : f.content,
      originalTitle: task.title,
      matchedOriginal: matchedOrig,
      tokens,
      rank: f.rank,
    }

    const existing = bestPerTask.get(result.taskId)
    if (!existing || result.rank < existing.rank) {
      bestPerTask.set(result.taskId, result)
    }
  }

  return { results: [...bestPerTask.values()].sort((a, b) => a.rank - b.rank), tokens }
}
