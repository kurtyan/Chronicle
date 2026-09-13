import { getDb } from '../db'
import { getBacklinks } from './projectReferenceService'
import { htmlToPlainText } from './searchText'
import type { ProjectActivityItem, ProjectActivityQuery, ProjectActivityResult } from '../../../shared/projectActivityTypes'

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status, code: status === 404 ? 'PROJECT_TARGET_NOT_FOUND' : 'INVALID_PROJECT_ACTIVITY_QUERY' })
}

/** Current related records in a fixed reporting window; this is never a source of work time. */
export function getProjectActivity(query: ProjectActivityQuery): ProjectActivityResult {
  if (!query || !['area', 'milestone'].includes(query.targetType) || typeof query.targetId !== 'string' || !query.targetId.trim()) invalid('A valid activity target is required')
  const now = Date.now(), requestedAsOf = query.asOf ?? now, start = query.start ?? 0, end = query.end ?? requestedAsOf
  if (![start, end, requestedAsOf].every(value => Number.isSafeInteger(value) && value >= 0) || end < start) invalid('Invalid activity range')
  const asOf = Math.min(requestedAsOf, now), cutoff = Math.min(end, asOf)
  const limit = query.limit ?? 20, offset = query.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid('Invalid activity pagination')
  const db = getDb()
  if (!db.prepare(`SELECT id FROM ${query.targetType === 'area' ? 'areas' : 'milestones'} WHERE id=?`).get(query.targetId)) invalid('Project activity target not found', 404)
  const result = (items: ProjectActivityItem[], total = items.length): ProjectActivityResult => ({ targetType: query.targetType, targetId: query.targetId,
    window: { start, end, asOf }, items: items.slice(offset, offset + limit), total, limit, offset,
    hasMore: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null })
  if (cutoff <= start) return result([])
  const primaryTasks = db.prepare(`SELECT t.id,t.title FROM tasks t JOIN milestones m ON m.id=t.primary_milestone_id WHERE ${query.targetType === 'area' ? 'm.area_id' : 'm.id'}=?`).all(query.targetId) as Array<{ id: string; title: string }>
  const primaryIds = new Set(primaryTasks.map(task => task.id))
  const backlinks = getBacklinks(query.targetType, query.targetId)
  const items: ProjectActivityItem[] = []
  const preview = (html: string) => ({ excerpt: htmlToPlainText(html).slice(0, 320), contentHtml: html.slice(0, 16000), contentTruncated: html.length > 16000 })
  const membership = query.targetType === 'area'
    ? `(m.area_id=? OR EXISTS(SELECT 1 FROM project_references r LEFT JOIN milestones related ON related.id=r.milestone_id WHERE r.task_id=t.id AND (r.area_id=? OR related.area_id=?)))`
    : `(m.id=? OR EXISTS(SELECT 1 FROM project_references r WHERE r.task_id=t.id AND r.milestone_id=?))`
  const logScope = `FROM task_entries e JOIN tasks t ON t.id=e.task_id LEFT JOIN milestones m ON m.id=t.primary_milestone_id
    WHERE e.type IN ('log','pinned') AND e.created_at>=? AND e.created_at<? AND ${membership}`
  const logParams = [start, cutoff, ...Array(query.targetType === 'area' ? 3 : 2).fill(query.targetId)]
  const logCount = (db.prepare(`SELECT COUNT(*) AS count ${logScope}`).get(...logParams) as { count: number }).count
  // Filter in SQLite before reading any body. The first offset+limit logs are
  // sufficient for that global page even when Notes interleave with them.
  // Count independently so a bounded page still reports the complete total.
  const logs = db.prepare(`SELECT e.*,t.title ${logScope} ORDER BY e.created_at DESC,e.id LIMIT ?`).all(...logParams, offset + limit) as any[]
  for (const log of logs) {
    items.push({ id: `entry:${log.id}`, kind: 'task_log', sourceId: log.id, taskId: log.task_id, title: log.title,
      occurredAt: log.created_at, timeMeaning: 'recorded', relationship: primaryIds.has(log.task_id) ? 'primary' : 'reference',
      roles: ['related'], viaTaskIds: [log.task_id], archived: false, ...preview(log.content) })
  }
  for (const link of backlinks.notes) {
    const note = db.prepare('SELECT * FROM notes WHERE id=?').get(link.sourceId) as any
    // A Note has no edit history here. Do not present its later text as an
    // earlier version; use its current update time, or a newly created link.
    if (!note || note.updated_at >= cutoff) continue
    const direct = db.prepare(`SELECT r.created_at FROM project_references r LEFT JOIN milestones m ON m.id=r.milestone_id
      WHERE r.note_id=? AND ${query.targetType === 'area' ? '(r.area_id=? OR m.area_id=?)' : 'r.milestone_id=?'} AND r.created_at<? ORDER BY r.created_at DESC LIMIT 1`)
      .get(...(query.targetType === 'area' ? [note.id, query.targetId, query.targetId, cutoff] : [note.id, query.targetId, cutoff])) as { created_at: number } | undefined
    const contextual = db.prepare(`SELECT l.created_at,t.id AS task_id FROM note_links l JOIN tasks t ON t.id=l.target_id JOIN milestones m ON m.id=t.primary_milestone_id
      WHERE l.note_id=? AND ${query.targetType === 'area' ? 'm.area_id' : 'm.id'}=? AND l.created_at<?
      AND (l.target_type='task' OR (l.target_type='task_entry' AND EXISTS(SELECT 1 FROM task_entries e WHERE e.id=l.target_entry_id AND e.task_id=t.id)))
      ORDER BY l.created_at DESC,t.id`).all(note.id, query.targetId, cutoff) as Array<{ created_at: number; task_id: string }>
    if (!direct && !contextual.length) continue
    const linkedAt = Math.max(direct?.created_at ?? 0, contextual[0]?.created_at ?? 0)
    const occurredAt = Math.max(note.updated_at, linkedAt)
    if (occurredAt < start || occurredAt >= cutoff) continue
    items.push({ id: `note:${note.id}`, kind: 'note', sourceId: note.id, taskId: null, title: note.title,
      occurredAt, timeMeaning: linkedAt > note.updated_at ? 'note_linked' : 'note_updated', relationship: direct ? 'reference' : 'task_context',
      roles: link.roles, viaTaskIds: [...new Set(contextual.map(row => row.task_id))], archived: Boolean(note.archived), ...preview(note.content_html) })
  }
  const noteCount = items.length - logs.length
  // Match SQLite's ID ordering for tied log times before merging with Notes.
  items.sort((a, b) => b.occurredAt - a.occurredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result(items, logCount + noteCount)
}
