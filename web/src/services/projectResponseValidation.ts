import type { Area, Milestone, ProjectReferencesResult, ProjectSourceType } from '../../../shared/projectTypes'

type JsonRecord = Record<string, unknown>
const record = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown): value is string => typeof value === 'string'
const nullableText = (value: unknown) => value === null || text(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const strings = (value: JsonRecord, keys: string[]) => keys.every(key => text(value[key]))
const revision = (value: unknown) => Number.isInteger(value) && (value as number) >= 0

function isArea(value: unknown): value is Area {
  return record(value) && strings(value, ['id', 'name', 'description', 'focus', 'latestProgress', 'nextStep'])
    && ['active', 'paused', 'ended'].includes(String(value.status))
    && typeof value.archived === 'boolean' && revision(value.revision)
    && finite(value.createdAt) && finite(value.updatedAt) && nullableNumber(value.summaryUpdatedAt)
    && (value.summarySource === null || value.summarySource === 'manual' || value.summarySource === 'insight')
    && nullableText(value.summarySourceNoteId) && nullableText(value.summarySourceInsightId)
    && nullableNumber(value.summarySourceNoteRevision)
}

function isMilestone(value: unknown): value is Milestone {
  return record(value) && strings(value, ['id', 'areaId', 'name', 'goal', 'completionCriteria', 'latestProgress', 'nextStep', 'blockers'])
    && (value.kind === 'stage' || value.kind === 'ongoing')
    && ['planned', 'active', 'paused', 'completed', 'cancelled', 'ended'].includes(String(value.status))
    && nullableText(value.priority) && typeof value.archived === 'boolean' && revision(value.revision)
    && finite(value.createdAt) && finite(value.updatedAt) && nullableNumber(value.startDate)
    && nullableNumber(value.targetDate) && nullableNumber(value.completedAt) && nullableText(value.completionEventId)
}

/** Reject malformed project data before it reaches stores shared by the existing workspaces. */
export function validateProjectCatalog(value: unknown): { areas: Area[]; milestones: Milestone[] } {
  if (!record(value) || !Array.isArray(value.areas) || !value.areas.every(isArea)
    || !Array.isArray(value.milestones) || !value.milestones.every(isMilestone)) {
    throw new Error('方向与里程碑数据格式异常，请重试。')
  }
  // Return only known fields; response metadata must never replace store actions.
  return { areas: value.areas, milestones: value.milestones }
}

export function validateProjectReferences(value: unknown, sourceType: ProjectSourceType, sourceId: string): ProjectReferencesResult {
  if (!record(value) || value.sourceType !== sourceType || value.sourceId !== sourceId
    || !revision(value.projectRevision) || !Array.isArray(value.references)
    || !value.references.every(ref => record(ref)
      && strings(ref, ['id', 'targetId', 'name']) && ref.sourceType === sourceType && ref.sourceId === sourceId
      && (ref.targetType === 'area' || ref.targetType === 'milestone')
      && ['related', 'outcome', 'review', 'growth'].includes(String(ref.role))
      && (ref.origin === 'manual' || ref.origin === 'mention')
      && nullableText(ref.areaId) && nullableText(ref.areaName)
      && typeof ref.archived === 'boolean' && finite(ref.createdAt))) {
    throw new Error('关联项目信息格式异常，请重新加载后重试。')
  }
  return { sourceType, sourceId, projectRevision: value.projectRevision as number, references: value.references as ProjectReferencesResult['references'] }
}

export function projectErrorMessage(error: unknown): string {
  if (record(error)) {
    const response = record(error.response) ? error.response : null
    const data = response && record(response.data) ? response.data : null
    for (const candidate of [data?.message, data?.error, error.message]) {
      if (text(candidate) && candidate.trim()) return candidate
    }
  }
  return '操作未成功，请重试。'
}
