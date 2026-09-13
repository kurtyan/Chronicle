import { projectLocale, projectLocaleCopy } from './projectLocale'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { htmlToPlainText } from './searchText'
import { createNote, getNoteById } from './noteService'
import { addProjectReference } from './projectReferenceService'
import { buildReviewEvidence, getInsightOutputNoteIds, getReviewTarget, isReviewEvidenceStale, validateReviewScope } from './reviewEvidenceService'
import type { ProjectLocale, ProjectReview, ProjectReviewKind, ProjectReviewVersion, ReviewEvidence, ReviewScope } from '../../../shared/projectReviewTypes'

export interface CreateProjectReviewInput extends ReviewScope {
  kind: ProjectReviewKind
  locale?: ProjectLocale
  noteId?: string
  title?: string
  contentHtml?: string
  completionEventId?: string | null
  insightDraftId?: string
}

export function escapeReviewHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Add one formal Note reference without replacing its other targets or roles. */
export function linkReviewNote(noteId: string, scope: ReviewScope, role: 'review' | 'growth' = 'review'): void {
  addProjectReference('note', noteId, { targetType: scope.targetType, targetId: scope.targetId, role })
}

function mapVersion(row: any): ProjectReviewVersion {
  return { id: row.id, reviewId: row.review_id, version: row.version, noteId: row.note_id, noteRevision: row.note_revision, title: row.title, contentHtml: row.content_html, evidence: JSON.parse(row.evidence_json), completionEventId: row.completion_event_id, confirmedAt: row.confirmed_at }
}

const emptyReviewTemplates = new Set(Object.values(projectLocaleCopy).flatMap(copy => [
  copy.completionHeadings.join(' '), copy.periodicHeadings.join(' '),
]))

function reviewPreview(html: string | null | undefined): string | null {
  if (!html) return null
  // A heading is valid authored content, including text entered into the first
  // block of a review template. Only an entirely untouched template is empty;
  // neither the heading level nor a special section title identifies a lesson.
  const text = htmlToPlainText(html)
  return text && !emptyReviewTemplates.has(text) ? text.slice(0, 280) : null
}

function mapReview(row: any): ProjectReview {
  const latest = getDb().prepare('SELECT note_id, note_revision, version, title, content_html FROM project_review_versions WHERE review_id = ? ORDER BY version DESC LIMIT 1').get(row.id) as any
  const note = getNoteById(row.note_id)
  const target = getDb().prepare(`SELECT name FROM ${row.target_type === 'area' ? 'areas' : 'milestones'} WHERE id = ?`).get(row.target_id) as { name: string } | undefined
  return {
    id: row.id, targetType: row.target_type, targetId: row.target_id, kind: row.kind, noteId: row.note_id,
    periodStart: row.period_start, periodEnd: row.period_end, status: row.status, completionEventId: row.completion_event_id,
    createdAt: row.created_at, updatedAt: row.updated_at, confirmedAt: row.confirmed_at,
    noteRevision: note?.revision ?? null,
    targetName: target?.name ?? null, noteTitle: note?.title ?? latest?.title ?? null, notePreview: reviewPreview(note?.contentHtml),
    insightDraftId: row.insight_draft_id ?? null,
    confirmedTitle: latest?.title ?? null, confirmedPreview: reviewPreview(latest?.content_html), confirmedVersion: latest?.version ?? null,
    noteChangedSinceConfirmation: Boolean(latest && (!note || latest.note_id !== note.id || latest.note_revision !== note.revision)),
  }
}

export function listProjectReviews(targetType?: string, targetId?: string): ProjectReview[] {
  if (targetType && !['area', 'milestone'].includes(targetType)) throw new Error('Invalid review target')
  return (getDb().prepare(`SELECT * FROM project_reviews WHERE (? IS NULL OR target_type = ?) AND (? IS NULL OR target_id = ?) ORDER BY created_at DESC, id`).all(targetType ?? null, targetType ?? null, targetId ?? null, targetId ?? null) as any[]).map(mapReview)
}

export function getProjectReview(id: string): ProjectReview | null {
  const row = getDb().prepare('SELECT * FROM project_reviews WHERE id = ?').get(id) as any
  if (!row) return null
  return { ...mapReview(row), versions: (getDb().prepare('SELECT * FROM project_review_versions WHERE review_id = ? ORDER BY version DESC').all(id) as any[]).map(mapVersion) }
}

function validateCompletionEvent(scope: ReviewScope, eventId: string | null): void {
  if (!eventId) return
  const event = getDb().prepare('SELECT * FROM project_events WHERE id = ?').get(eventId) as any
  if (!event || event.target_type !== scope.targetType || event.target_id !== scope.targetId) throw new Error('Completion event does not belong to review target')
  const after = event.after_json ? JSON.parse(event.after_json) : {}
  if (!['completed', 'cancelled', 'ended'].includes(after.status) && !['completed', 'cancelled', 'ended', 'complete', 'completion'].includes(event.kind)) throw new Error('Review requires a completion or termination event')
}

function resolveCompletionEvent(scope: ReviewScope, target: Record<string, any>, provided?: string | null): string | null {
  if (provided || target.completion_event_id) return provided ?? target.completion_event_id
  if (scope.targetType !== 'milestone' || target.status !== 'cancelled') return null
  const events = getDb().prepare("SELECT * FROM project_events WHERE target_type = 'milestone' AND target_id = ? ORDER BY created_at DESC, rowid DESC").all(scope.targetId) as any[]
  return events.find(event => {
    const after = event.after_json ? JSON.parse(event.after_json) : {}, before = event.before_json ? JSON.parse(event.before_json) : {}
    return after.status === 'cancelled' && before.status !== 'cancelled'
  })?.id ?? null
}

export function createProjectReview(input: CreateProjectReviewInput): ProjectReview {
  const scope = validateReviewScope(input)
  const copy = projectLocaleCopy[projectLocale(input.locale)]
  if ((input.title !== undefined && typeof input.title !== 'string') || (input.contentHtml !== undefined && typeof input.contentHtml !== 'string')) throw new Error('Invalid review title or content')
  const target = getReviewTarget(scope)
  if (!['completion', 'periodic'].includes(input.kind)) throw new Error('Invalid review kind')
  if (input.kind === 'completion' && (scope.targetType !== 'milestone' || target.kind !== 'stage')) throw Object.assign(new Error('Completion reviews require a stage milestone; use a periodic review for ongoing work'), { status: 400, code: 'INVALID_REVIEW_KIND' })
  const completionEventId = input.kind === 'completion' ? resolveCompletionEvent(scope, target, input.completionEventId) : null
  validateCompletionEvent(scope, completionEventId)
  if (input.insightDraftId) {
    const draft = getDb().prepare('SELECT * FROM project_insight_drafts WHERE id = ?').get(input.insightDraftId) as any
    if (!draft || draft.status !== 'success' || draft.target_type !== scope.targetType || draft.target_id !== scope.targetId) throw new Error('Insight draft does not match review target')
    if (input.periodStart === undefined) scope.periodStart = draft.period_start
    if (input.periodEnd === undefined) scope.periodEnd = draft.period_end
    if (scope.periodStart !== draft.period_start || scope.periodEnd !== draft.period_end) throw new Error('Insight evidence period does not match review period')
  }
  if (input.noteId && !getNoteById(input.noteId)) throw new Error('Note not found')
  return getDb().transaction(() => {
    // The UI adopts a draft then creates its review in two requests. Retrying a
    // lost response must not create a second review for the same adopted Note.
    if (input.insightDraftId && input.noteId) {
      const existing = getDb().prepare('SELECT id FROM project_reviews WHERE insight_draft_id = ? AND note_id = ? AND target_type = ? AND target_id = ? AND kind = ? AND period_start IS ? AND period_end IS ? AND completion_event_id IS ? ORDER BY created_at, rowid LIMIT 1').get(input.insightDraftId, input.noteId, scope.targetType, scope.targetId, input.kind, scope.periodStart, scope.periodEnd, completionEventId) as { id: string } | undefined
      if (existing) return getProjectReview(existing.id)!
    }
    const note = input.noteId ? getNoteById(input.noteId)! : createNote({
      title: input.title?.trim() || `${target.name} · ${input.kind === 'completion' ? copy.completionTitle : copy.periodicTitle}`,
      contentHtml: input.contentHtml ?? (input.kind === 'completion' ? copy.completionHeadings : copy.periodicHeadings).map(heading => `<h2>${escapeReviewHtml(heading)}</h2><p></p>`).join(''),
      tags: [copy.reviewTag],
    })
    linkReviewNote(note.id, scope)
    const id = randomUUID(), now = Date.now()
    getDb().prepare(`INSERT INTO project_reviews(id,target_type,target_id,kind,note_id,period_start,period_end,status,completion_event_id,insight_draft_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?)`).run(id, scope.targetType, scope.targetId, input.kind, note.id, scope.periodStart, scope.periodEnd, completionEventId, input.insightDraftId ?? null, now, now)
    return getProjectReview(id)!
  })()
}

export function updateProjectReview(id: string, input: { noteId?: string; periodStart?: number | null; periodEnd?: number | null }): ProjectReview | null {
  const review = getProjectReview(id)
  if (!review) return null
  if (review.status === 'confirmed') throw new Error('Confirmed review metadata is immutable; create a new review for a different scope')
  const scope = validateReviewScope({ ...review, ...input })
  const noteId = input.noteId ?? review.noteId
  if (!getNoteById(noteId)) throw new Error('Note not found')
  return getDb().transaction(() => {
    linkReviewNote(noteId, scope)
    const changedScope = scope.periodStart !== review.periodStart || scope.periodEnd !== review.periodEnd
    getDb().prepare(`UPDATE project_reviews SET note_id = ?, period_start = ?, period_end = ?, ${changedScope ? 'insight_draft_id = NULL,' : ''} updated_at = ? WHERE id = ?`).run(noteId, scope.periodStart, scope.periodEnd, Date.now(), id)
    return getProjectReview(id)
  })()
}

export function confirmProjectReview(id: string, input: { expectedNoteRevision: number; acknowledgeStaleEvidence?: boolean }): ProjectReview | null {
  const review = getProjectReview(id)
  if (!review) return null
  if (!Number.isInteger(input.expectedNoteRevision) || input.expectedNoteRevision < 1) throw new Error('expectedNoteRevision is required')
  if (input.acknowledgeStaleEvidence !== undefined && typeof input.acknowledgeStaleEvidence !== 'boolean') throw new Error('Invalid stale evidence acknowledgement')
  return getDb().transaction(() => {
    const note = getNoteById(review.noteId)
    if (!note) throw new Error('Note not found')
    if (note.revision !== input.expectedNoteRevision) throw new Error('NOTE_REVISION_CONFLICT')
    const target = getReviewTarget(review)
    const completionEventId = review.kind === 'completion' ? resolveCompletionEvent(review, target, review.completionEventId) : null
    if (review.kind === 'completion' && !completionEventId) throw new Error('Complete or terminate the milestone before confirming its completion review')
    validateCompletionEvent(review, completionEventId)
    const row = getDb().prepare('SELECT insight_draft_id FROM project_reviews WHERE id = ?').get(id) as any
    const latest = review.versions?.[0]
    // A retransmitted confirmation of an unchanged Note/source state is the
    // same confirmation, even though the wall clock has advanced.
    if (!row.insight_draft_id && latest?.noteRevision === note.revision && latest.noteId === note.id && latest.completionEventId === completionEventId && !isReviewEvidenceStale(latest.evidence).stale) return review
    let evidence: ReviewEvidence
    if (row.insight_draft_id) {
      const draft = getDb().prepare('SELECT * FROM project_insight_drafts WHERE id = ?').get(row.insight_draft_id) as any
      if (!draft || draft.status !== 'success') throw new Error('Insight draft not available')
      evidence = JSON.parse(draft.evidence_json)
      if (isReviewEvidenceStale(evidence, { excludeNoteIds: getInsightOutputNoteIds(row.insight_draft_id, evidence) }).stale && !input.acknowledgeStaleEvidence) throw new Error('STALE_REVIEW_EVIDENCE')
    } else evidence = buildReviewEvidence(review)
    if (latest?.noteRevision === note.revision && latest.noteId === note.id && latest.evidence.fingerprint === evidence.fingerprint && latest.completionEventId === completionEventId) return review
    const now = Date.now()
    getDb().prepare(`INSERT INTO project_review_versions(id,review_id,version,note_id,note_revision,title,content_html,evidence_json,completion_event_id,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), id, (latest?.version ?? 0) + 1, note.id, note.revision, note.title, note.contentHtml, JSON.stringify(evidence), completionEventId, now)
    getDb().prepare("UPDATE project_reviews SET status = 'confirmed', completion_event_id = ?, confirmed_at = ?, updated_at = ? WHERE id = ?").run(completionEventId, now, now, id)
    return getProjectReview(id)
  })()
}

export function deleteProjectReview(id: string): boolean {
  const review = getProjectReview(id)
  if (!review) return false
  if (review.status === 'confirmed' || review.versions?.length) throw new Error('Confirmed review versions cannot be deleted')
  return getDb().prepare('DELETE FROM project_reviews WHERE id = ?').run(id).changes > 0
}
