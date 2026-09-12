import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { broadcastEvent } from './eventBus'
import type { ProjectBacklinks, ProjectReference, ProjectReferenceInput, ProjectReferencesResult, ProjectSourceType, ProjectTargetType } from '../../../shared/projectTypes'

function fail(message: string, status = 400, code = 'INVALID_PROJECT_REFERENCE'): never { throw Object.assign(new Error(message), { status, code }) }
function sourceColumn(type: ProjectSourceType): 'task_id' | 'note_id' {
  if (type !== 'task' && type !== 'note') fail('Source must be task or note')
  return type === 'task' ? 'task_id' : 'note_id'
}
function targetColumn(type: ProjectTargetType): 'area_id' | 'milestone_id' {
  if (type !== 'area' && type !== 'milestone') fail('Target must be area or milestone')
  return type === 'area' ? 'area_id' : 'milestone_id'
}
function sourceRow(type: ProjectSourceType, id: string): any {
  sourceColumn(type)
  const row = getDb().prepare(`SELECT id,project_revision FROM ${type === 'task' ? 'tasks' : 'notes'} WHERE id=?`).get(id)
  if (!row) fail('Reference source not found', 404, 'PROJECT_SOURCE_NOT_FOUND')
  return row
}

export function getReferences(sourceType: ProjectSourceType, sourceId: string): ProjectReferencesResult {
  const source = sourceRow(sourceType, sourceId)
  const rows = getDb().prepare(`SELECT r.*,m.name AS milestone_name,m.area_id AS parent_area_id,m.archived AS milestone_archived,
    a.name AS direct_area_name,a.archived AS area_archived,p.name AS parent_area_name
    FROM project_references r LEFT JOIN milestones m ON m.id=r.milestone_id
    LEFT JOIN areas a ON a.id=r.area_id LEFT JOIN areas p ON p.id=m.area_id
    WHERE r.${sourceColumn(sourceType)}=? ORDER BY r.created_at,r.id`).all(sourceId) as any[]
  const references: ProjectReference[] = rows.map(r => ({
    id: r.id, sourceType, sourceId, targetType: r.area_id ? 'area' : 'milestone', targetId: r.area_id ?? r.milestone_id,
    role: r.role, origin: r.origin, name: r.direct_area_name ?? r.milestone_name,
    areaId: r.area_id ?? r.parent_area_id, areaName: r.direct_area_name ?? r.parent_area_name,
    archived: Boolean(r.area_id ? r.area_archived : r.milestone_archived), createdAt: r.created_at,
  }))
  return { sourceType, sourceId, projectRevision: source.project_revision, references }
}

/** Replaces manual references only; future body mentions retain their own lifecycle. */
export function setReferences(sourceType: ProjectSourceType, sourceId: string, references: ProjectReferenceInput[], expectedRevision: number): ProjectReferencesResult {
  const result = getDb().transaction(() => {
    const source = sourceRow(sourceType, sourceId)
    if (!Number.isInteger(expectedRevision) || source.project_revision !== expectedRevision) fail('Relationships changed; reload before saving', 409, 'PROJECT_REVISION_CONFLICT')
    if (!Array.isArray(references) || references.length > 500) fail('References must be an array of at most 500 objects')
    const existing = getReferences(sourceType, sourceId).references
    const seen = new Set<string>()
    for (const ref of references) {
      if (!ref || typeof ref !== 'object' || typeof ref.targetId !== 'string' || !ref.targetId) fail('Each reference requires a target ID')
      targetColumn(ref.targetType)
      const key = `${ref.targetType}:${ref.targetId}`
      if (seen.has(key)) fail('Duplicate object reference')
      seen.add(key)
      if (!['related', 'outcome', 'review', 'growth'].includes(ref.role ?? 'related')) fail('Invalid reference role')
      const target = getDb().prepare(`SELECT archived FROM ${ref.targetType === 'area' ? 'areas' : 'milestones'} WHERE id=?`).get(ref.targetId) as any
      if (!target) fail('Reference target not found', 404, 'PROJECT_TARGET_NOT_FOUND')
      if (target.archived && !existing.some(r => r.targetType === ref.targetType && r.targetId === ref.targetId)) fail('Restore the archived target before adding a reference')
    }
    getDb().prepare(`DELETE FROM project_references WHERE ${sourceColumn(sourceType)}=? AND origin='manual'`).run(sourceId)
    const insert = getDb().prepare(`INSERT INTO project_references(id,task_id,note_id,area_id,milestone_id,role,origin,created_at) VALUES(?,?,?,?,?,?,'manual',?)`)
    for (const ref of references) {
      const previous = existing.find(r => r.origin === 'manual' && r.targetType === ref.targetType && r.targetId === ref.targetId)
      insert.run(previous?.id ?? randomUUID(), sourceType === 'task' ? sourceId : null, sourceType === 'note' ? sourceId : null,
        ref.targetType === 'area' ? ref.targetId : null, ref.targetType === 'milestone' ? ref.targetId : null,
        ref.role ?? 'related', previous?.createdAt ?? Date.now())
    }
    getDb().prepare(`UPDATE ${sourceType === 'task' ? 'tasks' : 'notes'} SET project_revision=project_revision+1 WHERE id=?`).run(sourceId)
    return getReferences(sourceType, sourceId)
  })()
  queueMicrotask(() => {
    try {
      if (sourceRow(sourceType, sourceId).project_revision >= result.projectRevision) broadcastEvent('projects_changed', { sourceType, sourceId })
    } catch { /* A containing transaction may roll back or a test may close the database. */ }
  })
  return result
}

/** Transactional single-reference addition for review/insight creation. */
export function addProjectReference(sourceType: ProjectSourceType, sourceId: string, reference: ProjectReferenceInput): ProjectReferencesResult {
  return getDb().transaction(() => {
    const existing = getReferences(sourceType, sourceId)
    const manual = existing.references.filter(r => r.origin === 'manual' && !(r.targetType === reference.targetType && r.targetId === reference.targetId))
    return setReferences(sourceType, sourceId, [...manual, reference], existing.projectRevision)
  })()
}

export function getBacklinks(targetType: ProjectTargetType, targetId: string): ProjectBacklinks {
  targetColumn(targetType)
  if (!getDb().prepare(`SELECT id FROM ${targetType === 'area' ? 'areas' : 'milestones'} WHERE id=?`).get(targetId)) fail('Target not found', 404, 'PROJECT_TARGET_NOT_FOUND')
  const rows = getDb().prepare(`SELECT r.*,COALESCE(t.title,n.title) AS title,COALESCE(a.name,m.name) AS target_name
    FROM project_references r LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN notes n ON n.id=r.note_id
    LEFT JOIN areas a ON a.id=r.area_id LEFT JOIN milestones m ON m.id=r.milestone_id
    WHERE ${targetType === 'area' ? '(r.area_id=? OR m.area_id=?)' : 'r.milestone_id=?'} ORDER BY r.created_at DESC,r.id`).all(...(targetType === 'area' ? [targetId, targetId] : [targetId])) as any[]
  const map = new Map<string, ProjectBacklinks['notes'][number]>()
  for (const row of rows) {
    const sourceType = row.task_id ? 'task' : 'note', sourceId = row.task_id ?? row.note_id
    const key = `${sourceType}:${sourceId}`
    const result: ProjectBacklinks['notes'][number] = map.get(key) ?? { sourceType, sourceId, title: row.title, roles: [], via: [] }
    if (!result.roles.includes(row.role)) result.roles.push(row.role)
    const type = row.area_id ? 'area' : 'milestone', id = row.area_id ?? row.milestone_id
    if (!result.via.some(v => v.targetType === type && v.targetId === id)) result.via.push({ targetType: type, targetId: id, name: row.target_name })
    map.set(key, result)
  }
  // Existing Note ↔ Task links provide contextual discovery, not new direct tags.
  // Only recognized Task/Task Log link types qualify; an entry must still belong to that Task.
  const contextualNotes = getDb().prepare(`SELECT n.id AS note_id,n.title,t.id AS task_id,t.title AS task_title,
    m.id AS milestone_id,m.name AS milestone_name,l.target_entry_id
    FROM note_links l JOIN notes n ON n.id=l.note_id JOIN tasks t ON t.id=l.target_id
    JOIN milestones m ON m.id=t.primary_milestone_id
    WHERE (l.target_type='task' OR (l.target_type='task_entry' AND EXISTS(
      SELECT 1 FROM task_entries e WHERE e.id=l.target_entry_id AND e.task_id=t.id
    ))) AND ${targetType === 'area' ? 'm.area_id' : 'm.id'}=? ORDER BY n.updated_at DESC,n.id,t.id,l.id`).all(targetId) as any[]
  for (const row of contextualNotes) {
    const key = `note:${row.note_id}`
    const result: ProjectBacklinks['notes'][number] = map.get(key) ?? { sourceType: 'note', sourceId: row.note_id, title: row.title, roles: ['related'], via: [] }
    if (!result.via.some(v => v.targetType === 'milestone' && v.targetId === row.milestone_id && v.viaTaskId === row.task_id && v.viaEntryId === (row.target_entry_id ?? undefined))) {
      result.via.push({ targetType: 'milestone', targetId: row.milestone_id, name: row.milestone_name,
        viaTaskId: row.task_id, viaTaskTitle: row.task_title, ...(row.target_entry_id ? { viaEntryId: row.target_entry_id } : {}) })
    }
    map.set(key, result)
  }
  return { tasks: [...map.values()].filter(r => r.sourceType === 'task'), notes: [...map.values()].filter(r => r.sourceType === 'note') }
}
