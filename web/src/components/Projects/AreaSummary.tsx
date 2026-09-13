import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useI18n } from '@/i18n/context'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { getNoteById } from '@/services/api'
import { projectApi, projectError, projectRequest } from '@/services/projectApi'
import type { Area, ProjectEvent } from '../../../../shared/projectTypes'
import type { ProjectInsightDraft, ProjectInsightPoint, ReviewScope } from '../../../../shared/projectReviewTypes'
import type { Note } from '@/types'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProjectEvidenceView } from './ProjectReviews'
import { button, control, ErrorMessage, primaryButton, useProjectRefresh, useProjectLabels } from './common'
import { withProjectNavigation, projectNavigationState } from '@/lib/projectNavigation'
import type { ProjectNavigationContext } from '@/lib/projectNavigation'

interface SummaryEditor {
  latestProgress: string
  nextStep: string
  expectedRevision: number
  insight: ProjectInsightDraft | null
  acceptedNote?: Note
}

// Keep unsaved text across route navigation, including opening a source Note.
// Server refreshes never replace a user's editor snapshot.
const editors = new Map<string, SummaryEditor>()

export interface AreaSummaryProps {
  area: Area
  compact?: boolean
  lane?: boolean
  onUpdated?: () => void
  actionsOnly?: boolean
  navigationContext?: ProjectNavigationContext
}

export function AreaSummary(props: AreaSummaryProps) {
  return <AreaSummaryPanel key={props.area.id} {...props} />
}

function AreaSummaryPanel({ area, compact = false, lane = false, onUpdated, actionsOnly = false, navigationContext }: AreaSummaryProps) {
  const { t, locale } = useI18n()
  const { dateLabel } = useProjectLabels()
  const draftLabel: Record<ProjectInsightDraft['status'], string> = {
    running: t('project.review.running'), success: t('project.summary.ready'), error: t('project.review.failed'), cancelled: t('project.review.cancelled'),
  }
  const scopeLabel = (scope: Pick<ReviewScope, 'periodStart' | 'periodEnd'>) => {
    const start = scope.periodStart != null && scope.periodStart > 0 ? dateLabel(scope.periodStart) : null
    const end = scope.periodEnd != null ? dateLabel(scope.periodEnd) : null
    return start && end ? `${start} – ${end}` : start ? t('project.reviewWorkflow.from', { date: start }) : end ? t('project.reviewWorkflow.until', { date: end }) : t('project.reviewWorkflow.allTime')
  }
  const viewingScope = { periodStart: navigationContext?.range.start ?? null, periodEnd: navigationContext?.range.end ?? null }
  const summarySource = (area: Partial<Area>) => area.summarySource === 'insight' ? t('project.summary.sourceAI') : t('project.summary.sourceManual')
  const navigate = useNavigate()
  const refresh = useProjectRefresh()
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [savedArea, setSavedArea] = useState<Area | null>(null)
  const currentArea = savedArea && savedArea.revision > area.revision ? savedArea : area
  const [editorKey, setEditorKey] = useState<string | null>(null)
  const [editor, setEditor] = useState<SummaryEditor | null>(null)
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [drafts, setDrafts] = useState<ProjectInsightDraft[]>([])
  const [draftsLoading, setDraftsLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const [history, setHistory] = useState<ProjectEvent[] | null>(null)
  const [analysisDepth, setAnalysisDepth] = useState('standard')
  const [maxOutputTokens, setMaxOutputTokens] = useState(4000)
  const budget = {
    inputCharacters: analysisDepth === 'expanded' ? 240000 : 96000,
    maxCalls: analysisDepth === 'expanded' ? 12 : 6,
    maxOutputTokens,
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!draftsOpen) return
    let active = true
    setDraftsLoading(true)
    projectRequest<ProjectInsightDraft[]>('get', '/api/project-insights', { targetType: 'area', targetId: area.id })
      .then(data => { if (active) setDrafts(data) })
      .catch(e => { if (active) setError(projectError(e)) })
      .finally(() => { if (active) setDraftsLoading(false) })
    return () => { active = false }
  }, [area.id, draftsOpen, refresh, tick])
  useEffect(() => {
    if (!draftsOpen || !drafts.some(draft => draft.status === 'running')) return
    const timer = window.setTimeout(() => setTick(value => value + 1), 3000)
    return () => window.clearTimeout(timer)
  }, [drafts, draftsOpen])
  const editingInsightId = editor?.insight?.id
  useEffect(() => {
    if (!editingInsightId || !editorKey) return
    let active = true
    projectRequest<ProjectInsightDraft>('get', `/api/project-insights/${editingInsightId}`).then(insight => {
      if (!active) return
      setEditor(value => {
        if (!value || value.insight?.id !== editingInsightId) return value
        const next = { ...value, insight }
        editors.set(editorKey, next)
        return next
      })
    }).catch(e => { if (active) setError(projectError(e)) })
    return () => { active = false }
  }, [editingInsightId, editorKey, refresh])

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { if (mounted.current) setError(projectError(e)) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const openEditor = (insight: ProjectInsightDraft | null = null, acceptedNote?: Note) => {
    const key = `${area.id}:${insight?.id || 'manual'}`
    const cached = editors.get(key)
    const value = cached ? { ...cached, insight: insight || cached.insight } : {
      latestProgress: insight ? insight.content!.observations.map(point => point.text).join('\n\n') : currentArea.latestProgress,
      nextStep: insight ? insight.content!.suggestedChecks.map(point => point.text).join('\n\n') : currentArea.nextStep,
      expectedRevision: currentArea.revision,
      insight,
      acceptedNote,
    }
    editors.set(key, value)
    setEditorKey(key); setEditor(value); setDraftsOpen(false); setError(''); setNotice('')
  }
  const reviewDraft = (draft: ProjectInsightDraft) => run(async () => {
    const accepted = draft.acceptedNoteId ? await getNoteById(draft.acceptedNoteId) : null
    if (draft.acceptedNoteId && !accepted) throw new Error(t('project.summary.missingDraftNote'))
    if (mounted.current) openEditor(draft, accepted || undefined)
  })
  const changeEditor = (change: Partial<SummaryEditor>) => {
    if (!editor || !editorKey) return
    const next = { ...editor, ...change }
    editors.set(editorKey, next); setEditor(next)
  }
  const save = () => run(async () => {
    if (!editor || !editorKey) return
    const values = { latestProgress: editor.latestProgress.trim(), nextStep: editor.nextStep.trim(), expectedRevision: editor.expectedRevision }
    let updated: Area
    if (editor.insight) {
      // The existing acceptance endpoint is idempotent. A retry after an Area
      // revision conflict reuses the same Note instead of creating another one.
      const accepted = await projectRequest<{ draft: ProjectInsightDraft; note: Note }>('post', `/api/project-insights/${editor.insight.id}/accept`, { title: t('project.summary.draftNoteTitle', { name: area.name }) })
      const sourceNote = editor.acceptedNote || accepted.note
      const withSource = { ...editor, acceptedNote: sourceNote, insight: accepted.draft }
      editors.set(editorKey, withSource)
      if (mounted.current) setEditor(withSource)
      updated = await projectApi.applyAreaInsightSummary(area.id, {
        ...values, insightDraftId: editor.insight.id, expectedNoteRevision: sourceNote.revision,
      })
    } else updated = await projectApi.updateArea(area.id, values)
    editors.delete(editorKey)
    if (mounted.current) {
      setSavedArea(updated); setEditor(null); setEditorKey(null)
      setNotice(editor.insight ? t('project.summary.adopted') : t('project.summary.saved'))
      onUpdated?.()
    }
  })
  const generate = (previous?: ProjectInsightDraft) => run(async () => {
    const draft = await projectRequest<ProjectInsightDraft>('post', previous ? `/api/project-insights/${previous.id}/retry` : '/api/project-insights', previous ? { budget, locale } : { targetType: 'area', targetId: area.id, ...viewingScope, budget, locale })
    if (mounted.current) { setDrafts(list => [draft, ...list.filter(item => item.id !== draft.id)]); setTick(value => value + 1) }
  })
  const showHistory = () => run(async () => {
    const detail = await projectApi.area(area.id)
    if (!mounted.current) return
    setSavedArea(detail)
    setHistory(detail.events.filter(event => {
      const before = event.before as Partial<Area> | null
      const after = event.after as Partial<Area> | null
      return !!after && (before?.latestProgress !== after.latestProgress || before?.nextStep !== after.nextStep || before?.summaryUpdatedAt !== after.summaryUpdatedAt) && !!(after.summaryUpdatedAt || after.latestProgress || after.nextStep)
    }))
  })
  const openNote = (id: string) => run(async () => {
    const note = await getNoteById(id)
    if (!note) throw new Error(t('project.summary.missingSource'))
    if (mounted.current) navigate(navigationContext ? withProjectNavigation(`/notes?id=${encodeURIComponent(id)}`, navigationContext) : `/notes?id=${encodeURIComponent(id)}`, navigationContext ? { state: projectNavigationState(navigationContext) } : undefined)
  })

  const summaryButton = lane ? 'rounded text-[11px] text-muted-foreground hover:text-primary hover:underline disabled:opacity-50' : button

  return <section className={lane ? 'flex flex-col gap-2' : compact ? 'space-y-2' : 'space-y-4'} data-testid="area-summary">
    <div className={lane ? 'order-2 space-y-1.5' : 'flex flex-wrap items-start justify-between gap-2'}>
      {!actionsOnly && <div>{!compact && <h2 className="text-sm font-semibold">{t('project.summary.heading')}</h2>}<p className={lane ? 'text-[10px] text-muted-foreground' : 'mt-1 text-xs text-muted-foreground'}>{currentArea.summaryUpdatedAt ? `${summarySource(currentArea)} · ${lane ? new Date(currentArea.summaryUpdatedAt).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : dateLabel(currentArea.summaryUpdatedAt)}` : lane ? t('project.summary.notUpdated') : t('project.summary.description')}</p></div>}
      <div className="flex flex-wrap gap-2">{!actionsOnly && <button className={summaryButton} disabled={busy} onClick={() => openEditor()}>{t('project.summary.edit')}</button>}<button className={summaryButton} disabled={busy} onClick={() => { setError(''); setDraftsOpen(true) }}>{t(actionsOnly ? 'project.object.summaryAi' : 'project.review.aiDrafts')}</button><button className={summaryButton} disabled={busy} onClick={() => void showHistory()}>{t('project.summary.history')}</button></div>
    </div>
    {!actionsOnly && <div className={lane ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2'}>
      {([[t('project.summary.progress'), currentArea.latestProgress || t('project.summary.noProgress')], [t('project.summary.nextStep'), currentArea.nextStep || t('project.summary.noNextStep')]] as const).map(([heading, text]) => <div key={heading} className={lane ? 'line-clamp-2 text-xs leading-5' : ''} title={lane ? `${heading}: ${text}` : undefined}><h3 className={`text-xs font-semibold text-muted-foreground ${lane ? 'inline' : ''}`}>{heading}{lane ? ': ' : ''}</h3><p className={lane ? 'inline break-words' : `mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed ${compact ? 'line-clamp-2' : ''}`}>{text}</p></div>)}
    </div>}
    {currentArea.summarySourceNoteId && <button className="text-xs text-primary underline" disabled={busy} onClick={() => void openNote(currentArea.summarySourceNoteId!)}>{t('project.summary.sourceRevision')} {currentArea.summarySourceNoteRevision}</button>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {!editor && !draftsOpen && <ErrorMessage>{error}</ErrorMessage>}

    <Dialog open={!!editor} onOpenChange={open => { if (!open && !busy) { setEditor(null); setEditorKey(null); setError('') } }}>
      <DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} className="max-h-[90vh] sm:max-w-3xl"><DialogHeader><DialogTitle>{editor?.insight ? t('project.summary.reviewTitle') : t('project.summary.editTitle')} · {area.name}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">{editor && <>
          <p className="text-sm text-muted-foreground">{editor.insight ? t('project.summary.reviewHint') : t('project.summary.editHint')}</p>
          {editor.insight?.stale && <p className="rounded-lg border border-amber-500/30 p-3 text-sm text-amber-700">{editor.insight.staleReason || t('project.summary.staleHint')}</p>}
          {editor.insight && (!editor.insight.evidence.coverage.complete || editor.insight.evidence.coverage.warnings.length > 0) && <div className="rounded-lg border border-amber-500/30 p-3 text-sm text-amber-700"><p>{t('project.summary.coverage', { included: String(editor.insight.evidence.coverage.includedSources), total: String(editor.insight.evidence.coverage.totalSources) })}</p>{editor.insight.evidence.coverage.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
          <label className="block text-sm font-medium">{t('project.summary.progress')}<textarea className={`${control} mt-1 min-h-32 w-full font-normal`} aria-label={t('project.summary.progressInput')} value={editor.latestProgress} disabled={busy} onChange={event => changeEditor({ latestProgress: event.target.value })} /></label>
          <label className="block text-sm font-medium">{t('project.summary.nextStep')}<textarea className={`${control} mt-1 min-h-32 w-full font-normal`} aria-label={t('project.summary.nextStepInput')} value={editor.nextStep} disabled={busy} onChange={event => changeEditor({ nextStep: event.target.value })} /></label>
          {editor.insight && <>
            <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">{t('project.summary.checkSources')}</summary><div className="mt-3 space-y-4"><InsightPoints title={t('project.review.observations')} points={editor.insight.content!.observations} draft={editor.insight} onOpenNote={id => void openNote(id)} /><InsightPoints title={t('project.review.suggestedChecks')} points={editor.insight.content!.suggestedChecks} draft={editor.insight} onOpenNote={id => void openNote(id)} />{editor.insight.content!.evidenceGaps.map((gap, index) => <p className="text-amber-700" key={index}>{t('project.summary.gapPrefix')}{gap}</p>)}</div></details>
            <ProjectEvidenceView evidence={editor.insight.evidence} />
            {editor.acceptedNote && <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">{t('project.summary.acceptedRevision')} {editor.acceptedNote.revision}</summary><h3 className="mt-2 font-semibold">{editor.acceptedNote.title}</h3><div className="prose-mirror-display mt-2" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(editor.acceptedNote.contentHtml) }} /><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => { const current = await getNoteById(editor.acceptedNote!.id); if (!current) throw new Error(t('project.summary.sourceDeleted')); if (mounted.current) changeEditor({ acceptedNote: current }) })}>{t('project.summary.reloadNote')}</button></details>}
          </>}
          {editor.expectedRevision !== currentArea.revision && <div className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm"><p>{t('project.summary.conflict')}</p><p className="whitespace-pre-wrap">{t('project.summary.progressPrefix')}{currentArea.latestProgress || t('project.summary.blank')}</p><p className="whitespace-pre-wrap">{t('project.summary.nextStepPrefix')}{currentArea.nextStep || t('project.summary.blank')}</p><button className={button} disabled={busy} onClick={() => changeEditor({ expectedRevision: currentArea.revision })}>{t('project.summary.keepEdit')}</button></div>}
          <ErrorMessage>{error}</ErrorMessage>
          <p className="text-xs text-muted-foreground">{t('project.summary.localDraftHint')}{editor.insight ? t('project.summary.adoptHint') : ''}</p>
        </>}</DialogBody>
        <DialogFooter><button className={button} disabled={busy} onClick={() => { if (editorKey) editors.delete(editorKey); setEditor(null); setEditorKey(null); setError('') }}>{t('project.summary.discard')}</button><button className={button} disabled={busy} onClick={() => { setEditor(null); setEditorKey(null); setError('') }}>{t('project.summary.keepAndClose')}</button><button className={primaryButton} disabled={busy || !editor || editor.expectedRevision !== currentArea.revision} onClick={() => void save()}>{busy ? t('project.details.saving') : editor?.insight ? t('project.summary.adopt') : t('project.summary.save')}</button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={draftsOpen} onOpenChange={open => { if (!busy) { setDraftsOpen(open); setError('') } }}>
      <DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} className="max-h-[90vh] sm:max-w-2xl"><DialogHeader><DialogTitle>{t('project.summary.draftsTitle')}</DialogTitle></DialogHeader><DialogBody className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('project.summary.generationHint')}</p>
        <p className="text-xs text-muted-foreground" data-testid="area-summary-generation-scope">{t('project.object.analysisPeriod', { period: navigationContext?.periodLabel || scopeLabel(viewingScope) })}<span className="mt-1 block">{scopeLabel(viewingScope)}</span></p>
        <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">{t('project.summary.advanced')}</summary><div className="mt-3 space-y-3"><label className="flex flex-wrap items-center gap-2">{t('project.summary.historyCoverage')}<ProjectSelect label={t('project.review.coverage')} value={analysisDepth} onChange={setAnalysisDepth} options={[{ value: 'standard', label: t('project.review.standard') }, { value: 'expanded', label: t('project.review.expanded') }]} /></label><label className="flex flex-wrap items-center gap-2">{t('project.review.outputBudget')}<ProjectSelect label={t('project.review.outputBudget')} value={String(maxOutputTokens)} onChange={value => setMaxOutputTokens(Number(value))} options={[4000, 8000, 16000].map(value => ({ value: String(value), label: `${value.toLocaleString(locale)} tokens` }))} /></label><p className="text-xs text-muted-foreground">{t('project.summary.budgetHint')}</p></div></details>
        <button className={primaryButton} disabled={busy || drafts.some(draft => draft.status === 'running')} onClick={() => void generate()}>{t('project.summary.generate')}</button>
        <ErrorMessage>{error}</ErrorMessage>
        {draftsLoading && !drafts.length && <p role="status" className="text-sm text-muted-foreground">{t('project.summary.loading')}</p>}
        {!draftsLoading && !drafts.length && <p className="text-sm text-muted-foreground">{t('project.summary.noDrafts')}</p>}
        {drafts.map(draft => <article key={draft.id} data-summary-draft={draft.id} className="space-y-2 rounded-lg border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>{draftLabel[draft.status]} · {dateLabel(draft.createdAt)}{draft.acceptedNoteId ? t('project.summary.sourceSaved') : ''}</span>{draft.stale && <span className="text-amber-700">{t('project.review.stale')}</span>}</div><p className="text-xs text-muted-foreground" data-testid="area-summary-draft-scope">{scopeLabel(draft)}</p>{draft.error && <p role="alert" className="whitespace-pre-wrap text-red-600">{draft.error}</p>}{draft.status === 'running' && <p role="status" className="text-xs text-muted-foreground">{t('project.summary.generatingHint')}</p>}<div className="flex flex-wrap gap-2">{draft.status === 'success' && draft.content && <button className={primaryButton} disabled={busy} onClick={() => void reviewDraft(draft)}>{t('project.summary.reviewEdit')}</button>}{draft.status === 'running' ? <button className={button} disabled={busy} onClick={() => void run(async () => { await projectRequest('post', `/api/project-insights/${draft.id}/cancel`); if (mounted.current) setTick(value => value + 1) })}>{t('project.review.cancelGeneration')}</button> : <button className={button} disabled={busy || drafts.some(item => item.status === 'running')} onClick={() => void generate(draft)}>{draft.status === 'error' || draft.status === 'cancelled' ? t('project.summary.retry') : t('project.review.regenerate')}</button>}{draft.acceptedNoteId && <button className={button} disabled={busy} onClick={() => void openNote(draft.acceptedNoteId!)}>{t('project.summary.viewSource')}</button>}</div></article>)}
      </DialogBody></DialogContent>
    </Dialog>

    <Dialog open={history !== null} onOpenChange={open => { if (!open) setHistory(null) }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} className="max-h-[90vh] sm:max-w-2xl"><DialogHeader><DialogTitle>{t('project.summary.historyTitle')} {area.name}</DialogTitle></DialogHeader><DialogBody className="space-y-3">{history?.length === 0 && <p className="text-sm text-muted-foreground">{t('project.summary.noHistory')}</p>}{history?.map(event => {
      const snapshot = event.after as Partial<Area>
      return <article className="space-y-2 rounded-lg border p-3 text-sm" key={event.id}><p className="text-xs text-muted-foreground">{dateLabel(event.createdAt)} · {summarySource(snapshot)}</p><h3 className="font-semibold">{t('project.summary.progress')}</h3><p className="whitespace-pre-wrap break-words">{snapshot.latestProgress || t('project.summary.notRecorded')}</p><h3 className="font-semibold">{t('project.summary.nextStep')}</h3><p className="whitespace-pre-wrap break-words">{snapshot.nextStep || t('project.summary.notRecorded')}</p>{snapshot.summarySourceNoteId && <button className="text-primary underline" disabled={busy} onClick={() => void openNote(snapshot.summarySourceNoteId!)}>{t('project.summary.sourceRevision')} {snapshot.summarySourceNoteRevision}</button>}</article>
    })}<ErrorMessage>{error}</ErrorMessage></DialogBody></DialogContent></Dialog>
  </section>
}

function InsightPoints({ title, points, draft, onOpenNote }: { title: string; points: ProjectInsightPoint[]; draft: ProjectInsightDraft; onOpenNote: (id: string) => void }) {
  const { t } = useI18n()
  return <section className="space-y-2"><h3 className="font-semibold">{title}</h3>{points.map((point, index) => <div key={index} className="space-y-1"><p className="whitespace-pre-wrap">{point.text}</p>{point.citations.map((citation, citationIndex) => {
    const source = draft.evidence.sources.find(item => item.id === citation.sourceId)
    return <details className="rounded bg-muted p-2 text-xs" key={citationIndex}><summary className="cursor-pointer">{t('project.review.sourcePrefix')}{source?.title || citation.sourceId}</summary><blockquote className="mt-1 whitespace-pre-wrap">{citation.quote}</blockquote>{source?.kind === 'note' && <button className="mt-2 text-primary underline" onClick={() => onOpenNote(source.entityId)}>{t('project.summary.openNote')}</button>}</details>
  })}</div>)}</section>
}
