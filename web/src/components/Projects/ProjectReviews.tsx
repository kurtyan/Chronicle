import { fetchStartOfDayOffset } from '@/services/api'
import { getWorkPeriodRange } from '@/lib/workPeriod'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { projectRequest, projectError } from '@/services/projectApi'
import type { ProjectReview, ProjectInsightDraft, ReviewEvidence, ReviewScope } from '../../../../shared/projectReviewTypes'
import type { Note } from '@/types'
import { getNoteById } from '@/services/api'
import { NotePickerDialog } from '@/components/NotePickerDialog'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { button, primaryButton, control, ErrorMessage, Empty, dateLabel, dateInputValue, useProjectRefresh } from './common'
import { useTaskStore } from '@/stores/taskStore'

export function ProjectEvidenceView({ evidence }: { evidence: ReviewEvidence }) {
  const navigate = useNavigate()
  return <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer">证据快照与来源（覆盖 {evidence.coverage.includedSources}/{evidence.coverage.totalSources}）</summary>
    <p className="mt-2 text-xs text-muted-foreground">取证时间 {dateLabel(evidence.window.asOf)} · {evidence.window.timezone} · {dateLabel(evidence.window.start)} — {dateLabel(evidence.window.end)}</p>
    {evidence.coverage.warnings.map((w, i) => <p className="mt-1 text-amber-600" key={i}>{w}</p>)}
    <details className="mt-2"><summary>系统计算的指标</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(evidence.metrics, null, 2)}</pre></details>
    <p className="mt-2 text-xs text-muted-foreground">以下保存取证当时的内容；当前原文可能已修订或删除。</p>
    <div className="mt-3 max-h-80 space-y-2 overflow-auto">{evidence.sources.map(source => <details key={source.id} id={`evidence-${source.id}`} className="rounded border p-2"><summary className="cursor-pointer">{source.title} · {source.kind} · {source.role}</summary><div className="mt-2 whitespace-pre-wrap break-words text-xs">{source.content}</div><div className="mt-2 text-xs text-muted-foreground">{source.id} · revision {source.revision ?? '—'}</div>{(source.kind === 'note' || source.kind === 'task' || source.kind === 'task_entry') && <button className="mt-2 text-xs underline" onClick={() => { if (source.kind === 'note') navigate(`/notes?id=${encodeURIComponent(source.entityId)}`); else { navigate('/'); void useTaskStore.getState().setActiveTask(source.taskId || source.entityId) } }}>打开当前原文</button>}</details>)}</div>
  </details>
}

export function ProjectReviews({ targetType, targetId, targetName, completed = false, periodStart, periodEnd }: ReviewScope & { targetName: string; completed?: boolean }) {
  const navigate = useNavigate()
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
  const [start, setStart] = useState(periodStart ? dateInputValue(periodStart) : '')
  const [end, setEnd] = useState(periodEnd ? dateInputValue(periodEnd - 1) : '')
  const refresh = useProjectRefresh()
  const [tick, setTick] = useState(0)
  const scope = { targetType, targetId, ...(start ? { periodStart: getWorkPeriodRange('day', new Date(`${start}T12:00:00`), workDayOffset).start } : {}), ...(end ? { periodEnd: getWorkPeriodRange('day', new Date(`${end}T12:00:00`), workDayOffset).end } : {}) }
  useEffect(() => { let active = true; Promise.all([projectRequest<ProjectReview[]>('get', '/api/project-reviews', { targetType, targetId }), projectRequest<ProjectInsightDraft[]>('get', '/api/project-insights', { targetType, targetId })]).then(([r, d]) => { if (active) { setReviews(r); setDrafts(d) } }).catch(e => { if (active) setError(projectError(e)) }); return () => { active = false } }, [targetType, targetId, refresh, tick])
  useEffect(() => { if (!drafts.some(d => d.status === 'running')) return; const timer = window.setTimeout(() => setTick(n => n + 1), 3000); return () => window.clearTimeout(timer) }, [drafts])
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError(projectError(e)) } finally { setBusy(false) } }
  const createReview = async (noteId?: string) => { const review = await projectRequest<ProjectReview>('post', '/api/project-reviews', { ...scope, kind: completed ? 'completion' : 'periodic', noteId, title: `${targetName} · ${completed ? '完成复盘' : '阶段回顾'}` }); if (mounted.current) navigate(`/notes?id=${encodeURIComponent(review.noteId)}`) }
  const accept = async (note?: Note) => {
    if (!selectedDraft) return
    await run(async () => {
      const current = note ? await getNoteById(note.id) : null
      const result = await projectRequest<Note | { note: Note }>('post', `/api/project-insights/${selectedDraft.id}/accept`, { noteId: note?.id, expectedNoteRevision: current?.revision, title: `${targetName} · 回顾草稿` })
      const accepted = 'note' in result ? result.note : result
      await projectRequest<ProjectReview>('post', '/api/project-reviews', { ...selectedDraft.evidence.scope, noteId: accepted.id, kind: completed ? 'completion' : 'periodic', insightDraftId: selectedDraft.id })
      if (mounted.current) navigate(`/notes?id=${encodeURIComponent(accepted.id)}`)
    })
  }
  return <section className="space-y-4 rounded-xl border bg-card p-4" data-testid="project-reviews">
    <div><h2 className="font-semibold">复盘与成长沉淀</h2><p className="mt-1 text-xs text-muted-foreground">工作状态和复盘确认分别管理。草稿可在 Notes 编辑，确认时保存内容及证据版本。</p></div>
    <div className="flex flex-wrap items-end gap-2"><label className="text-xs">回顾开始<input className={`${control} mt-1 block`} aria-label="回顾开始日期" type="date" value={start} onChange={e => setStart(e.target.value)} /></label><label className="text-xs">回顾结束<input className={`${control} mt-1 block`} aria-label="回顾结束日期" type="date" value={end} onChange={e => setEnd(e.target.value)} /></label><span className="pb-2 text-xs text-muted-foreground">留空使用全部记录</span></div>
    <label className="flex flex-wrap items-center gap-2 text-sm">分析覆盖预算<select className={control} value={analysisDepth} onChange={e => setAnalysisDepth(e.target.value)}><option value="standard">标准</option><option value="expanded">扩大历史覆盖</option><option value="maximum">最大历史覆盖</option></select><span className="text-xs text-muted-foreground">扩大预算会增加模型调用和等待时间，实际覆盖会在结果中说明。</span></label>
    <label className="flex flex-wrap items-center gap-2 text-sm">输出与推理预算<select aria-label="输出与推理预算" className={control} value={maxOutputTokens} onChange={e => setMaxOutputTokens(Number(e.target.value))}><option value={4000}>4,000 tokens</option><option value={8000}>8,000 tokens</option><option value={16000}>16,000 tokens</option></select><span className="text-xs text-muted-foreground">推理模型会同时消耗推理和最终输出预算。提高预算可减少截断，也会增加调用成本和等待时间；生成和重试均使用当前预算。</span></label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(() => createReview())}>新建{completed ? '完成复盘' : '阶段回顾'}</button><button className={button} disabled={busy} onClick={() => setPicker(true)}>关联已有 Note 为复盘</button><button className={primaryButton} disabled={busy} onClick={() => void run(async () => { const draft = await projectRequest<ProjectInsightDraft>('post', '/api/project-insights', { ...scope, budget: insightBudget }); setDrafts(ds => [draft, ...ds.filter(d => d.id !== draft.id)]) })}>生成 LLM 回顾草稿</button></div>
    <ErrorMessage>{error}</ErrorMessage>
    {!reviews.length && <Empty>还没有复盘。可以先记录结果、关键判断与感悟，稍后再确认。</Empty>}
    {reviews.map(review => <div key={review.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"><div><div>{review.kind === 'completion' ? '完成复盘' : '阶段回顾'} · {review.status === 'confirmed' ? '已确认' : '草稿'}</div><div className="text-xs text-muted-foreground">{dateLabel(review.confirmedAt || review.createdAt)}{review.noteChangedSinceConfirmation ? ' · Note 在确认后有新修改' : ''}{review.noteRevision === null ? ' · 原 Note 已删除，确认快照仍保留' : ''}</div></div><div className="flex flex-wrap gap-2">{review.noteRevision !== null && <button className={button} onClick={() => navigate(`/notes?id=${encodeURIComponent(review.noteId)}`)}>编辑 Note</button>}<button disabled={busy} className={button} onClick={() => void run(async () => { const current = await projectRequest<ProjectReview>('get', `/api/project-reviews/${review.id}`); setReviewNote(await getNoteById(current.noteId).catch(() => null)); setAcknowledgeStale(false); setSelectedReview(current) })}>核对 / 版本</button>{review.status === 'draft' && <button disabled={busy} className={button} onClick={() => void run(async () => { await projectRequest('delete', `/api/project-reviews/${review.id}`) })}>移除草稿关联</button>}</div></div>)}
    {!!drafts.length && <h3 className="text-sm font-semibold">LLM 草稿</h3>}
    {drafts.map(d => <div className="space-y-2 rounded-lg border p-3 text-sm" key={d.id}><div className="flex flex-wrap justify-between gap-2"><span>{({ running: '生成中', success: '待审阅', error: '生成失败', cancelled: '已取消' })[d.status]} · {dateLabel(d.createdAt)}{d.acceptedNoteId ? ' · 已采纳' : ''}</span>{d.stale && <span className="text-amber-600">来源已变化</span>}</div>{d.error && <p className="text-red-600">{d.error}</p>}<div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => void run(async () => { setSelectedDraft(await projectRequest<ProjectInsightDraft>('get', `/api/project-insights/${d.id}`)) })}>查看草稿与来源</button>{d.status === 'running' ? <button className={button} onClick={() => void run(async () => { await projectRequest('post', `/api/project-insights/${d.id}/cancel`) })}>取消生成</button> : <button disabled={busy} className={button} onClick={() => void run(async () => { await projectRequest('post', `/api/project-insights/${d.id}/retry`, { budget: insightBudget }) })}>重新生成</button>}</div></div>)}
    <NotePickerDialog open={picker} onOpenChange={setPicker} defaultTitle={`${targetName} · 复盘`} onPick={note => run(() => createReview(note.id))} />
    <Dialog open={!!selectedReview} onOpenChange={open => { if (!open) { setSelectedReview(null); setReviewNote(null); setAcknowledgeStale(false) } }}><DialogContent className="max-h-[90vh] sm:max-w-3xl"><DialogHeader><DialogTitle>复盘确认与历史版本</DialogTitle></DialogHeader><DialogBody className="space-y-4">{selectedReview && <><p className="text-sm">确认将保存当前 Note 的内容和取证快照。之后编辑 Note 不改变这个历史版本。</p>{reviewNote && <section className="rounded-lg border p-3"><h3 className="font-semibold">当前 Note：{reviewNote.title}</h3><p className="text-xs text-muted-foreground">待确认内容版本 {reviewNote.revision}</p><div className="prose-mirror-display my-3 text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(reviewNote.contentHtml) }} /></section>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledgeStale} onChange={e => setAcknowledgeStale(e.target.checked)} />若来源已经变化，我仍确认使用生成时保存的证据快照。</label>{reviewNote && <button disabled={busy} className={primaryButton} onClick={() => void run(async () => { setSelectedReview(await projectRequest<ProjectReview>('post', `/api/project-reviews/${selectedReview.id}/confirm`, { expectedNoteRevision: reviewNote.revision, acknowledgeStaleEvidence: acknowledgeStale })) })}>确认当前 Note 为复盘版本</button>}{selectedReview.versions?.map(v => <details key={v.id} className="rounded-lg border p-3" open><summary className="cursor-pointer text-sm">版本 {v.version} · {dateLabel(v.confirmedAt)} · {v.title}</summary><div className="prose-mirror-display my-3 text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(v.contentHtml) }} /><ProjectEvidenceView evidence={v.evidence} /></details>)}<ErrorMessage>{error}</ErrorMessage></>}</DialogBody></DialogContent></Dialog>
    <Dialog open={!!selectedDraft} onOpenChange={open => { if (!open) setSelectedDraft(null) }}><DialogContent className="max-h-[90vh] sm:max-w-3xl"><DialogHeader><DialogTitle>有来源的回顾草稿</DialogTitle></DialogHeader><DialogBody className="space-y-4">{selectedDraft && <><button className={button} disabled={busy} onClick={() => void run(async () => { setSelectedDraft(await projectRequest<ProjectInsightDraft>('get', `/api/project-insights/${selectedDraft.id}`)) })}>刷新草稿状态</button>{selectedDraft.stale && <p className="rounded border border-amber-400 p-3 text-sm text-amber-600">{selectedDraft.staleReason || '生成后来源有变化，请核对证据快照或重新生成。'}</p>}{selectedDraft.content ? <>{([['observations', '观察'], ['interpretations', '可能解释（待验证）'], ['suggestedChecks', '建议验证']] as const).map(([key, label]) => <section key={key}><h3 className="font-semibold">{label}</h3>{selectedDraft.content![key].map((point, i) => <div key={i} className="my-3 text-sm"><p className="whitespace-pre-wrap">{point.text}</p>{point.citations.map((c, j) => <details className="mt-1 rounded bg-muted p-2 text-xs" key={j}><summary className="cursor-pointer">来源：{selectedDraft.evidence.sources.find(s => s.id === c.sourceId)?.title || c.sourceId}</summary><blockquote className="mt-1 whitespace-pre-wrap">{c.quote}</blockquote></details>)}</div>)}</section>)}<h3 className="font-semibold">证据缺口</h3>{selectedDraft.content.evidenceGaps.map((text, i) => <p className="text-sm" key={i}>{text}</p>)}<h3 className="font-semibold">请补充你的认识和感受</h3>{selectedDraft.content.reflectionQuestions.map((text, i) => <p className="text-sm" key={i}>{text}</p>)}</> : <p className="text-sm">{selectedDraft.error || '尚无生成内容。'}</p>}<ProjectEvidenceView evidence={selectedDraft.evidence} />{selectedDraft.content && <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryButton} onClick={() => void accept()}>采纳到新 Note 并编辑</button><button disabled={busy} className={button} onClick={() => setAcceptPicker(true)}>追加到已有 Note</button></div>}<p className="text-xs text-muted-foreground">采纳保留为待编辑草稿，不自动确认复盘或完成里程碑。</p><ErrorMessage>{error}</ErrorMessage></>}</DialogBody></DialogContent></Dialog>
    <NotePickerDialog open={acceptPicker} onOpenChange={setAcceptPicker} onPick={accept} />
  </section>
}
