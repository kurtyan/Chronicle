/** Stable project object contracts. References never allocate recorded work time. */
export type AreaStatus = 'active' | 'paused' | 'ended'
export type MilestoneKind = 'stage' | 'ongoing'
export type MilestoneStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled' | 'ended'
export type ProjectTargetType = 'area' | 'milestone'
export type ProjectSourceType = 'task' | 'note'
export type ProjectReferenceRole = 'related' | 'outcome' | 'review' | 'growth'

export interface Area {
  id: string; name: string; description: string; focus: string; status: AreaStatus
  latestProgress: string; nextStep: string; summaryUpdatedAt: number | null
  summarySource: 'manual' | 'insight' | null
  summarySourceNoteId: string | null; summarySourceInsightId: string | null; summarySourceNoteRevision: number | null
  archived: boolean; revision: number; createdAt: number; updatedAt: number
}
export interface Milestone {
  id: string; areaId: string; name: string; kind: MilestoneKind; goal: string
  completionCriteria: string; status: MilestoneStatus; priority: string | null
  startDate: number | null; targetDate: number | null; archived: boolean; revision: number
  latestProgress: string; nextStep: string; blockers: string
  completedAt: number | null; completionEventId: string | null; createdAt: number; updatedAt: number
}
export interface CreateAreaInput { name: string; description?: string; focus?: string; status?: AreaStatus; latestProgress?: string; nextStep?: string }
export interface UpdateAreaInput extends Partial<CreateAreaInput> { expectedRevision: number; archived?: boolean }
/** User-reviewed summary text from an already accepted Area insight; never an automatic overwrite. */
export interface ApplyAreaInsightSummaryInput {
  insightDraftId: string; expectedRevision: number; expectedNoteRevision: number
  latestProgress: string; nextStep: string
}
export interface CreateMilestoneInput {
  areaId: string; name: string; kind?: MilestoneKind; goal?: string; completionCriteria?: string
  status?: MilestoneStatus; priority?: string | null; startDate?: number | null; targetDate?: number | null
  latestProgress?: string; nextStep?: string; blockers?: string
}
export interface UpdateMilestoneInput extends Partial<CreateMilestoneInput> {
  expectedRevision: number; archived?: boolean; confirmCompletion?: boolean
  confirmKindChange?: boolean; assignmentToken?: string
}
export interface ProjectListOptions { query?: string; includeArchived?: boolean; areaId?: string; status?: string; limit?: number; offset?: number }
export interface WorkStatisticsRange { start?: number; end?: number; asOf?: number }
export interface WorkStatisticsGroup { id: string; name: string; totalMs: number; taskCount: number }
export interface ProjectSession {
  id: string; taskId: string; startedAt: number; endedAt: number | null
  clippedStart: number; clippedEnd: number; durationMs: number; areaId: string | null; milestoneId: string | null
}
export interface WorkStatistics {
  start: number; end: number; asOf: number; totalMs: number; unassignedMs: number
  byArea: WorkStatisticsGroup[]; byMilestone: WorkStatisticsGroup[]; byTask: WorkStatisticsGroup[]
  sessions: ProjectSession[]; anomalies: Array<{ sessionId: string; reason: string }>
}
export interface ProjectTaskSummary {
  id: string; title: string; status: string; primaryMilestoneId: string | null; projectRevision: number
}
export interface MilestoneOverview extends Milestone {
  areaName: string; periodMs: number; totalMs: number
  taskCount: number; doneTaskCount: number; openTaskCount: number
  reviewStatus: 'pending' | 'confirmed' | 'none'; lastReviewedAt: number | null
}
export interface ProjectOverview {
  areas: Area[]; milestones: MilestoneOverview[]; statistics: WorkStatistics
  totalMilestoneCount: number
}
export interface ProjectReferenceInput { targetType: ProjectTargetType; targetId: string; role?: ProjectReferenceRole }
export interface ProjectReference extends ProjectReferenceInput {
  id: string; sourceType: ProjectSourceType; sourceId: string; role: ProjectReferenceRole
  origin: 'manual' | 'mention'; name: string; areaId: string | null; areaName: string | null
  archived: boolean; createdAt: number
}
export interface ProjectReferencesResult { sourceType: ProjectSourceType; sourceId: string; projectRevision: number; references: ProjectReference[] }
export interface ProjectBacklink {
  sourceType: ProjectSourceType; sourceId: string; title: string
  roles: ProjectReferenceRole[]; via: Array<{
    targetType: ProjectTargetType; targetId: string; name: string
    /** Derived context from an existing Task/Task Log link; never a direct project reference. */
    viaTaskId?: string; viaTaskTitle?: string; viaEntryId?: string
  }>
}
export interface ProjectBacklinks { tasks: ProjectBacklink[]; notes: ProjectBacklink[] }
export interface MilestoneDetail extends MilestoneOverview { tasks: ProjectTaskSummary[]; backlinks: ProjectBacklinks; statistics: WorkStatistics; events: ProjectEvent[] }
export interface AreaDetail extends Area { milestones: MilestoneOverview[]; backlinks: ProjectBacklinks; statistics: WorkStatistics; events: ProjectEvent[] }
export interface AssignmentChange { taskId: string; primaryMilestoneId: string | null; expectedRevision: number }
export interface AssignmentPreviewInput { changes?: AssignmentChange[]; milestoneId?: string; areaId?: string; expectedRevision?: number; asOf?: number }
export interface AssignmentPreview {
  token: string; kind: 'tasks' | 'milestone'; asOf: number; affectedTaskIds: string[]
  before: WorkStatistics; after: WorkStatistics; historicalStart: number | null; historicalEnd: number | null
}
export interface AssignmentResult { eventId: string; affectedTaskIds: string[]; additionalRecordedMs: number; statistics: WorkStatistics }
export interface ProjectEvent {
  id: string; targetType: string; targetId: string; kind: string
  before: unknown; after: unknown; createdAt: number; undoneAt: number | null
}
