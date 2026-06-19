import { randomUUID } from 'crypto'
import { getDb } from '../db'

export type WorkOverviewHidableSignalSourceType = 'carry_over' | 'explicit' | 'recommended'

export interface WorkOverviewHiddenSignal {
  id: string
  taskId: string
  sourceType: WorkOverviewHidableSignalSourceType
  signalKey: string
  hiddenAt: number
}

const HIDABLE_SOURCE_TYPES = new Set<WorkOverviewHidableSignalSourceType>(['carry_over', 'explicit', 'recommended'])

type HiddenSignalRow = {
  id: string
  task_id: string
  source_type: string
  signal_key: string
  hidden_at: number
}

export function isWorkOverviewHidableSignalSourceType(value: unknown): value is WorkOverviewHidableSignalSourceType {
  return typeof value === 'string' && HIDABLE_SOURCE_TYPES.has(value as WorkOverviewHidableSignalSourceType)
}

function rowToHiddenSignal(row: HiddenSignalRow): WorkOverviewHiddenSignal {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceType: row.source_type as WorkOverviewHidableSignalSourceType,
    signalKey: row.signal_key,
    hiddenAt: row.hidden_at,
  }
}

export function workOverviewHiddenSignalCompositeKey(input: Pick<WorkOverviewHiddenSignal, 'taskId' | 'sourceType' | 'signalKey'>): string {
  return `${input.taskId}:${input.sourceType}:${input.signalKey}`
}

export function listWorkOverviewHiddenSignals(): WorkOverviewHiddenSignal[] {
  const rows = getDb().prepare(
    `SELECT id, task_id, source_type, signal_key, hidden_at
     FROM work_overview_hidden_signals
     ORDER BY hidden_at DESC`
  ).all() as HiddenSignalRow[]
  return rows
    .filter((row) => isWorkOverviewHidableSignalSourceType(row.source_type))
    .map(rowToHiddenSignal)
}

export function getWorkOverviewHiddenSignalKeySet(): Set<string> {
  return new Set(listWorkOverviewHiddenSignals().map(workOverviewHiddenSignalCompositeKey))
}

export function hideWorkOverviewSignal(input: {
  taskId: string
  sourceType: WorkOverviewHidableSignalSourceType
  signalKey: string
}): WorkOverviewHiddenSignal {
  const taskId = input.taskId.trim()
  const signalKey = input.signalKey.trim()
  if (!taskId) throw new Error('taskId is required')
  if (!signalKey) throw new Error('signalKey is required')
  if (!isWorkOverviewHidableSignalSourceType(input.sourceType)) throw new Error('Invalid sourceType')

  const now = Date.now()
  getDb().prepare(
    `INSERT INTO work_overview_hidden_signals (id, task_id, source_type, signal_key, hidden_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_id, source_type, signal_key) DO UPDATE SET hidden_at = excluded.hidden_at`
  ).run(randomUUID(), taskId, input.sourceType, signalKey, now)

  const row = getDb().prepare(
    `SELECT id, task_id, source_type, signal_key, hidden_at
     FROM work_overview_hidden_signals
     WHERE task_id = ? AND source_type = ? AND signal_key = ?`
  ).get(taskId, input.sourceType, signalKey) as HiddenSignalRow | undefined
  if (!row) throw new Error('Failed to hide signal')
  return rowToHiddenSignal(row)
}
