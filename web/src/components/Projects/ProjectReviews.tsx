import { withProjectNavigation, projectNavigationState } from '@/lib/projectNavigation'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useI18n } from '@/i18n/context'
import { fetchStartOfDayOffset } from '@/services/api'
import { getWorkPeriodRange } from '@/lib/workPeriod'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { projectRequest, projectError } from '@/services/projectApi'
import type { ProjectReview, ProjectInsightDraft, ReviewEvidence, ReviewScope } from '../../../../shared/projectReviewTypes'
import type { Note } from '@/types'
import { getNoteById } from '@/services/api'
import { NotePickerDialog } from '@/components/NotePickerDialog'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { button, primaryButton, control, ErrorMessage, Empty, dateInputValue, useProjectRefresh, useProjectLabels } from './common'
import { useTaskStore } from '@/stores/taskStore'

export function ProjectEvidenceView({ evidence }: { evidence: ReviewEvidence }) {
  const { t } = useI18n()
  const { dateLabel } = useProjectLabels()
  const navigate = useNavigate()
  return <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer">{t('project.review.evidenceTitle', { included: String(evidence.coverage.includedSources), total: String(evidence.coverage.totalSources) })}</summary>
    <p className="mt-2 text-xs text-muted-foreground">{t('project.review.capturedAt')} {dateLabel(evidence.window.asOf)} · {evidence.window.timezone} · {dateLabel(evidence.window.start)} — {dateLabel(evidence.window.end)}</p>
    {evidence.coverage.warnings.map((w, i) => <p className="mt-1 text-amber-600" key={i}>{w}</p>)}
    <details className="mt-2"><summary>{t('project.review.metrics')}</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(evidence.metrics, null, 2)}</pre></details>
    <p className="mt-2 text-xs text-muted-foreground">{t('project.review.snapshotHint')}</p>
    <div className="mt-3 max-h-80 space-y-2 overflow-auto">{evidence.sources.map(source => <details key={source.id} id={`evidence-${source.id}`} className="rounded border p-2"><summary className="cursor-pointer">{source.title} · {t(`project.review.source.${source.kind}`)} · {t(`project.review.role.${source.role}`)}</summary><div className="mt-2 whitespace-pre-wrap break-words text-xs">{source.content}</div><div className="mt-2 text-xs text-muted-foreground">{source.id} · {t('project.review.revision', { revision: String(source.revision ?? '—') })}</div>{(source.kind === 'note' || source.kind === 'task' || source.kind === 'task_entry') && <button className="mt-2 text-xs underline" onClick={() => { if (source.kind === 'note') navigate(`/notes?id=${encodeURIComponent(source.entityId)}`); else { navigate('/'); void useTaskStore.getState().setActiveTask(source.taskId || source.entityId) } }}>{t('project.review.openSource')}</button>}</details>)}</div>
  </details>
}

export function ProjectReviews({ targetType, targetId, targetName, completed = false, periodStart, periodEnd, returnTo, periodLabel }: ReviewScope & { targetName: string; completed?: boolean; returnTo?: string; periodLabel?: string }) {
  const { t, locale } = useI18n()
  const { dateLabel } = useProjectLabels()
  const navigate = useNavigate()
  const location = useLocation()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [reviews, setReviews] = useState<ProjectReview[]>([])
  const [drafts, setDrafts] = useState<ProjectInsightDraft[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [analysisDepth, setAnalysisDepth] = useState('standard')
  const [maxOutputTokens, setMaxOutputTokens] = useState(4000)
  const insightBudget = {
    inputCharacters: analysisDepth === 'maximum' ? 480000 : analysisDepth === 'expanded' ? 240000 : 96000,
    maxCalls: analysisDepth === 'maximum' ? 24 : analysisDepth === 'expanded' ? 12 : 6,
    maxOutputTokens,
  }
  const [picker, setPicker] = useState(false)
  const [selectedReview, setSelectedReview] = useState<ProjectReview | null>(null)
  const [reviewNote, setReviewNote] = useState<Note | null>(null)
  const [acknowledgeStale, setAcknowledgeStale] = useState(false)
  const [workDayOffset, setWorkDayOffset] = useState(5)
  useEffect(() => { fetchStartOfDayOffset().then(setWorkDayOffset).catch(() => {}) }, [])
  const [selectedDraft, setSelectedDraft] = useState<ProjectInsightDraft | null>(null)
  const [acceptPicker, setAcceptPicker] = useState(false)
  const [rangeOverride, setRangeOverride] = useState<{ start: string; end: string } | null>(null)
  // A custom review period belongs to this object. Statistics refreshes and
  // viewing-period changes must not erase it; restoring the view is explicit.
  useEffect(() => { setRangeOverride(null) }, [targetType, targetId])
  const start = rangeOverride?.start ?? (periodStart != null && periodStart > 0 ? dateInputValue(periodStart - workDayOffset * 3_600_000) : '')
  const end = rangeOverride?.end ?? (periodEnd != null ? dateInputValue(periodEnd - 1 - workDayOffset * 3_600_000) : '')
  const invalidRange = !!(start && end && start > end)
  const refresh = useProjectRefresh()
  const [tick, setTick] = useState(0)
  const scope: ReviewScope = rangeOverride ? { targetType, targetId, periodStart: start ? getWorkPeriodRange('day', new Date(`${start}T12:00:00`), workDayOffset).start : null, periodEnd: end ? getWorkPeriodRange('day', new Date(`${end}T12:00:00`), workDayOffset).end : null } : { targetType, targetId, periodStart: periodStart ?? null, periodEnd: periodEnd ?? null }
  const rangeLabel = (value: Pick<ReviewScope, 'periodStart' | 'periodEnd'>) => {
    const first = value.periodStart != null && value.periodStart > 0 ? dateLabel(value.periodStart) : null
    const last = value.periodEnd != null ? dateLabel(value.periodEnd) : null
    return first && last ? `${first} – ${last}` : first ? t('project.reviewWorkflow.from', { date: first }) : last ? t('project.reviewWorkflow.until', { date: last }) : t('project.reviewWorkflow.allTime')
  }
  const openReviewNote = (review: ProjectReview) => {
    const context = { returnTo: returnTo || location.pathname + location.search, range: { ...(review.periodStart != null ? { start: review.periodStart } : {}), ...(review.periodEnd != null ? { end: review.periodEnd } : {}) }, periodLabel: rangeOverride ? rangeLabel(review) : periodLabel || rangeLabel(review) }
    navigate(withProjectNavigation(`/notes?id=${encodeURIComponent(review.noteId)}&projectReview=${encodeURIComponent(review.id)}`, context), { state: projectNavigationState(context) })
  }
  useEffect(() => { let active = true; Promise.all([projectRequest<ProjectReview[]>('get', '/api/project-reviews', { targetType, targetId }), projectRequest<ProjectInsightDraft[]>('get', '/api/project-insights', { targetType, targetId })]).then(([r, d]) => { if (active) { setReviews(r); setDrafts(d) } }).catch(e => { if (active) setError(projectError(e)) }); return () => { active = false } }, [targetType, targetId, refresh, tick])
  useEffect(() => { if (!drafts.some(d => d.status === 'running')) return; const timer = window.setTimeout(() => setTick(n => n + 1), 3000); return () => window.clearTimeout(timer) }, [drafts])
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError(projectError(e)) } finally { setBusy(false) } }
  const createReview = async (noteId?: string) => {
    if (invalidRange) throw new Error(t('project.reviewWorkflow.invalidRange'))
    const headings = (completed ? ['outcome', 'decisions', 'worked', 'learning', 'limits'] : ['change', 'contribution', 'reflections', 'validation']).map(key => t(`project.review.template.${key}`))
    const contentHtml = headings.map(heading => `<h2>${heading.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2><p></p>`).join('')
    const review = await projectRequest<ProjectReview>('post', '/api/project-reviews', { ...scope, locale, kind: completed ? 'completion' : 'periodic', noteId, title: `${targetName} · ${completed ? t('project.review.completion') : t('project.review.periodic')}`, ...(noteId ? {} : { contentHtml }) })
    if (mounted.current) openReviewNote(review)
  }
  const accept = async (note?: Note) => {
    if (!selectedDraft) return
    await run(async () => {
      const current = note ? await getNoteById(note.id) : null
      const result = await projectRequest<Note | { note: Note }>('post', `/api/project-insights/${selectedDraft.id}/accept`, { noteId: note?.id, expectedNoteRevision: current?.revision, title: t('project.review.draftNoteTitle', { name: targetName }) })
      const accepted = 'note' in result ? result.note : result
      const review = await projectRequest<ProjectReview>('post', '/api/project-reviews', { ...selectedDraft.evidence.scope, noteId: accepted.id, kind: completed ? 'completion' : 'periodic', insightDraftId: selectedDraft.id })
      if (mounted.current) openReviewNote(review)
    })
  }
  return <section className="space-y-4 border-t border-border/60 pt-6" data-testid="project-reviews">
    <div><h2 className="font-semibold">{t('project.review.heading')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('project.review.description')}</p></div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><p><span className="font-medium">{t('project.reviewWorkflow.range')} · </span>{rangeLabel(scope)}</p><div className="flex items-center gap-2 text-muted-foreground"><span>{t(rangeOverride ? 'project.reviewWorkflow.customRange' : 'project.reviewWorkflow.inheritedRange')}</span>{rangeOverride && <button className="underline underline-offset-2" onClick={() => setRangeOverride(null)}>{t('project.reviewWorkflow.restoreRange')}</button>}</div></div>
    <details className="text-sm" data-testid="project-review-period-editor"><summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t('project.reviewWorkflow.changeRange')}</summary><div className="mt-3 flex flex-wrap items-end gap-2"><label className="text-xs">{t('project.review.start')}<input className={`${control} mt-1 block`} aria-label={t('project.review.startDate')} type="date" value={start} onChange={e => setRangeOverride({ start: e.target.value, end })} /></label><label className="text-xs">{t('project.review.end')}<input className={`${control} mt-1 block`} aria-label={t('project.review.endDate')} type="date" value={end} onChange={e => setRangeOverride({ start, end: e.target.value })} /></label><span className="pb-2 text-xs text-muted-foreground">{t('project.review.allRecordsHint')}</span></div></details>
    <details className="text-sm"><summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t('project.summary.advanced')}</summary><div className="mt-3 space-y-3 rounded-md border border-border/60 p-3">
    <label className="flex flex-wrap items-center gap-2 text-sm">{t('project.review.coverage')}<ProjectSelect label={t('project.review.coverage')} value={analysisDepth} onChange={setAnalysisDepth} options={[{ value: 'standard', label: t('project.review.standard') }, { value: 'expanded', label: t('project.review.expanded') }, { value: 'maximum', label: t('project.review.maximum') }]} /><span className="text-xs text-muted-foreground">{t('project.review.coverageHint')}</span></label>
    <label className="flex flex-wrap items-center gap-2 text-sm">{t('project.review.outputBudget')}<ProjectSelect label={t('project.review.outputBudget')} value={String(maxOutputTokens)} onChange={value => setMaxOutputTokens(Number(value))} options={[4000, 8000, 16000].map(value => ({ value: String(value), label: `${value.toLocaleString(locale)} tokens` }))} /><span className="text-xs text-muted-foreground">{t('project.review.budgetHint')}</span></label>
    </div></details>
    <div className="flex flex-wrap gap-2"><button data-project-review-create className={primaryButton} disabled={busy || invalidRange} onClick={() => void run(() => createReview())}>{t(completed ? 'project.review.newCompletion' : 'project.review.newPeriodic')}</button><button className={button} disabled={busy || invalidRange} onClick={() => setPicker(true)}>{t('project.review.linkExisting')}</button><button className={button} disabled={busy || invalidRange} onClick={() => void run(async () => { const draft = await projectRequest<ProjectInsightDraft>('post', '/api/project-insights', { ...scope, locale, budget: insightBudget }); setDrafts(ds => [draft, ...ds.filter(d => d.id !== draft.id)]) })}>{t('project.review.generate')}</button></div>
    <ErrorMessage>{invalidRange ? t('project.reviewWorkflow.invalidRange') : error}</ErrorMessage>
    {!reviews.length && <Empty>{t('project.review.empty')}</Empty>}
    {reviews.map(review => <article key={review.id} className="space-y-3 rounded-lg border border-border/60 p-4 text-sm" data-testid="project-review-card">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-medium">{(review.status === 'confirmed' ? review.confirmedTitle : null) || review.noteTitle || (review.kind === 'completion' ? t('project.review.completion') : t('project.review.periodic'))}</h3><p className="mt-1 text-xs text-muted-foreground">{review.kind === 'completion' ? t('project.review.completion') : t('project.review.periodic')} · {review.status === 'confirmed' ? t('project.review.confirmed') : t('project.review.draft')}</p><p className="mt-1 text-xs text-muted-foreground">{rangeLabel(review)}</p></div><span className="text-xs text-muted-foreground">{dateLabel(review.confirmedAt || review.createdAt)}</span></div>
      <div><p className="mb-1 text-xs text-muted-foreground">{t(review.status === 'confirmed' ? 'project.reviewWorkflow.confirmedPreview' : 'project.reviewWorkflow.draftPreview')}</p><p className="line-clamp-3 whitespace-pre-wrap leading-relaxed">{review.status === 'confirmed' ? review.confirmedPreview || t('project.reviewWorkflow.noConclusion') : review.notePreview || t('project.reviewWorkflow.noDraft')}</p></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{review.noteChangedSinceConfirmation ? t('project.review.noteChanged') : ''}{review.noteRevision === null ? t('project.review.noteDeleted') : ''}</p><div className="flex flex-wrap gap-2">{review.noteRevision !== null && <button className={button} onClick={() => openReviewNote(review)}>{review.status === 'draft' ? t('project.reviewWorkflow.edit') : t('project.review.editNote')}</button>}<button disabled={busy} className={button} onClick={() => void run(async () => { const current = await projectRequest<ProjectReview>('get', `/api/project-reviews/${review.id}`); setReviewNote(await getNoteById(current.noteId).catch(() => null)); setAcknowledgeStale(false); setSelectedReview(current) })}>{t('project.review.checkVersions')}</button>{review.status === 'draft' && <button disabled={busy} className={button} onClick={() => void run(async () => { await projectRequest('delete', `/api/project-reviews/${review.id}`) })}>{t('project.review.removeDraftLink')}</button>}</div></div>
    </article>)}
    {!!drafts.length && <h3 className="text-sm font-semibold">{t('project.review.aiDrafts')}</h3>}
    {drafts.map(d => <div className="space-y-2 rounded-lg border p-3 text-sm" key={d.id}><div className="flex flex-wrap justify-between gap-2"><span>{({ running: t('project.review.running'), success: t('project.review.ready'), error: t('project.review.failed'), cancelled: t('project.review.cancelled') })[d.status]} · {dateLabel(d.createdAt)}{d.acceptedNoteId ? t('project.review.accepted') : ''}</span>{d.stale && <span className="text-amber-600">{t('project.review.stale')}</span>}</div>{d.error && <p className="text-red-600">{d.error}</p>}<div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => void run(async () => { setSelectedDraft(await projectRequest<ProjectInsightDraft>('get', `/api/project-insights/${d.id}`)) })}>{t('project.review.viewDraft')}</button>{d.status === 'running' ? <button className={button} onClick={() => void run(async () => { await projectRequest('post', `/api/project-insights/${d.id}/cancel`) })}>{t('project.review.cancelGeneration')}</button> : <button disabled={busy} className={button} onClick={() => void run(async () => { await projectRequest('post', `/api/project-insights/${d.id}/retry`, { locale, budget: insightBudget }) })}>{t('project.review.regenerate')}</button>}</div></div>)}
    <NotePickerDialog open={picker} onOpenChange={setPicker} defaultTitle={t('project.review.noteTitle', { name: targetName })} onPick={note => run(() => createReview(note.id))} />
    <Dialog open={!!selectedReview} onOpenChange={open => { if (!open) { setSelectedReview(null); setReviewNote(null); setAcknowledgeStale(false) } }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} className="max-h-[90vh] sm:max-w-3xl"><DialogHeader><DialogTitle>{t('project.review.versionsTitle')}</DialogTitle></DialogHeader><DialogBody className="space-y-4">{selectedReview && <><p className="text-sm">{t('project.review.confirmHint')}</p>{reviewNote && <section className="rounded-lg border p-3"><h3 className="font-semibold">{t('project.review.currentNotePrefix')}{reviewNote.title}</h3><p className="text-xs text-muted-foreground">{t('project.review.pendingRevision')} {reviewNote.revision}</p><div className="prose-mirror-display my-3 text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(reviewNote.contentHtml) }} /></section>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledgeStale} onChange={e => setAcknowledgeStale(e.target.checked)} />{t('project.review.acknowledgeStale')}</label>{reviewNote && <button disabled={busy} className={primaryButton} onClick={() => void run(async () => { setSelectedReview(await projectRequest<ProjectReview>('post', `/api/project-reviews/${selectedReview.id}/confirm`, { expectedNoteRevision: reviewNote.revision, acknowledgeStaleEvidence: acknowledgeStale })) })}>{t('project.review.confirmNote')}</button>}{selectedReview.versions?.map(v => <details key={v.id} className="rounded-lg border p-3" open><summary className="cursor-pointer text-sm">{t('project.review.version')} {v.version} · {dateLabel(v.confirmedAt)} · {v.title}</summary><div className="prose-mirror-display my-3 text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(v.contentHtml) }} /><ProjectEvidenceView evidence={v.evidence} /></details>)}<ErrorMessage>{error}</ErrorMessage></>}</DialogBody></DialogContent></Dialog>
    <Dialog open={!!selectedDraft} onOpenChange={open => { if (!open) setSelectedDraft(null) }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} className="max-h-[90vh] sm:max-w-3xl"><DialogHeader><DialogTitle>{t('project.review.draftTitle')}</DialogTitle></DialogHeader><DialogBody className="space-y-4">{selectedDraft && <><button className={button} disabled={busy} onClick={() => void run(async () => { setSelectedDraft(await projectRequest<ProjectInsightDraft>('get', `/api/project-insights/${selectedDraft.id}`)) })}>{t('project.review.refreshDraft')}</button>{selectedDraft.stale && <p className="rounded border border-amber-400 p-3 text-sm text-amber-600">{selectedDraft.staleReason || t('project.review.staleHint')}</p>}{selectedDraft.content ? <>{([['observations', t('project.review.observations')], ['interpretations', t('project.review.interpretations')], ['suggestedChecks', t('project.review.suggestedChecks')]] as const).map(([key, label]) => <section key={key}><h3 className="font-semibold">{label}</h3>{selectedDraft.content![key].map((point, i) => <div key={i} className="my-3 text-sm"><p className="whitespace-pre-wrap">{point.text}</p>{point.citations.map((c, j) => <details className="mt-1 rounded bg-muted p-2 text-xs" key={j}><summary className="cursor-pointer">{t('project.review.sourcePrefix')}{selectedDraft.evidence.sources.find(s => s.id === c.sourceId)?.title || c.sourceId}</summary><blockquote className="mt-1 whitespace-pre-wrap">{c.quote}</blockquote></details>)}</div>)}</section>)}<h3 className="font-semibold">{t('project.review.evidenceGaps')}</h3>{selectedDraft.content.evidenceGaps.map((text, i) => <p className="text-sm" key={i}>{text}</p>)}<h3 className="font-semibold">{t('project.review.reflectionQuestions')}</h3>{selectedDraft.content.reflectionQuestions.map((text, i) => <p className="text-sm" key={i}>{text}</p>)}</> : <p className="text-sm">{selectedDraft.error || t('project.review.noContent')}</p>}<ProjectEvidenceView evidence={selectedDraft.evidence} />{selectedDraft.content && <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryButton} onClick={() => void accept()}>{t('project.review.acceptNew')}</button><button disabled={busy} className={button} onClick={() => setAcceptPicker(true)}>{t('project.review.appendNote')}</button></div>}<p className="text-xs text-muted-foreground">{t('project.review.acceptHint')}</p><ErrorMessage>{error}</ErrorMessage></>}</DialogBody></DialogContent></Dialog>
    <NotePickerDialog open={acceptPicker} onOpenChange={setAcceptPicker} onPick={accept} />
  </section>
}
