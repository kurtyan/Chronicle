import type { ProjectReferenceRole, ProjectTargetType, WorkStatisticsRange } from './projectTypes'

export interface ProjectActivityQuery extends WorkStatisticsRange {
  targetType: ProjectTargetType
  targetId: string
  limit?: number
  offset?: number
}
export interface ProjectActivityItem {
  id: string
  kind: 'task_log' | 'note'
  sourceId: string
  taskId: string | null
  title: string
  occurredAt: number
  timeMeaning: 'recorded' | 'note_updated' | 'note_linked'
  relationship: 'primary' | 'reference' | 'task_context'
  roles: ProjectReferenceRole[]
  viaTaskIds: string[]
  archived: boolean
  excerpt: string
  contentHtml: string
  contentTruncated: boolean
}
export interface ProjectActivityResult {
  targetType: ProjectTargetType
  targetId: string
  window: { start: number; end: number; asOf: number }
  items: ProjectActivityItem[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
  nextOffset: number | null
}
