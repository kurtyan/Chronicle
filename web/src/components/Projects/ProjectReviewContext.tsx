import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check } from 'lucide-react'
import DOMPurify from 'dompurify'
import { useI18n } from '@/i18n/context'
import type { Note } from '@/types'
import type { ProjectReview, ProjectInsightDraft, ReviewEvidence, ReviewScope } from '../../../../shared/projectReviewTypes'
import type { ProjectNavigationContext } from '@/lib/projectNavigation'
import { projectRequest, projectError, entityPath } from '@/services/projectApi'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { button, primaryButton, ErrorMessage, useProjectLabels } from './common'
import { ProjectEvidenceView } from './ProjectReviews'

export function useReviewPeriodLabel() {
  const { t } = useI18n()
  const { dateLabel } = useProjectLabels()
  return (scope: Pick<ReviewScope, 'periodStart' | 'periodEnd'>) => {
    const hasStart = scope.periodStart != null && scope.periodStart > 0
    const hasEnd = scope.periodEnd != null
    if (hasStart && hasEnd) return `${dateLabel(scope.periodStart!)} – ${dateLabel(scope.periodEnd!)}`
    if (hasStart) return t('project.reviewWorkflow.from', { date: dateLabel(scope.periodStart!) })
    if (hasEnd) return t('project.reviewWorkflow.until', { date: dateLabel(scope.periodEnd!) })
    return t('project.reviewWorkflow.allTime')
  }
}

/** Only explicit project detours get this bar; all Note writes stay in NotesPage. */
export function ProjectReviewContext({ noteId, reviewId, navigation, onSave, isCurrent, dirty, currentRevision }: {
  noteId: string
  reviewId?: string | null
  navigation?: ProjectNavigationContext | null
  onSave: () => Promise<Note>
  isCurrent: (note: Note) => boolean
  dirty: boolean
  currentRevision: number
}) {
  const { t } = useI18n()
  const { dateLabel } = useProjectLabels()
  const periodLabel = useReviewPeriodLabel()
  const navigate = useNavigate()
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const [review, setReview] = useState<ProjectReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [stale, setStale] = useState(false)
  const [acknowledgeStale, setAcknowledgeStale] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [evidence, setEvidence] = useState<ReviewEvidence | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!reviewId) return
    let active = true
    projectRequest<ProjectReview>('get', `/api/project-reviews/${encodeURIComponent(reviewId)}`).then(value => {
      if (!active) return
      if (value.noteId !== noteId) { setError(t('project.reviewWorkflow.unavailable')); return }
      setReview(value)
    }).catch(err => { if (active) setError(projectError(err)) })
    return () => { active = false }
  }, [reviewId, noteId, t])

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (err: any) {
      if (!mounted.current) return
      const code = String(err?.response?.data?.error || err?.response?.data?.message || err?.message || '')
      if (code.includes('STALE_REVIEW_EVIDENCE')) { setStale(true); setError(t('project.reviewWorkflow.stale')) }
      else if (code.includes('NOTE_REVISION_CONFLICT')) setError(t('project.reviewWorkflow.changedElsewhere'))
      else setError(projectError(err))
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const confirm = () => run(async () => {
    if (!review) return
    const saved = await onSave()
    if (!mounted.current) return
    if (!isCurrent(saved)) throw new Error(t('project.reviewWorkflow.saveFailed'))
    const confirmed = await projectRequest<ProjectReview>('post', `/api/project-reviews/${review.id}/confirm`, { expectedNoteRevision: saved.revision, acknowledgeStaleEvidence: acknowledgeStale })
    if (!mounted.current) return
    // The persistent status below distinguishes the confirmed revision from
    // edits made during this request, without repeating the same success text.
    setReview(confirmed); setStale(false)
  })
  const showHistory = () => run(async () => {
    if (!review) return
    const current = await projectRequest<ProjectReview>('get', `/api/project-reviews/${review.id}`)
    const draft = current.insightDraftId ? await projectRequest<ProjectInsightDraft>('get', `/api/project-insights/${current.insightDraftId}`) : null
    if (mounted.current) { setReview(current); setEvidence(draft?.evidence || null); setHistoryOpen(true) }
  })
  const unconfirmedChanges = dirty || Boolean(review?.noteChangedSinceConfirmation) || Boolean(review?.versions?.[0] && review.versions[0].noteRevision !== currentRevision)
  const returnTo = navigation?.returnTo || (review ? entityPath(review.targetType, review.targetId) : null)
  const label = review ? periodLabel(review) : navigation?.periodLabel || (navigation ? periodLabel({ periodStart: navigation.range.start, periodEnd: navigation.range.end }) : '')
  return <section className="shrink-0 space-y-2 border-b border-border/70 bg-muted/30 px-[30px] py-3" data-testid="project-review-context">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="truncate text-sm font-medium">{review ? t('project.reviewWorkflow.reviewFor', { name: review.targetName || review.targetId }) : t('project.reviewWorkflow.context')}</p><p className="mt-1 text-xs text-muted-foreground">{review && `${t('project.reviewWorkflow.range')} · `}{label}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {review && <><button className={button} disabled={busy} onClick={() => void run(async () => { await onSave(); if (mounted.current) setNotice(t('project.reviewWorkflow.saved')) })}>{t('project.reviewWorkflow.save')}</button><button className={primaryButton} disabled={busy} onClick={() => void confirm()}>{t(review.status === 'confirmed' ? 'project.reviewWorkflow.confirmAnother' : 'project.reviewWorkflow.confirm')}</button></>}
        {returnTo && <button className={`${button} inline-flex items-center gap-1.5`} disabled={busy} title={t('project.reviewWorkflow.returnHint')} onClick={() => void run(async () => { const saved = await onSave(); if (!mounted.current) return; if (!isCurrent(saved)) throw new Error(t('project.reviewWorkflow.saveFailed')); navigate(returnTo) })}><ArrowLeft className="h-3.5 w-3.5" />{review?.targetName ? t('project.reviewWorkflow.returnTo', { name: review.targetName }) : t('project.reviewWorkflow.return')}</button>}
      </div>
    </div>
    {review && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"><p>{t('project.reviewWorkflow.independent')}</p><button className="underline underline-offset-2 hover:text-foreground" disabled={busy} onClick={() => void showHistory()}>{t('project.reviewWorkflow.checkEvidence')}</button>{review.status === 'confirmed' && <span className="inline-flex items-center gap-1"><Check className="h-3 w-3" />{unconfirmedChanges ? t('project.reviewWorkflow.newChanges') : t('project.reviewWorkflow.confirmed', { version: String(review.confirmedVersion || 1) })}</span>}</div>}
    {busy && <p role="status" className="text-xs text-muted-foreground">{t('project.reviewWorkflow.saving')}</p>}
    {notice && !unconfirmedChanges && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    <ErrorMessage>{error}</ErrorMessage>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogContent className="max-h-[90vh] sm:max-w-3xl" onEscapeKeyDown={event => { if (busy) event.preventDefault() }}><DialogHeader><DialogTitle>{t('project.reviewWorkflow.checkEvidence')}</DialogTitle></DialogHeader><DialogBody className="space-y-4">{evidence && <ProjectEvidenceView evidence={evidence} />}{stale && evidence && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledgeStale} onChange={event => setAcknowledgeStale(event.target.checked)} />{t('project.reviewWorkflow.useSnapshot')}</label>}{review?.versions?.map(version => <details key={version.id} className="rounded-lg border p-3" open><summary className="text-sm">{t('project.review.version')} {version.version} · {dateLabel(version.confirmedAt)} · {version.title}</summary><div className="prose-mirror-display py-3 text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(version.contentHtml) }} /><ProjectEvidenceView evidence={version.evidence} /></details>)}</DialogBody></DialogContent></Dialog>
  </section>
}
