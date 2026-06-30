import crypto from 'crypto'
import { getDb } from '../db'
import { tokenize } from './tokenizer'
import { getTaskById, getTaskEntries, getPinnedEntry, type Task, type TaskEntry } from './taskService'

export interface Note {
  id: string
  title: string
  contentHtml: string
  tags: string[]
  pinned: boolean
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteLink {
  id: string
  noteId: string
  targetType: 'task' | 'task_entry'
  targetId: string
  targetEntryId: string | null
  createdAt: number
  context: string | null
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

function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function rowToNote(row: any): Note {
  return {
    id: row.id,
    title: row.title,
    contentHtml: row.content_html,
    tags: JSON.parse(row.tags || '[]'),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToNoteLink(row: any): NoteLink {
  return {
    id: row.id,
    noteId: row.note_id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetEntryId: row.target_entry_id,
    createdAt: row.created_at,
    context: row.context,
  }
}

function generateNoteId(): string {
  const row = getDb().prepare('SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as maxId FROM notes').get() as { maxId: number | null }
  return `N${String((row.maxId || 0) + 1).padStart(10, '0')}`
}

function indexNote(note: Note): void {
  const db = getDb()
  db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(note.id)
  db.prepare('INSERT INTO notes_fts(note_id, source, content) VALUES (?, ?, ?)').run(note.id, 'note_title', tokenize(note.title))
  db.prepare('INSERT INTO notes_fts(note_id, source, content) VALUES (?, ?, ?)').run(note.id, 'note_content', tokenize(htmlToPlainText(note.contentHtml)))
  if (note.tags.length > 0) {
    db.prepare('INSERT INTO notes_fts(note_id, source, content) VALUES (?, ?, ?)').run(note.id, 'note_tags', tokenize(note.tags.join(' ')))
  }
}

function removeNoteFromIndex(noteId: string): void {
  getDb().prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId)
}

function syncTaskMentionLinks(note: Note): void {
  const mentionIds = new Set<string>()
  const regex = /data-task-id="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(note.contentHtml))) {
    if (match[1]) mentionIds.add(match[1])
  }

  const db = getDb()
  db.prepare("DELETE FROM note_links WHERE note_id = ? AND target_type = 'task' AND context = 'mention'").run(note.id)
  for (const taskId of mentionIds) {
    if (!getTaskById(taskId)) continue
    upsertNoteLink(note.id, 'task', taskId, null, 'mention')
  }
}

export function getNotes(options?: { includeArchived?: boolean; query?: string; limit?: number }): Note[] {
  const includeArchived = Boolean(options?.includeArchived)
  if (options?.query?.trim()) return searchNotes(options.query, options.limit, includeArchived).results.map((result) => getNoteById(result.noteId)).filter((note): note is Note => Boolean(note))
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000)
  const rows = getDb().prepare(`
    SELECT * FROM notes
    ${includeArchived ? '' : 'WHERE archived = 0'}
    ORDER BY pinned DESC, updated_at DESC
    LIMIT ?
  `).all(limit)
  return rows.map(rowToNote)
}

export function getNoteById(id: string): Note | null {
  const row = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id)
  return row ? rowToNote(row) : null
}

export function createNote(data: { title: string; contentHtml?: string; tags?: string[]; linkedTaskIds?: string[] }): Note {
  const now = Date.now()
  const id = generateNoteId()
  const title = data.title.trim() || 'Untitled note'
  const contentHtml = data.contentHtml?.trim() || '<p></p>'
  for (const taskId of data.linkedTaskIds ?? []) {
    if (!getTaskById(taskId)) throw new Error('Task not found')
  }
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO notes(id, title, content_html, tags, pinned, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `).run(id, title, contentHtml, JSON.stringify(data.tags ?? []), now, now)
    const note = getNoteById(id)!
    indexNote(note)
    syncTaskMentionLinks(note)
    for (const taskId of data.linkedTaskIds ?? []) {
      linkNoteToTask(id, taskId, 'created')
    }
  })
  tx()
  return getNoteById(id)!
}

export function updateNote(id: string, data: { title?: string; contentHtml?: string; tags?: string[]; pinned?: boolean; archived?: boolean }): Note | null {
  const existing = getNoteById(id)
  if (!existing) return null

  const updates: string[] = []
  const params: unknown[] = []
  if (data.title !== undefined) {
    updates.push('title = ?')
    params.push(data.title.trim() || 'Untitled note')
  }
  if (data.contentHtml !== undefined) {
    updates.push('content_html = ?')
    params.push(data.contentHtml)
  }
  if (data.tags !== undefined) {
    updates.push('tags = ?')
    params.push(JSON.stringify(data.tags))
  }
  if (data.pinned !== undefined) {
    updates.push('pinned = ?')
    params.push(data.pinned ? 1 : 0)
  }
  if (data.archived !== undefined) {
    updates.push('archived = ?')
    params.push(data.archived ? 1 : 0)
  }
  if (updates.length === 0) return existing
  updates.push('updated_at = ?')
  params.push(Date.now(), id)
  getDb().prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  const note = getNoteById(id)!
  indexNote(note)
  syncTaskMentionLinks(note)
  return note
}

export function archiveNote(id: string, archived = true): Note | null {
  return updateNote(id, { archived })
}

export function deleteNote(id: string): boolean {
  const note = getNoteById(id)
  if (!note) return false
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM note_links WHERE note_id = ?').run(id)
    removeNoteFromIndex(id)
    db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  })
  tx()
  return true
}

function upsertNoteLink(noteId: string, targetType: 'task' | 'task_entry', targetId: string, targetEntryId: string | null, context: string): NoteLink {
  const db = getDb()
  const existing = targetEntryId === null
    ? db.prepare(`
      SELECT * FROM note_links
      WHERE note_id = ? AND target_type = ? AND target_id = ? AND target_entry_id IS NULL
    `).get(noteId, targetType, targetId)
    : db.prepare(`
      SELECT * FROM note_links
      WHERE note_id = ? AND target_type = ? AND target_id = ? AND target_entry_id = ?
    `).get(noteId, targetType, targetId, targetEntryId)

  if (existing) {
    db.prepare('UPDATE note_links SET context = ? WHERE id = ?').run(context, (existing as any).id)
    return rowToNoteLink({ ...(existing as any), context })
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO note_links(id, note_id, target_type, target_id, target_entry_id, created_at, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, noteId, targetType, targetId, targetEntryId, now, context)
  const row = db.prepare('SELECT * FROM note_links WHERE id = ?').get(id)
  return rowToNoteLink(row)
}

export function linkNoteToTask(noteId: string, taskId: string, context = 'manual'): NoteLink {
  if (!getNoteById(noteId)) throw new Error('Note not found')
  if (!getTaskById(taskId)) throw new Error('Task not found')
  return upsertNoteLink(noteId, 'task', taskId, null, context)
}

export function linkNoteToTaskEntry(noteId: string, taskId: string, entryId: string, context = 'entry'): NoteLink {
  if (!getNoteById(noteId)) throw new Error('Note not found')
  if (!getTaskById(taskId)) throw new Error('Task not found')
  const entry = getTaskEntries(taskId).find((item) => item.id === entryId) || (getPinnedEntry(taskId)?.id === entryId ? getPinnedEntry(taskId) : undefined)
  if (!entry) throw new Error('Task entry not found')
  const link = upsertNoteLink(noteId, 'task_entry', taskId, entryId, context)
  linkNoteToTask(noteId, taskId, context)
  return link
}

function validateNoteLinkSource(source?: { taskId?: string; entryId?: string }): void {
  if (!source?.taskId) return
  if (!getTaskById(source.taskId)) throw new Error('Task not found')
  if (!source.entryId) return
  const entry = getTaskEntries(source.taskId).find((item) => item.id === source.entryId) || (getPinnedEntry(source.taskId)?.id === source.entryId ? getPinnedEntry(source.taskId) : undefined)
  if (!entry) throw new Error('Task entry not found')
}

export function getNotesForTask(taskId: string): Note[] {
  if (!getTaskById(taskId)) throw new Error('Task not found')
  const rows = getDb().prepare(`
    SELECT DISTINCT n.*
    FROM notes n
    INNER JOIN note_links l ON l.note_id = n.id
    WHERE l.target_id = ? AND n.archived = 0
    ORDER BY n.updated_at DESC
  `).all(taskId)
  return rows.map(rowToNote)
}

export function getLinkedTasksForNote(noteId: string): Task[] {
  if (!getNoteById(noteId)) throw new Error('Note not found')
  const rows = getDb().prepare(`
    SELECT DISTINCT t.*
    FROM tasks t
    INNER JOIN note_links l ON l.target_id = t.id
    WHERE l.note_id = ? AND l.target_type IN ('task', 'task_entry')
    ORDER BY t.updated_at DESC
  `).all(noteId)
  return rows.map((row: any) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    priority: row.priority,
    tags: JSON.parse(row.tags || '[]'),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dueDate: row.due_date,
  }))
}

export function appendToNote(noteId: string, contentHtml: string, source?: { taskId?: string; entryId?: string; label?: string }): Note {
  const note = getNoteById(noteId)
  if (!note) throw new Error('Note not found')
  validateNoteLinkSource(source)
  const sourceLabel = source?.label ? `<p><small>${escapeHtml(source.label)}</small></p>` : ''
  const nextContent = `${note.contentHtml || '<p></p>'}<hr>${sourceLabel}${contentHtml}`
  const db = getDb()
  const tx = db.transaction(() => {
    const updated = updateNote(noteId, { contentHtml: nextContent })!
    if (source?.taskId && source.entryId) linkNoteToTaskEntry(noteId, source.taskId, source.entryId, 'append')
    else if (source?.taskId) linkNoteToTask(noteId, source.taskId, 'append')
    return updated
  })
  return tx()
}

function renderTaskEntry(entry: TaskEntry): string {
  return `<section><p><small>${escapeHtml(entry.type)} · ${new Date(entry.createdAt).toLocaleString()}</small></p>${entry.content}</section>`
}

export function createNoteFromTask(taskId: string): Note {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')
  const entries = getTaskEntries(taskId)
  const pinned = getPinnedEntry(taskId)
  const parts = [
    `<h1>${escapeHtml(task.title)}</h1>`,
    `<p><small>Created from task ${escapeHtml(task.id)}</small></p>`,
  ]
  if (pinned) parts.push('<h2>Pinned</h2>', renderTaskEntry(pinned))
  if (entries.length > 0) parts.push('<h2>Task logs</h2>', ...entries.map(renderTaskEntry))
  const note = createNote({ title: task.title, contentHtml: parts.join(''), tags: task.tags, linkedTaskIds: [task.id] })
  return note
}

export function addTaskEntryToNote(taskId: string, entryId: string, noteId?: string): Note {
  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')
  const entry = getTaskEntries(taskId).find((item) => item.id === entryId) || (getPinnedEntry(taskId)?.id === entryId ? getPinnedEntry(taskId) : undefined)
  if (!entry) throw new Error('Task entry not found')
  const note = noteId ? getNoteById(noteId) : createNote({ title: task.title, tags: task.tags, linkedTaskIds: [taskId] })
  if (!note) throw new Error('Note not found')
  return appendToNote(note.id, renderTaskEntry(entry), {
    taskId,
    entryId,
    label: `From ${task.id} - ${task.title}`,
  })
}

export function rebuildNotesFtsIndex(): void {
  const db = getDb()
  db.prepare('DELETE FROM notes_fts').run()
  const notes = db.prepare('SELECT * FROM notes').all().map(rowToNote)
  for (const note of notes) indexNote(note)
}

export function searchNotes(query: string, limit = 50, includeArchived = false): { results: NoteSearchResult[]; tokens: string[] } {
  const trimmed = query.trim()
  if (!trimmed) return { results: [], tokens: [] }
  const db = getDb()
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const tokens = tokenize(trimmed).split(' ').filter(Boolean)
  const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' ')
  const ftsRows = ftsQuery.trim()
    ? db.prepare(`
      SELECT f.note_id, f.source, f.content, f.rank
      FROM notes_fts f
      INNER JOIN notes n ON n.id = f.note_id
      WHERE notes_fts MATCH ? ${includeArchived ? '' : 'AND n.archived = 0'}
      ORDER BY f.rank
      LIMIT ?
    `).all(ftsQuery, safeLimit) as Array<{ note_id: string; source: 'note_title' | 'note_content' | 'note_tags'; content: string; rank: number }>
    : []

  const exactRows = db.prepare(`
    SELECT id as note_id, 'note_content' as source, content_html as content, -1.0 as rank
    FROM notes
    WHERE ${includeArchived ? '' : 'archived = 0 AND '}(title LIKE ? OR content_html LIKE ? OR tags LIKE ?)
    LIMIT ?
  `).all(`%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`, safeLimit) as Array<{ note_id: string; source: 'note_content'; content: string; rank: number }>

  const combined = [...exactRows, ...ftsRows]
  const best = new Map<string, { source: 'note_title' | 'note_content' | 'note_tags'; rank: number }>()
  for (const row of combined) {
    const existing = best.get(row.note_id)
    if (!existing || row.rank < existing.rank) best.set(row.note_id, { source: row.source, rank: row.rank })
  }

  const results: NoteSearchResult[] = []
  for (const [noteId, match] of best) {
    const note = getNoteById(noteId)
    if (!note || (!includeArchived && note.archived)) continue
    const plain = htmlToPlainText(note.contentHtml)
    results.push({
      kind: 'note',
      noteId: note.id,
      title: note.title,
      tags: note.tags,
      snippet: plain.slice(0, 240),
      matchedSource: match.source,
      updatedAt: note.updatedAt,
      pinned: note.pinned,
      tokens,
      exactMatch: match.rank <= -1,
      rank: match.rank,
    })
  }
  return { results: results.sort((a, b) => a.rank - b.rank || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), tokens }
}
