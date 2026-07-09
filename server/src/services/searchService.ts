import { getDb } from '../db'
import { tokenize } from './tokenizer'
import { htmlToPlainText } from './searchText'

// --- Index write operations ---

type EntryType = 'body' | 'log' | 'pinned'
type EntrySource = 'entry_body' | 'entry_log' | 'entry_pinned'

function sourceForEntryType(type: string): EntrySource {
  if (type === 'body') return 'entry_body'
  if (type === 'pinned') return 'entry_pinned'
  return 'entry_log'
}

function entryTypeForSource(source: string): EntryType {
  if (source === 'entry_body') return 'body'
  if (source === 'entry_pinned') return 'pinned'
  return 'log'
}

export function indexTask(taskId: string, title: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks_fts WHERE task_id = ? AND source = ?').run(taskId, 'task')
  db.prepare('INSERT INTO tasks_fts(task_id, entry_id, source, content) VALUES (?, ?, ?, ?)').run(
    taskId, null, 'task', tokenize(`${taskId} ${title}`)
  )
}

export function indexEntry(taskId: string, entryId: string, content: string, type: EntryType): void {
  const db = getDb()
  const source = sourceForEntryType(type)
  db.prepare('DELETE FROM tasks_fts WHERE entry_id = ?').run(entryId)
  db.prepare('INSERT INTO tasks_fts(task_id, entry_id, source, content) VALUES (?, ?, ?, ?)').run(
    taskId, entryId, source, tokenize(htmlToPlainText(content))
  )
}

export function removeTaskFromIndex(taskId: string): void {
  getDb().prepare('DELETE FROM tasks_fts WHERE task_id = ?').run(taskId)
}

export function removeEntryFromIndex(entryId: string): void {
  getDb().prepare('DELETE FROM tasks_fts WHERE entry_id = ?').run(entryId)
}

// --- Populate FTS index from existing data ---

export function populateFtsIndex(): void {
  const db = getDb()
  const exists = db.prepare("SELECT COUNT(*) as cnt FROM tasks_fts WHERE source = 'task'").get() as { cnt: number }
  if (exists.cnt > 0) return

  db.prepare('BEGIN').run()

  const tasks = db.prepare('SELECT id, title FROM tasks').all() as Array<{ id: string; title: string }>
  for (const t of tasks) {
    db.prepare('INSERT INTO tasks_fts(task_id, entry_id, source, content) VALUES (?, ?, ?, ?)').run(
      t.id, null, 'task', tokenize(`${t.id} ${t.title}`)
    )
  }

  const entries = db.prepare('SELECT id, task_id, type, content FROM task_entries').all() as Array<{ id: string; task_id: string; type: string; content: string }>
  for (const e of entries) {
    const source = sourceForEntryType(e.type)
    db.prepare('INSERT INTO tasks_fts(task_id, entry_id, source, content) VALUES (?, ?, ?, ?)').run(
      e.task_id, e.id, source, tokenize(htmlToPlainText(e.content))
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
    db.prepare('INSERT INTO tasks_fts(task_id, entry_id, source, content) VALUES (?, ?, ?, ?)').run(
      t.id, null, 'task', tokenize(`${t.id} ${t.title}`)
    )
  }

  const entries = db.prepare('SELECT id, task_id, type, content FROM task_entries').all() as Array<{ id: string; task_id: string; type: string; content: string }>
  for (const e of entries) {
    const source = sourceForEntryType(e.type)
    db.prepare('INSERT INTO tasks_fts(task_id, entry_id, source, content) VALUES (?, ?, ?, ?)').run(
      e.task_id, e.id, source, tokenize(htmlToPlainText(e.content))
    )
  }

  db.prepare('COMMIT').run()
}

// --- Search query ---

export interface SearchResult {
  taskId: string
  entryId?: string | null
  taskTitle: string
  taskType: string
  taskStatus: string
  taskTags: string[]
  matchType: 'task' | EntrySource
  matchedContent: string
  // Original text for highlighting
  originalTitle: string
  matchedOriginal: string
  // Tokens from the query for highlighting
  tokens: string[]
  // Whether this result matched via exact phrase match
  exactMatch: boolean
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
  const shortAsciiQuery = /^[a-z0-9]{1,2}$/i.test(trimmed)

  // Escape tokens for FTS5: wrap each token in double quotes so special chars (., :, /) are treated literally
  const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' ')

  // --- Phase 1: FTS5 tokenized search ---
  const ftsResults = ftsQuery.trim()
    ? db.prepare(`
    SELECT f.task_id, f.entry_id, f.source, f.content, f.rank
    FROM tasks_fts f
    WHERE tasks_fts MATCH ?
    ORDER BY f.rank
    LIMIT ?
  `).all(ftsQuery, limit) as Array<{
    task_id: string
    entry_id: string | null
    source: string
    content: string
    rank: number
  }>
    : []

  // --- Phase 2: Exact phrase match (LIKE) on original text ---
  const exactTaskIds = new Set<string>()
  const exactResults: Array<{
    task_id: string
    entry_id: string | null
    source: 'task' | EntrySource
    content: string
    rank: number
  }> = []

  function addFallbackResult(result: {
    task_id: string
    entry_id: string | null
    source: 'task' | EntrySource
    content: string
    rank: number
  }) {
    const key = `${result.task_id}:${result.entry_id ?? result.source}`
    if (exactResults.some((existing) => `${existing.task_id}:${existing.entry_id ?? existing.source}` === key)) return
    exactResults.push(result)
  }

  if (!shortAsciiQuery) {
    const normalizedQuery = trimmed.toLowerCase()
    // Match in task titles
    const titleMatches = db.prepare(
      `SELECT id, title FROM tasks`
    ).all() as Array<{ id: string; title: string }>
    for (const m of titleMatches) {
      if (!m.title.toLowerCase().includes(normalizedQuery)) continue
      exactTaskIds.add(m.id)
      addFallbackResult({ task_id: m.id, entry_id: null, source: 'task', content: '', rank: -1.0 })
    }

    // Match in task entries (body + log + plan)
    const entryMatches = db.prepare(
      `SELECT id, task_id, type, content FROM task_entries`
    ).all() as Array<{ id: string; task_id: string; type: string; content: string }>
    for (const m of entryMatches) {
      if (!htmlToPlainText(m.content).toLowerCase().includes(normalizedQuery)) continue
      exactTaskIds.add(m.task_id)
      addFallbackResult({
        task_id: m.task_id,
        entry_id: m.id,
        source: sourceForEntryType(m.type),
        content: m.content,
        rank: -1.0,
      })
    }
  }

  const uniqueTokens = [...new Set(tokens)]
  if (uniqueTokens.length > 1) {
    const titleTokenMatches = db.prepare(
      'SELECT id, title FROM tasks'
    ).all() as Array<{ id: string; title: string }>
    for (const m of titleTokenMatches) {
      const title = m.title.toLowerCase()
      if (!uniqueTokens.every((token) => title.includes(token))) continue
      exactTaskIds.add(m.id)
      addFallbackResult({ task_id: m.id, entry_id: null, source: 'task', content: '', rank: -0.5 })
    }

    const entryTokenMatches = db.prepare(
      'SELECT id, task_id, type, content FROM task_entries'
    ).all() as Array<{ id: string; task_id: string; type: string; content: string }>
    for (const m of entryTokenMatches) {
      const content = htmlToPlainText(m.content).toLowerCase()
      if (!uniqueTokens.every((token) => content.includes(token))) continue
      exactTaskIds.add(m.task_id)
      addFallbackResult({
        task_id: m.task_id,
        entry_id: m.id,
        source: sourceForEntryType(m.type),
        content: m.content,
        rank: -0.5,
      })
    }
  }

  // Combine FTS + exact results (exact matches get rank -1.0 so they sort first)
  const combined = [...ftsResults]
  const ftsTaskIds = new Set(ftsResults.map(r => r.task_id))
  for (const er of exactResults) {
    if (!ftsTaskIds.has(er.task_id)) {
      combined.push(er)
    }
  }

  if (combined.length === 0) {
    // Tag fallback
    const tagMatches = shortAsciiQuery ? [] : db.prepare(
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
        exactMatch: false,
        rank: 0.5,
      }))
      return { results, tokens }
    }
    return { results: [], tokens }
  }

  const taskIds = [...new Set(combined.map(r => r.task_id))]
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
  const tagMatches = shortAsciiQuery ? [] : db.prepare(
    `SELECT id, title, type, status, tags FROM tasks WHERE tags LIKE ?`
  ).all(`%${trimmed}%`) as typeof tasks

  for (const tm of tagMatches) {
    if (!taskMap.has(tm.id)) {
      taskMap.set(tm.id, tm)
      combined.push({ task_id: tm.id, entry_id: null, source: 'task', content: '', rank: 0.5 })
    }
  }

  // Fetch original entry content for highlighting
  const entryResultIds = combined.filter(r => r.source !== 'task' && r.entry_id).map(r => r.entry_id!)
  let entryOriginalMap = new Map<string, string>()
  if (entryResultIds.length > 0) {
    const entryPlaceholders = entryResultIds.map(() => '?').join(', ')
    const entries = db.prepare(`
      SELECT id, content FROM task_entries WHERE id IN (${entryPlaceholders})
    `).all(...entryResultIds) as Array<{ id: string; content: string }>
    for (const entry of entries) {
      entryOriginalMap.set(entry.id, entry.content)
    }
  }

  // De-duplicate: keep highest-ranked match per task, enrich with original text
  const bestPerTask = new Map<string, SearchResult>()
  for (const f of combined) {
    const task = taskMap.get(f.task_id)
    if (!task) continue

    const matchedOrig = f.source === 'task' ? '' : (f.entry_id ? entryOriginalMap.get(f.entry_id) || '' : '')
    const isExact = exactTaskIds.has(f.task_id)

    const result: SearchResult = {
      taskId: f.task_id,
      entryId: f.entry_id,
      taskTitle: task.title,
      taskType: task.type,
      taskStatus: task.status,
      taskTags: JSON.parse(task.tags || '[]'),
      matchType: f.source === 'task' ? 'task' : sourceForEntryType(entryTypeForSource(f.source)),
      matchedContent: f.source === 'task' ? '' : f.content,
      originalTitle: task.title,
      matchedOriginal: matchedOrig,
      tokens,
      exactMatch: isExact,
      rank: f.rank,
    }

    const existing = bestPerTask.get(result.taskId)
    if (!existing || result.rank < existing.rank) {
      bestPerTask.set(result.taskId, result)
    }
  }

  return { results: [...bestPerTask.values()].sort((a, b) => a.rank - b.rank), tokens }
}
