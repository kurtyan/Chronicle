/** Durable reviews and evidence-backed AI drafts. No model-generated value is a time statistic. */
export type ReviewTargetType = 'area' | 'milestone'
export type ProjectReviewKind = 'completion' | 'periodic'
export interface ReviewScope {
  targetType: ReviewTargetType
  targetId: string
  periodStart?: number | null
  periodEnd?: number | null
}
export interface ReviewEvidenceSource {
  id: string
  kind: 'target' | 'task' | 'task_entry' | 'note' | 'event'
  entityId: string
  taskId?: string
  title: string
  content: string
  contentHtml?: string
  createdAt: number | null
  updatedAt: number | null
  revision: number | null
  fingerprint: string
  role: 'primary' | 'background' | 'reference' | 'outcome' | 'review' | 'growth'
}
export interface ReviewEvidence {
  version: 1
  fingerprint: string
  scope: ReviewScope
  window: { start: number; end: number; asOf: number; timezone: string }
  target: Record<string, unknown>
  metrics: Record<string, unknown>
  sources: ReviewEvidenceSource[]
  analysis?: { batches: Array<{ index: number; status: 'submitted' | 'success' | 'error'; fragments: Array<{ sourceId: string; offset: number; content: string }> }> }
  coverage: { totalSources: number; totalCharacters: number; includedSources: number; includedCharacters: number; complete: boolean; warnings: string[] }
}
export interface ProjectReviewVersion {
  id: string
  reviewId: string
  version: number
  noteId: string
  noteRevision: number
  title: string
  contentHtml: string
  evidence: ReviewEvidence
  completionEventId: string | null
  confirmedAt: number
}
export interface ProjectReview extends ReviewScope {
  id: string
  kind: ProjectReviewKind
  noteId: string
  status: 'draft' | 'confirmed'
  completionEventId: string | null
  createdAt: number
  updatedAt: number
  confirmedAt: number | null
  noteRevision: number | null
  noteChangedSinceConfirmation: boolean
  versions?: ProjectReviewVersion[]
}
export interface InsightCitation { sourceId: string; quote: string }
export interface ProjectInsightPoint { text: string; citations: InsightCitation[] }
export interface ProjectInsightContent {
  observations: ProjectInsightPoint[]
  interpretations: ProjectInsightPoint[]
  evidenceGaps: string[]
  reflectionQuestions: string[]
  suggestedChecks: ProjectInsightPoint[]
}
export interface ProjectInsightBudget { inputCharacters: number; maxCalls: number; maxOutputTokens: number }
export interface ProjectInsightDraft extends ReviewScope {
  id: string
  status: 'running' | 'success' | 'error' | 'cancelled'
  evidence: ReviewEvidence
  content: ProjectInsightContent | null
  model: string
  promptVersion: string
  budget: ProjectInsightBudget
  backgroundTaskId: string | null
  error: string | null
  stale: boolean
  staleReason: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  acceptedNoteId: string | null
  acceptedAt: number | null
  previousDraftId: string | null
}
