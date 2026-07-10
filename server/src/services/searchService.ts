import { getDb } from '../db'
import { tokenize } from './tokenizer'
import { htmlToPlainText } from './searchText'
import { sourceForEntryType, entryTypeForSource, type EntrySource } from './searchIndexService'

// --- Types (backward compatible) ---

export type { EntrySource } from './searchIndexService'

export interface SearchResult {
  taskId: string
  entryId?: string | null
  taskTitle: string
  taskType: string
  taskStatus: string
  taskTags: string[]
  matchType: 'task' | EntrySource
  matchedContent: string
  originalTitle: string
  matchedOriginal: string
  tokens: string[]
  exactMatch: boolean
  rank: number
}

export interface SearchResponse {
  results: SearchResult[]
  tokens: string[]
}

export interface NoteSearchResult {
  kind: 'note'
  noteId: string
  title: string
  tags: string[]
  snippet: string
  matchedSource: 'note_title' | 'note_content' | 'note_tags'
  updatedAt: number
  pinned: boolean
  tokens: string[]
  exactMatch: boolean
  rank: number
}

export interface SearchCounts {
  tasks: number
  taskEntries: number
  notes: number
}

interface RawHit {
  docKey: string
  kind: 'task' | 'task_entry' | 'note'
  taskId: string | null
  entryId: string | null
  noteId: string | null
  source: string
  identifierText: string
  titleText: string
  contentText: string
  tagsJson: string
  updatedAt: number
  bm25: number
  exactFtsHit: boolean
  prefixOnly: boolean
  phraseFtsHit: boolean
  taskTitle: string | null
  taskType: string | null
  taskStatus: string | null
  taskTags: string | null
  noteArchived: number | null
  notePinned: number | null
}

// --- FTS query builder ---

function escapeFtsToken(token: string): string {
  return token.replace(/"/g, '')
}

function buildFtsQueries(tokens: string[]): { exact: string; prefix: string; phrase: string } {
  const escaped = tokens.map(escapeFtsToken)
  const exact = escaped.map((t) => `"${t}"`).join(' ')
  const phrase = escaped.length > 1 ? `"${escaped.join(' ')}"` : ''
  let prefix = ''
  if (escaped.length === 1) {
    if (escaped[0].length >= 2) prefix = `"${escaped[0]}"*`
  } else {
    const last = escaped[escaped.length - 1]
    if (last.length >= 2) {
      prefix = [...escaped.slice(0, -1).map((t) => `"${t}"`), `"${last}"*`].join(' ')
    }
  }
  return { exact, prefix, phrase }
}

// --- Scope filter ---

function buildScopeSql(scope: 'tasks' | 'notes' | 'all', includeArchived: boolean): { join: string; where: string } {
  const join = 'LEFT JOIN notes n ON d.kind = \'note\' AND n.id = d.note_id'
  let where: string
  if (scope === 'tasks') {
    where = "AND d.kind IN ('task', 'task_entry')"
  } else if (scope === 'notes') {
    where = includeArchived
      ? "AND d.kind = 'note'"
      : "AND d.kind = 'note' AND COALESCE(n.archived, 0) = 0"
  } else {
    where = includeArchived
      ? ''
      : "AND (d.kind != 'note' OR COALESCE(n.archived, 0) = 0)"
  }
  return { join, where }
}

// --- Core search ---

function runFtsQuery(
  ftsQuery: string,
  scopeWhere: string,
  scopeJoin: string,
  limit: number,
  hitType: 'exact' | 'prefix' | 'phrase',
  oneHitPerTask: boolean,
): Map<string, RawHit> {
  if (!ftsQuery.trim()) return new Map()
  const db = getDb()
  const baseQuery = `
    SELECT
      d.doc_key, d.kind, d.task_id, d.entry_id, d.note_id, d.source,
      d.identifier_text, d.title_text, d.content_text, d.tags_json, d.updated_at,
      bm25(search_fts, 0, 8, 5, 1, 3) as score,
      t.title as task_title, t.type as task_type, t.status as task_status, t.tags as task_tags,
      n.archived as note_archived, n.pinned as note_pinned
    FROM search_fts f
    JOIN search_documents d ON d.doc_key = f.doc_key
    LEFT JOIN tasks t ON d.task_id = t.id
    ${scopeJoin}
    WHERE f.search_fts MATCH ?
    ${scopeWhere}
  `
  // Board search presents one result per task. Deduplicate before applying the
  // candidate limit so a task with many matching entries cannot crowd out others.
  const query = oneHitPerTask
    ? `WITH matches AS (${baseQuery})
       SELECT * FROM (
         SELECT matches.*, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY score) AS task_rank
         FROM matches
       )
       WHERE task_rank = 1
       ORDER BY score
       LIMIT ?`
    : `${baseQuery} ORDER BY score LIMIT ?`
  const rows = db.prepare(query).all(ftsQuery, limit) as Array<any>

  const hits = new Map<string, RawHit>()
  for (const row of rows) {
    const existing = hits.get(row.doc_key)
    if (existing) {
      if (hitType === 'exact') {
        existing.exactFtsHit = true
        existing.prefixOnly = false
      } else if (hitType === 'prefix' && !existing.exactFtsHit) {
        existing.prefixOnly = true
      } else if (hitType === 'phrase') {
        existing.phraseFtsHit = true
      }
      continue
    }
    hits.set(row.doc_key, {
      docKey: row.doc_key,
      kind: row.kind,
      taskId: row.task_id,
      entryId: row.entry_id,
      noteId: row.note_id,
      source: row.source,
      identifierText: row.identifier_text || '',
      titleText: row.title_text || '',
      contentText: row.content_text || '',
      tagsJson: row.tags_json || '[]',
      updatedAt: row.updated_at,
      bm25: row.score,
      exactFtsHit: hitType === 'exact',
      prefixOnly: hitType === 'prefix',
      phraseFtsHit: hitType === 'phrase',
      taskTitle: row.task_title,
      taskType: row.task_type,
      taskStatus: row.task_status,
      taskTags: row.task_tags,
      noteArchived: row.note_archived,
      notePinned: row.note_pinned,
    })
  }
  return hits
}

function generateSnippet(titleText: string, contentText: string, query: string, tokens: string[], maxLen = 240): string {
  const normalizedQuery = query.toLowerCase()
  const sources = [titleText, contentText]
  let bestIdx = -1
  let bestPos = -1
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i].toLowerCase()
    const pos = src.indexOf(normalizedQuery)
    if (pos >= 0) {
      bestIdx = i
      bestPos = pos
      break
    }
  }
  if (bestIdx < 0) {
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i].toLowerCase()
      for (const token of tokens) {
        const pos = src.indexOf(token.toLowerCase())
        if (pos >= 0) {
          bestIdx = i
          bestPos = pos
          break
        }
      }
      if (bestIdx >= 0) break
    }
  }
  if (bestIdx < 0) return contentText.slice(0, maxLen)
  const source = sources[bestIdx]
  const halfLen = Math.floor(maxLen / 2)
  const start = Math.max(0, bestPos - halfLen)
  const end = Math.min(source.length, start + maxLen)
  let snippet = source.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < source.length) snippet = snippet + '...'
  return snippet
}

interface RankedHit extends RawHit {
  identifierExact: boolean
  fieldExactPhrase: boolean
  titleExactPhrase: boolean
  titleHasAllTokens: boolean
  tagExact: boolean
  contentExactPhrase: boolean
  snippet: string
  rank: number
}

function rankHits(
  allHits: Map<string, RawHit>,
  query: string,
  tokens: string[],
): RankedHit[] {
  const normalizedQuery = query.toLowerCase()
  const lowerTokens = tokens.map((t) => t.toLowerCase())
  const isMultiToken = tokens.length > 1
  const ranked: RankedHit[] = []

  for (const hit of allHits.values()) {
    const identifierExact = hit.identifierText.toLowerCase() === normalizedQuery
    const titleExactPhrase = hit.titleText.toLowerCase().includes(normalizedQuery)
    const contentExactPhrase = hit.contentText.toLowerCase().includes(normalizedQuery)
    const fieldExactPhrase = isMultiToken && (titleExactPhrase || contentExactPhrase)

    const titleLower = hit.titleText.toLowerCase()
    const titleHasAllTokens = lowerTokens.length > 0 && lowerTokens.every((t) => titleLower.includes(t))

    const tags: string[] = JSON.parse(hit.tagsJson || '[]')
    const tagExact = tags.some((t) => t.toLowerCase() === normalizedQuery)

    const snippet = generateSnippet(hit.titleText, hit.contentText, query, tokens)

    const exactMatch = identifierExact || fieldExactPhrase

    ranked.push({
      ...hit,
      identifierExact,
      fieldExactPhrase,
      titleExactPhrase,
      titleHasAllTokens,
      tagExact,
      contentExactPhrase,
      snippet,
      rank: 0,
    })
  }

  ranked.sort((a, b) => {
    if (a.identifierExact !== b.identifierExact) return a.identifierExact ? -1 : 1
    if (a.fieldExactPhrase !== b.fieldExactPhrase) return a.fieldExactPhrase ? -1 : 1
    if (a.phraseFtsHit !== b.phraseFtsHit) return a.phraseFtsHit ? -1 : 1
    if (a.titleExactPhrase !== b.titleExactPhrase) return a.titleExactPhrase ? -1 : 1
    if (a.exactFtsHit !== b.exactFtsHit) return a.exactFtsHit ? -1 : 1
    if (a.titleHasAllTokens !== b.titleHasAllTokens) return a.titleHasAllTokens ? -1 : 1
    if (a.tagExact !== b.tagExact) return a.tagExact ? -1 : 1
    if (a.contentExactPhrase !== b.contentExactPhrase) return a.contentExactPhrase ? -1 : 1
    if (a.bm25 !== b.bm25) return a.bm25 - b.bm25
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    return a.docKey.localeCompare(b.docKey)
  })

  ranked.forEach((hit, i) => { hit.rank = i })
  return ranked
}

function searchCore(
  query: string,
  scope: 'tasks' | 'notes' | 'all',
  limit: number,
  includeArchived: boolean,
  oneHitPerTask = false,
): { hits: RankedHit[]; tokens: string[]; counts: SearchCounts; total: number } {
  const trimmed = query.trim()
  if (!trimmed) return { hits: [], tokens: [], counts: { tasks: 0, taskEntries: 0, notes: 0 }, total: 0 }

  const tokens = tokenize(trimmed).split(' ').filter(Boolean)
  if (tokens.length === 0) return { hits: [], tokens: [], counts: { tasks: 0, taskEntries: 0, notes: 0 }, total: 0 }

  const { exact, prefix, phrase } = buildFtsQueries(tokens)
  const { join: scopeJoin, where: scopeWhere } = buildScopeSql(scope, includeArchived)
  const candidateLimit = Math.min(limit * 4, 400)

  const allHits = new Map<string, RawHit>()

  const exactHits = runFtsQuery(exact, scopeWhere, scopeJoin, candidateLimit, 'exact', oneHitPerTask)
  for (const [key, hit] of exactHits) allHits.set(key, hit)

  if (phrase) {
    const phraseHits = runFtsQuery(phrase, scopeWhere, scopeJoin, candidateLimit, 'phrase', oneHitPerTask)
    for (const [key, hit] of phraseHits) {
      const existing = allHits.get(key)
      if (existing) {
        existing.phraseFtsHit = true
      } else {
        allHits.set(key, hit)
      }
    }
  }

  if (prefix) {
    const prefixHits = runFtsQuery(prefix, scopeWhere, scopeJoin, candidateLimit, 'prefix', oneHitPerTask)
    for (const [key, hit] of prefixHits) {
      if (!allHits.has(key)) allHits.set(key, hit)
    }
  }

  const ranked = rankHits(allHits, trimmed, tokens)

  let counts: SearchCounts = { tasks: 0, taskEntries: 0, notes: 0 }
  for (const hit of ranked) {
    if (hit.kind === 'task') counts.tasks++
    else if (hit.kind === 'task_entry') counts.taskEntries++
    else counts.notes++
  }
  const total = ranked.length

  return { hits: ranked, tokens, counts, total }
}

// --- Adapters ---

function hitToSearchResult(hit: RankedHit, tokens: string[], parentTitle: string): SearchResult {
  const taskTags: string[] = hit.taskTags ? JSON.parse(hit.taskTags || '[]') : []
  return {
    taskId: hit.taskId || '',
    entryId: hit.entryId,
    taskTitle: parentTitle || hit.titleText || hit.taskTitle || '',
    taskType: hit.taskType || '',
    taskStatus: hit.taskStatus || '',
    taskTags,
    matchType: hit.kind === 'task' ? 'task' : (hit.source as EntrySource),
    matchedContent: hit.contentText,
    originalTitle: parentTitle || hit.taskTitle || '',
    matchedOriginal: hit.contentText,
    tokens,
    exactMatch: hit.identifierExact || hit.fieldExactPhrase,
    rank: hit.rank,
  }
}

function hitToNoteSearchResult(hit: RankedHit, tokens: string[]): NoteSearchResult {
  const tags: string[] = JSON.parse(hit.tagsJson || '[]')
  const normalizedQuery = tokens.join(' ').toLowerCase()
  let matchedSource: 'note_title' | 'note_content' | 'note_tags' = 'note_content'
  if (hit.titleText.toLowerCase().includes(normalizedQuery) || hit.titleText.toLowerCase().includes(tokens[0]?.toLowerCase() || '')) {
    matchedSource = 'note_title'
  } else if (tags.some((t) => t.toLowerCase().includes(normalizedQuery))) {
    matchedSource = 'note_tags'
  }
  return {
    kind: 'note',
    noteId: hit.noteId || '',
    title: hit.titleText,
    tags,
    snippet: hit.snippet,
    matchedSource,
    updatedAt: hit.updatedAt,
    pinned: Boolean(hit.notePinned),
    tokens,
    exactMatch: hit.identifierExact || hit.fieldExactPhrase,
    rank: hit.rank,
  }
}

// --- Public API (backward compatible signatures) ---

export function searchTasks(query: string, limit = 50): SearchResponse {
  const { hits, tokens } = searchCore(query, 'tasks', limit, false, true)
  const safeLimit = Math.min(Math.max(limit, 1), 200)

  const byTask = new Map<string, { best: RankedHit; count: number }>()
  for (const hit of hits) {
    const taskId = hit.taskId || ''
    if (!taskId) continue
    const existing = byTask.get(taskId)
    if (existing) {
      existing.count++
      if (hit.rank < existing.best.rank) existing.best = hit
    } else {
      byTask.set(taskId, { best: hit, count: 1 })
    }
  }

  const sortedTasks = [...byTask.values()].sort((a, b) => a.best.rank - b.best.rank)
  const results: SearchResult[] = []
  for (const { best, count } of sortedTasks.slice(0, safeLimit)) {
    const parentTitle = best.taskTitle || best.titleText || ''
    const result = hitToSearchResult(best, tokens, parentTitle)
    if (count > 1) {
      (result as any).matchCount = count
    }
    results.push(result)
  }

  return { results, tokens }
}

export function searchNotes(query: string, limit = 50, includeArchived = false): { results: NoteSearchResult[]; tokens: string[] } {
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const { hits, tokens } = searchCore(query, 'notes', safeLimit, includeArchived)
  const results = hits.map((hit) => hitToNoteSearchResult(hit, tokens))
  return { results, tokens }
}

export function searchAll(query: string, limit = 50, includeArchived = false): {
  results: {
    tasks: Array<SearchResult & { kind: 'task' }>
    taskEntries: Array<SearchResult & { kind: 'task_entry' }>
    notes: NoteSearchResult[]
  }
  tokens: string[]
  counts: SearchCounts
  total: number
} {
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const { hits, tokens, counts, total } = searchCore(query, 'all', safeLimit, includeArchived)

  const topHits = hits.slice(0, safeLimit)
  const tasks: Array<SearchResult & { kind: 'task' }> = []
  const taskEntries: Array<SearchResult & { kind: 'task_entry' }> = []
  const notes: NoteSearchResult[] = []

  for (const hit of topHits) {
    if (hit.kind === 'task') {
      const parentTitle = hit.taskTitle || hit.titleText || ''
      tasks.push({ ...hitToSearchResult(hit, tokens, parentTitle), kind: 'task' })
    } else if (hit.kind === 'task_entry') {
      const parentTitle = hit.taskTitle || ''
      taskEntries.push({ ...hitToSearchResult(hit, tokens, parentTitle), kind: 'task_entry' })
    } else {
      notes.push(hitToNoteSearchResult(hit, tokens))
    }
  }

  return { results: { tasks, taskEntries, notes }, tokens, counts, total }
}
