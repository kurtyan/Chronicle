import { createHash, randomUUID } from 'node:crypto'
import { getDb, getMetaValue, setMetaValue } from '../db'
import { createTask, getTaskById } from './taskService'
import { WORK_OUTLINE_EPOCH_KEY } from '../workOutlineSchema'
import type { OutlineDocument, OutlineInlineNode, WorkOutline } from '../../../shared/workOutlineTypes'

export class OutlineError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message) }
}
const fail = (code: string, message: string, status = 422): never => { throw new OutlineError(code, message, status) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requestKey = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return fail('INVALID_REQUEST', 'A bounded request key is required')
  return value
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail('INVALID_REQUEST', 'expectedRevision must be a positive integer')
  return Number(value)
}
function currentEpoch(): string {
  const epoch = getMetaValue(WORK_OUTLINE_EPOCH_KEY)
  if (!epoch) throw new Error('Work outline epoch is not initialized')
  return epoch
}
function requireCurrentEpoch(expected: unknown): string {
  const epoch = currentEpoch()
  if (typeof expected !== 'string' || expected !== epoch) return fail('OUTLINE_EPOCH_CONFLICT', 'Database has been replaced. Reload the outline before saving or creating a Task.', 409)
  return epoch
}
/** Call only after a successful database replacement, before admitting writes. */
export function rotateWorkOutlineEpoch(): string {
  const epoch = randomUUID()
  setMetaValue(WORK_OUTLINE_EPOCH_KEY, epoch)
  return epoch
}
function rowToOutline(row: any): WorkOutline {
  return { id: row.id, title: row.title, document: JSON.parse(row.document_json), epoch: currentEpoch(), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
}
export function getWorkOutline(id = 'default'): WorkOutline {
  if (id === 'default') {
    const document: OutlineDocument = { type: 'doc', schemaVersion: 1, content: [{ type: 'outlineLine', attrs: { id: randomUUID(), depth: 0 }, content: [] }] }
    const now = Date.now()
    getDb().prepare('INSERT OR IGNORE INTO work_outlines(id,title,document_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, 'Work outline', JSON.stringify(document), now, now)
  }
  const row = getDb().prepare('SELECT * FROM work_outlines WHERE id=?').get(id)
  if (!row) return fail('OUTLINE_NOT_FOUND', 'Outline not found', 404)
  return rowToOutline(row)
}

/** Validate before storing; preserve existing dangling links without accepting new ones. */
export function validateOutlineDocument(input: unknown, previous?: OutlineDocument): OutlineDocument {
  const doc = input as any
  if (!doc || doc.type !== 'doc' || doc.schemaVersion !== 1 || !Array.isArray(doc.content) || doc.content.length < 1 || doc.content.length > 10000) return fail('INVALID_OUTLINE_DOCUMENT', 'Invalid outline document')
  if (JSON.stringify(input).length > 2_000_000) return fail('INVALID_OUTLINE_DOCUMENT', 'Outline is too large')
  const ids = new Set<string>()
  const retained = new Set(previous?.content.flatMap(line => (line.content ?? []).filter(n => n.type === 'taskRef').map(n => `${line.attrs.id}:${n.type === 'taskRef' ? n.attrs.taskId : ''}`)))
  let priorDepth = -1
  const content = doc.content.map((line: any) => {
    const id = line?.attrs?.id, depth = line?.attrs?.depth
    if (line?.type !== 'outlineLine' || typeof id !== 'string' || !id || id.length > 100 || ids.has(id) || !Number.isSafeInteger(depth) || depth < 0 || depth > priorDepth + 1) return fail('INVALID_OUTLINE_DOCUMENT', 'Invalid row identity or hierarchy')
    ids.add(id); priorDepth = depth
    if (line.content !== undefined && !Array.isArray(line.content)) return fail('INVALID_OUTLINE_DOCUMENT', 'Invalid row content')
    let links = 0
    const nodes: OutlineInlineNode[] = (line.content ?? []).map((node: any) => {
      if (node?.type === 'text' && typeof node.text === 'string' && !/[\r\n]/.test(node.text)) return { type: 'text', text: node.text }
      if (node?.type === 'taskRef' && typeof node.attrs?.taskId === 'string' && typeof node.attrs?.label === 'string' && node.attrs.label.length <= 1000 && !/[\r\n]/.test(node.attrs.label)) {
        links++
        if (links > 1) return fail('INVALID_OUTLINE_DOCUMENT', 'Only one Task reference is allowed per row')
        if (!getTaskById(node.attrs.taskId) && !retained.has(`${id}:${node.attrs.taskId}`)) return fail('TASK_NOT_FOUND', 'Referenced Task does not exist')
        return { type: 'taskRef', attrs: { taskId: node.attrs.taskId, label: node.attrs.label } }
      }
      return fail('INVALID_OUTLINE_DOCUMENT', 'Invalid inline content')
    })
    return { type: 'outlineLine' as const, attrs: { id, depth }, content: nodes }
  })
  return { type: 'doc', schemaVersion: 1, content }
}
function receipt(outlineId: string, key: string, fingerprint: string): any | null {
  const row = getDb().prepare('SELECT request_hash,result_json FROM work_outline_requests WHERE outline_id=? AND request_key=?').get(outlineId, key) as any
  if (!row) return null
  if (row.request_hash !== fingerprint) return fail('IDEMPOTENCY_KEY_REUSED', 'Request key has already been used with different content', 409)
  return JSON.parse(row.result_json)
}
function remember(id: string, key: string, fingerprint: string, result: unknown): void {
  getDb().prepare('INSERT INTO work_outline_requests VALUES(?,?,?,?,?)').run(id, key, fingerprint, JSON.stringify(result), Date.now())
}
export function saveWorkOutline(id: string, input: any) {
  const key = requestKey(input?.mutationId), expected = revision(input?.expectedRevision)
  return getDb().transaction(() => {
    // Reject old databases before replaying any receipt copied from a backup.
    const epoch = requireCurrentEpoch(input?.expectedEpoch)
    const fingerprint = hash({ operation: 'save', epoch, expected, document: input?.document })
    const replay = receipt(id, key, fingerprint)
    if (replay) return replay
    const previous = getWorkOutline(id)
    if (previous.revision !== expected) return fail('OUTLINE_REVISION_CONFLICT', 'Outline changed in another window', 409)
    const document = validateOutlineDocument(input.document, previous.document)
    const updatedAt = Date.now(), next = previous.revision + 1
    getDb().prepare('UPDATE work_outlines SET document_json=?,revision=?,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(document), next, updatedAt, id, expected)
    const result = { id, epoch, revision: next, mutationId: key, updatedAt }
    remember(id, key, fingerprint, result)
    return result
  })()
}

function taskPayload(input: any): Parameters<typeof createTask>[0] {
  if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1000) return fail('INVALID_TASK', 'Task title is required (up to 1000 characters)')
  const type = input.type ?? 'TODO', priority = input.priority ?? 'MEDIUM'
  if (!['TODO', 'TOREAD', 'DAILY_IMPROVE'].includes(type) || !['LOW', 'MEDIUM', 'HIGH'].includes(priority)) return fail('INVALID_TASK', 'Invalid Task type or priority')
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 100 || input.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 100))) return fail('INVALID_TASK', 'Invalid tags')
  if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 1_000_000)) return fail('INVALID_TASK', 'Invalid Task description')
  if (input.dueDate != null && (!Number.isFinite(input.dueDate) || Math.abs(input.dueDate) > 8.64e15)) return fail('INVALID_TASK', 'Invalid due date')
  return { title: input.title.trim(), type, priority, tags: input.tags, body: input.body, dueDate: input.dueDate ?? undefined, status: 'PENDING' }
}
export function createTaskInOutline(id: string, rowId: string, input: any) {
  const key = requestKey(input?.idempotencyKey), expected = revision(input?.expectedRevision)
  const task = taskPayload(input?.task)
  return getDb().transaction(() => {
    const epoch = requireCurrentEpoch(input?.expectedEpoch)
    const fingerprint = hash({ operation: 'create', epoch, rowId, expected, task })
    const replay = receipt(id, key, fingerprint)
    if (replay) return replay
    const outline = getWorkOutline(id)
    if (outline.revision !== expected) return fail('OUTLINE_REVISION_CONFLICT', 'Outline changed in another window', 409)
    const row = outline.document.content.find(line => line.attrs.id === rowId)
    if (!row) return fail('OUTLINE_ROW_MISSING', 'The original outline row no longer exists', 409)
    if (row.content?.some(n => n.type === 'taskRef')) return fail('OUTLINE_ROW_ALREADY_LINKED', 'This row already references a Task', 409)
    const created = createTask(task)
    row.content = [...row.content ?? [], { type: 'taskRef', attrs: { taskId: created.id, label: created.title } }]
    const updatedAt = Date.now(), outlineRevision = outline.revision + 1
    getDb().prepare('UPDATE work_outlines SET document_json=?,revision=?,updated_at=? WHERE id=?').run(JSON.stringify(outline.document), outlineRevision, updatedAt, id)
    const result = { task: created, epoch, rowId, outlineRevision, bindingPatch: { rowId, taskId: created.id, label: created.title }, updatedAt }
    remember(id, key, fingerprint, result)
    return result
  })()
}
