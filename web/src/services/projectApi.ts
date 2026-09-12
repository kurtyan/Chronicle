import { withClientId } from './httpApi'
import { projectErrorMessage, validateProjectCatalog, validateProjectReferences } from './projectResponseValidation'
import type { Area, AreaDetail, ApplyAreaInsightSummaryInput, Milestone, MilestoneDetail, CreateAreaInput, UpdateAreaInput, CreateMilestoneInput, UpdateMilestoneInput, ProjectListOptions, ProjectOverview, WorkStatisticsRange, WorkStatistics, ProjectReferenceInput, ProjectSourceType, ProjectTargetType, AssignmentPreviewInput, AssignmentPreview, AssignmentResult } from '../../../shared/projectTypes'
export * from '../../../shared/projectTypes'

export function notifyProjectsChanged() { window.dispatchEvent(new Event('chronicle:projects-changed')) }
export const projectError = projectErrorMessage
export async function projectRequest<T>(method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: unknown): Promise<T> {
  const client = await withClientId()
  const { data } = await client.request<T>({ method, url, ...(method === 'get' ? { params: body } : { data: body }) })
  if (method !== 'get' && !url.endsWith('/preview')) notifyProjectsChanged()
  return data
}
export const projectApi = {
  catalog: async () => validateProjectCatalog(await projectRequest<unknown>('get', '/api/projects/catalog', { includeArchived: true })),
  areas: (params?: ProjectListOptions) => projectRequest<Area[]>('get', '/api/areas', params),
  milestones: (params?: ProjectListOptions) => projectRequest<Milestone[]>('get', '/api/milestones', params),
  area: (id: string, range?: WorkStatisticsRange) => projectRequest<AreaDetail>('get', `/api/areas/${encodeURIComponent(id)}`, range),
  milestone: (id: string, range?: WorkStatisticsRange) => projectRequest<MilestoneDetail>('get', `/api/milestones/${encodeURIComponent(id)}`, range),
  createArea: (body: CreateAreaInput) => projectRequest<Area>('post', '/api/areas', body),
  updateArea: (id: string, body: UpdateAreaInput) => projectRequest<Area>('patch', `/api/areas/${encodeURIComponent(id)}`, body),
  applyAreaInsightSummary: (id: string, body: ApplyAreaInsightSummaryInput) => projectRequest<Area>('post', `/api/areas/${encodeURIComponent(id)}/summary-from-insight`, body),
  createMilestone: (body: CreateMilestoneInput) => projectRequest<Milestone>('post', '/api/milestones', body),
  updateMilestone: (id: string, body: UpdateMilestoneInput) => projectRequest<Milestone>('patch', `/api/milestones/${encodeURIComponent(id)}`, body),
  overview: (params?: ProjectListOptions & WorkStatisticsRange) => projectRequest<ProjectOverview>('get', '/api/projects/overview', params),
  statistics: (params?: WorkStatisticsRange) => projectRequest<WorkStatistics>('get', '/api/projects/statistics', params),
  references: async (sourceType: ProjectSourceType, sourceId: string) => validateProjectReferences(await projectRequest<unknown>('get', '/api/project-references', { sourceType, sourceId }), sourceType, sourceId),
  setReferences: async (sourceType: ProjectSourceType, sourceId: string, expectedRevision: number, references: ProjectReferenceInput[]) => validateProjectReferences(await projectRequest<unknown>('put', '/api/project-references', { sourceType, sourceId, expectedRevision, references }), sourceType, sourceId),
  preview: (body: AssignmentPreviewInput) => projectRequest<AssignmentPreview>('post', '/api/projects/assignments/preview', body),
  apply: (token: string) => projectRequest<AssignmentResult>('post', '/api/projects/assignments/apply', { token }),
  undo: (eventId: string) => projectRequest<AssignmentResult>('post', '/api/projects/assignments/undo', { eventId }),
}
export const entityPath = (type: ProjectTargetType, id: string) => `/projects/${type === 'area' ? 'areas' : 'milestones'}/${encodeURIComponent(id)}`
