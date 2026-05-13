import { getDb } from '../db'
import { indexEntry } from './searchService'

function queryAll(sql: string, params: any[] = []): any[] {
  return getDb().prepare(sql).all(...params)
}

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params)
}

export interface PlanItemDetail {
  id: string
  entryId: string
  planDate: string
  estimatedMinutes: number
  estimatedStart: string | null
  estimatedEnd: string | null
  actualStartedAt: number | null
  actualCompletedAt: number | null
  status: 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED'
  sortOrder: number
}

export interface PlanItem {
  id: string
  detailId: string
  taskId: string
  taskTitle: string
  content: string
  estimatedMinutes: number
  estimatedStart: string | null
  estimatedEnd: string | null
  actualStartedAt: number | null
  actualCompletedAt: number | null
  planStatus: 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED'
  planDate: string
  sortOrder: number
  createdAt: number
  type: string
  priority: string
}

export interface BatchCreatePlanItem {
  taskId: string
  content: string
  estimatedMinutes: number
  estimatedStart: string
  estimatedEnd: string
  sortOrder: number
  detailId?: string
}

function rowToPlanItem(row: any): PlanItem {
  return {
    id: row.id,
    detailId: row.detail_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    content: row.content,
    estimatedMinutes: row.estimated_minutes,
    estimatedStart: row.estimated_start,
    estimatedEnd: row.estimated_end,
    actualStartedAt: row.actual_started_at,
    actualCompletedAt: row.actual_completed_at,
    planStatus: row.status as 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED',
    planDate: row.plan_date,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    type: row.type,
    priority: row.priority,
  }
}

function rowToPlanItemDetail(row: any): PlanItemDetail {
  return {
    id: row.id,
    entryId: row.entry_id,
    planDate: row.plan_date,
    estimatedMinutes: row.estimated_minutes,
    estimatedStart: row.estimated_start,
    estimatedEnd: row.estimated_end,
    actualStartedAt: row.actual_started_at,
    actualCompletedAt: row.actual_completed_at,
    status: row.status as 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED',
    sortOrder: row.sort_order,
  }
}

export function hasPlanForDate(planDate: string): boolean {
  const row = queryAll('SELECT COUNT(*) as cnt FROM plan_item_details WHERE plan_date = ?', [planDate])[0] as { cnt: number } | undefined
  return (row?.cnt ?? 0) > 0
}

export function getPlanItems(planDate: string): PlanItem[] {
  const rows = queryAll(`
    SELECT
      te.id, te.task_id, te.content, te.created_at,
      t.title as task_title, t.type, t.priority,
      pid.id as detail_id,
      pid.estimated_minutes, pid.estimated_start, pid.estimated_end,
      pid.actual_started_at, pid.actual_completed_at,
      pid.status, pid.plan_date, pid.sort_order
    FROM plan_item_details pid
    JOIN task_entries te ON te.id = pid.entry_id
    JOIN tasks t ON t.id = te.task_id
    WHERE pid.plan_date = ?
    ORDER BY pid.sort_order ASC
  `, [planDate])
  return rows.map(rowToPlanItem)
}

export function getPlanItemDetail(detailId: string): PlanItemDetail | null {
  const row = queryAll('SELECT * FROM plan_item_details WHERE id = ?', [detailId])[0]
  return row ? rowToPlanItemDetail(row) : null
}

export function batchCreatePlanItems(planDate: string, items: BatchCreatePlanItem[]): PlanItem[] {
  const now = Date.now()
  const db = getDb()

  const insertEntry = db.prepare(
    'INSERT INTO task_entries (id, task_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const insertDetail = db.prepare(
    `INSERT INTO plan_item_details (id, entry_id, plan_date, estimated_minutes, estimated_start, estimated_end, sort_order, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED')`
  )
  const updateTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
  const markOldUnfinished = db.prepare(
    'UPDATE plan_item_details SET status = ? WHERE id = ?'
  )

  const transaction = db.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const entryId = crypto.randomUUID()
      const detailId = crypto.randomUUID()

      insertEntry.run(entryId, item.taskId, item.content, 'plan', now)
      insertDetail.run(detailId, entryId, planDate, item.estimatedMinutes, item.estimatedStart, item.estimatedEnd, item.sortOrder)
      updateTask.run(now, item.taskId)
      indexEntry(item.taskId, entryId, item.content, 'plan')

      // Imported plan: mark old detail as UNFINISHED
      if (item.detailId) {
        markOldUnfinished.run('UNFINISHED', item.detailId)
      }
    }
  })

  transaction()

  return getPlanItems(planDate)
}

export function updatePlanItem(detailId: string, data: {
  status?: 'PLANNED' | 'DOING' | 'DONE' | 'SKIPPED' | 'UNFINISHED'
  content?: string
  actualStartedAt?: number | null
  actualCompletedAt?: number | null
}): PlanItemDetail | null {
  const detail = getPlanItemDetail(detailId)
  if (!detail) return null

  const updates: string[] = []
  const params: any[] = []

  if (data.status !== undefined) {
    updates.push('status = ?')
    params.push(data.status)
  }
  if (data.actualStartedAt !== undefined) {
    updates.push('actual_started_at = ?')
    params.push(data.actualStartedAt)
  }
  if (data.actualCompletedAt !== undefined) {
    updates.push('actual_completed_at = ?')
    params.push(data.actualCompletedAt)
  }

  if (updates.length > 0) {
    params.push(detailId)
    run(`UPDATE plan_item_details SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  if (data.content !== undefined) {
    const entry = queryAll('SELECT * FROM task_entries WHERE id = ?', [detail.entryId])[0] as any
    if (entry) {
      run('UPDATE task_entries SET content = ? WHERE id = ?', [data.content, detail.entryId])
      run('UPDATE tasks SET updated_at = ? WHERE id = ?', [Date.now(), entry.task_id])
      indexEntry(entry.task_id, detail.entryId, data.content, 'plan')
    }
  }

  return getPlanItemDetail(detailId)
}

export function deletePlanItem(detailId: string): boolean {
  const detail = getPlanItemDetail(detailId)
  if (!detail) return false

  const entry = queryAll('SELECT * FROM task_entries WHERE id = ?', [detail.entryId])[0] as any
  run('DELETE FROM plan_item_details WHERE id = ?', [detailId])
  if (entry) {
    run('DELETE FROM task_entries WHERE id = ?', [detail.entryId])
    run('DELETE FROM tasks_fts WHERE task_id = ? AND source = ?', [entry.task_id, 'entry_plan'])
  }
  return true
}

export function clearPlanForDate(planDate: string): number {
  const items = getPlanItems(planDate)
  for (const item of items) {
    deletePlanItem(item.detailId)
  }
  return items.length
}

export function getUnfinishedPlans(beforeDate: string): PlanItem[] {
  const rows = queryAll(`
    SELECT
      te.id, te.task_id, te.content, te.created_at,
      t.title as task_title, t.type, t.priority,
      pid.id as detail_id,
      pid.estimated_minutes, pid.estimated_start, pid.estimated_end,
      pid.actual_started_at, pid.actual_completed_at,
      pid.status, pid.plan_date, pid.sort_order
    FROM plan_item_details pid
    JOIN task_entries te ON te.id = pid.entry_id
    JOIN tasks t ON t.id = te.task_id
    WHERE pid.plan_date < ? AND pid.status IN ('PLANNED', 'DOING', 'SKIPPED')
    ORDER BY pid.plan_date DESC, pid.sort_order ASC
  `, [beforeDate])
  return rows.map(rowToPlanItem)
}

export function reparentPlanItem(detailId: string, newPlanDate: string): boolean {
  const detail = getPlanItemDetail(detailId)
  if (!detail) return false
  run('UPDATE plan_item_details SET plan_date = ?, sort_order = -1 WHERE id = ?', [newPlanDate, detailId])
  return true
}

export function reparentPlanItems(detailIds: string[], newPlanDate: string): void {
  if (detailIds.length === 0) return
  const placeholders = detailIds.map(() => '?').join(',')
  run(
    `UPDATE plan_item_details SET plan_date = ?, sort_order = -1 WHERE id IN (${placeholders})`,
    [newPlanDate, ...detailIds]
  )
}
