import crypto from 'crypto'
import { getDb, getMetaValue, setMetaValue } from '../db'
import { tokenize } from './tokenizer'
import { htmlToPlainText } from './searchText'
import { getTaskById, getTaskEntries, getPinnedEntry, type Task, type TaskEntry } from './taskService'
import { upsertNoteSearchDocument, removeSearchDocument } from './searchIndexService'
import { searchNotes as searchNotesCore, type NoteSearchResult } from './searchService'

export interface Note {
  id: string
  title: string
  contentHtml: string
  tags: string[]
  pinned: boolean
  archived: boolean
  revision: number
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

export type { NoteSearchResult }
const NOTE_ID_SEQUENCE_KEY = 'note_id_sequence'

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
    revision: Number(row.revision ?? 1),
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
  const persisted = Number(getMetaValue(NOTE_ID_SEQUENCE_KEY) ?? 0)
  const next = Math.max(Number.isFinite(persisted) ? persisted : 0, row.maxId ?? 0) + 1
  setMetaValue(NOTE_ID_SEQUENCE_KEY, String(next))
  return `N${String(next).padStart(10, '0')}`
}

function indexNote(note: Note): void {
  upsertNoteSearchDocument(note.id, note.title, note.contentHtml, note.tags, note.updatedAt)
}

function removeNoteFromIndex(noteId: string): void {
  removeSearchDocument(`note:${noteId}`)
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
      INSERT INTO notes(id, title, content_html, tags, pinned, archived, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?)
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

export function updateNote(id: string, data: { title?: string; contentHtml?: string; tags?: string[]; pinned?: boolean; archived?: boolean; expectedRevision?: number }): Note | null {
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
  updates.push('updated_at = ?', 'revision = revision + 1')
  const expectedRevision = data.expectedRevision ?? existing.revision
  params.push(Date.now(), id, expectedRevision)
  const result = getDb().prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ? AND revision = ?`).run(...params)
  if (result.changes === 0) {
    if (!getNoteById(id)) return null
    throw new Error('NOTE_REVISION_CONFLICT')
  }
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

export function searchNotes(query: string, limit = 50, includeArchived = false): { results: NoteSearchResult[]; tokens: string[] } {
  return searchNotesCore(query, limit, includeArchived)
}
