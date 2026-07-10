import crypto from 'crypto'
import { getDb } from '../db'
import { tokenize } from './tokenizer'
import { htmlToPlainText } from './searchText'

type EntryType = 'body' | 'log' | 'pinned'
type EntrySource = 'entry_body' | 'entry_log' | 'entry_pinned'

export function sourceForEntryType(type: string): EntrySource {
  if (type === 'body') return 'entry_body'
  if (type === 'pinned') return 'entry_pinned'
  return 'entry_log'
}

export function entryTypeForSource(source: string): EntryType {
  if (source === 'entry_body') return 'body'
  if (source === 'entry_pinned') return 'pinned'
  return 'log'
}

function computeContentHash(
  kind: string,
  identifier: string,
  title: string,
  content: string,
  tagsJson: string,
): string {
  const input = `${kind}\0${identifier}\0${title}\0${content}\0${tagsJson}`
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

function canonicalTagsJson(tags: string[]): string {
  return JSON.stringify(tags.map((t) => t.trim()).filter(Boolean))
}

function upsertDocument(
  docKey: string,
  kind: 'task' | 'task_entry' | 'note',
  fields: {
    taskId?: string | null
    entryId?: string | null
    noteId?: string | null
    source: string
    identifierText: string
    titleText: string
    contentText: string
    tags: string[]
    updatedAt: number
  },
): void {
  const db = getDb()
  const tagsJson = canonicalTagsJson(fields.tags)
  const hash = computeContentHash(kind, fields.identifierText, fields.titleText, fields.contentText, tagsJson)

  db.prepare(`
    INSERT INTO search_documents (
      doc_key, kind, task_id, entry_id, note_id, source,
      identifier_text, title_text, content_text, tags_json,
      updated_at, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_key) DO UPDATE SET
      kind = excluded.kind,
      task_id = excluded.task_id,
      entry_id = excluded.entry_id,
      note_id = excluded.note_id,
      source = excluded.source,
      identifier_text = excluded.identifier_text,
      title_text = excluded.title_text,
      content_text = excluded.content_text,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at,
      content_hash = excluded.content_hash
  `).run(
    docKey, kind, fields.taskId ?? null, fields.entryId ?? null, fields.noteId ?? null, fields.source,
    fields.identifierText, fields.titleText, fields.contentText, tagsJson,
    fields.updatedAt, hash,
  )

  db.prepare('DELETE FROM search_fts WHERE doc_key = ?').run(docKey)
  db.prepare(`
    INSERT INTO search_fts (doc_key, identifier, title, content, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    docKey,
    tokenize(fields.identifierText),
    tokenize(fields.titleText),
    tokenize(fields.contentText),
    tokenize(fields.tags.join(' ')),
  )
}

export function upsertTaskSearchDocument(taskId: string, title: string, tags: string[]): void {
  upsertDocument(`task:${taskId}`, 'task', {
    taskId,
    entryId: null,
    noteId: null,
    source: 'task',
    identifierText: taskId,
    titleText: title,
    contentText: '',
    tags,
    updatedAt: Date.now(),
  })
}

export function upsertTaskEntrySearchDocument(
  taskId: string,
  entryId: string,
  source: string,
  content: string,
  createdAt?: number,
): void {
  upsertDocument(`entry:${entryId}`, 'task_entry', {
    taskId,
    entryId,
    noteId: null,
    source,
    identifierText: '',
    titleText: '',
    contentText: htmlToPlainText(content),
    tags: [],
    updatedAt: createdAt ?? Date.now(),
  })
}

export function upsertNoteSearchDocument(
  noteId: string,
  title: string,
  contentHtml: string,
  tags: string[],
  updatedAt?: number,
): void {
  upsertDocument(`note:${noteId}`, 'note', {
    taskId: null,
    entryId: null,
    noteId,
    source: 'note',
    identifierText: noteId,
    titleText: title,
    contentText: htmlToPlainText(contentHtml),
    tags,
    updatedAt: updatedAt ?? Date.now(),
  })
}

export function removeSearchDocument(docKey: string): void {
  const db = getDb()
  db.prepare('DELETE FROM search_fts WHERE doc_key = ?').run(docKey)
  db.prepare('DELETE FROM search_documents WHERE doc_key = ?').run(docKey)
}

export function removeTaskSearchDocuments(taskId: string): void {
  const db = getDb()
  const docKeys = db.prepare(
    'SELECT doc_key FROM search_documents WHERE task_id = ?'
  ).all(taskId) as Array<{ doc_key: string }>
  for (const { doc_key } of docKeys) {
    db.prepare('DELETE FROM search_fts WHERE doc_key = ?').run(doc_key)
  }
  db.prepare('DELETE FROM search_documents WHERE task_id = ?').run(taskId)
}

export function rebuildSearchIndex(): void {
  const db = getDb()

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM search_fts').run()
    db.prepare('DELETE FROM search_documents').run()

    const tasks = db.prepare('SELECT id, title, tags, updated_at FROM tasks').all() as Array<{
      id: string; title: string; tags: string | null; updated_at: number
    }>
    for (const t of tasks) {
      upsertTaskSearchDocument(t.id, t.title, JSON.parse(t.tags || '[]'))
      const doc = db.prepare('SELECT updated_at FROM search_documents WHERE doc_key = ?').get(`task:${t.id}`) as { updated_at: number } | undefined
      if (doc) {
        db.prepare('UPDATE search_documents SET updated_at = ? WHERE doc_key = ?').run(t.updated_at, `task:${t.id}`)
      }
    }

    const entries = db.prepare('SELECT id, task_id, type, content, created_at FROM task_entries').all() as Array<{
      id: string; task_id: string; type: string; content: string; created_at: number
    }>
    for (const e of entries) {
      upsertTaskEntrySearchDocument(e.task_id, e.id, sourceForEntryType(e.type), e.content, e.created_at)
    }

    const notes = db.prepare('SELECT id, title, content_html, tags, updated_at FROM notes').all() as Array<{
      id: string; title: string; content_html: string; tags: string | null; updated_at: number
    }>
    for (const n of notes) {
      upsertNoteSearchDocument(n.id, n.title, n.content_html, JSON.parse(n.tags || '[]'), n.updated_at)
    }
  })
  tx()
}
