import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { getNoteById } from '@/services/api'
import { projectApi, projectError, projectRequest } from '@/services/projectApi'
import type { Area, ProjectEvent } from '../../../../shared/projectTypes'
import type { ProjectInsightDraft, ProjectInsightPoint } from '../../../../shared/projectReviewTypes'
import type { Note } from '@/types'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProjectEvidenceView } from './ProjectReviews'
import { button, control, dateLabel, ErrorMessage, primaryButton, useProjectRefresh } from './common'

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
const draftLabel: Record<ProjectInsightDraft['status'], string> = {
  running: '生成中', success: '可审阅', error: '生成失败', cancelled: '已取消',
}
const summarySource = (area: Partial<Area>) => area.summarySource === 'insight' ? 'LLM 草稿，经手工采用' : '手工更新'

export interface AreaSummaryProps {
  area: Area
  compact?: boolean
  lane?: boolean
  onUpdated?: () => void
}

export function AreaSummary(props: AreaSummaryProps) {
  return <AreaSummaryPanel key={props.area.id} {...props} />
}

function AreaSummaryPanel({ area, compact = false, lane = false, onUpdated }: AreaSummaryProps) {
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
    if (draft.acceptedNoteId && !accepted) throw new Error('这个草稿的来源 Note 已删除，请重新生成草稿。')
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
      const accepted = await projectRequest<{ draft: ProjectInsightDraft; note: Note }>('post', `/api/project-insights/${editor.insight.id}/accept`, { title: `${area.name} · 方向进展与下一步草稿` })
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
      setNotice(editor.insight ? '已采用为当前摘要，来源草稿保存在关联 Note 中。' : '方向摘要已保存，上一版保留在摘要历史中。')
      onUpdated?.()
    }
  })
  const generate = (previous?: ProjectInsightDraft) => run(async () => {
    const draft = await projectRequest<ProjectInsightDraft>('post', previous ? `/api/project-insights/${previous.id}/retry` : '/api/project-insights', previous ? { budget } : { targetType: 'area', targetId: area.id, budget })
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
    if (!note) throw new Error('来源 Note 已删除，摘要与历史快照仍然保留。')
    if (mounted.current) navigate(`/notes?id=${encodeURIComponent(id)}`)
  })

  const summaryButton = lane ? 'rounded text-[11px] text-muted-foreground hover:text-primary hover:underline disabled:opacity-50' : button

  return <section className={lane ? 'flex flex-col gap-2' : compact ? 'space-y-2' : 'space-y-3 rounded-xl border border-primary/15 bg-primary/[0.025] p-4'} data-testid="area-summary">
    <div className={lane ? 'order-2 space-y-1.5' : 'flex flex-wrap items-start justify-between gap-2'}>
      <div>{!compact && <h2 className="text-sm font-semibold">方向进展与下一步</h2>}<p className={lane ? 'text-[10px] text-muted-foreground' : 'mt-1 text-xs text-muted-foreground'}>{currentArea.summaryUpdatedAt ? `${summarySource(currentArea)} · ${lane ? new Date(currentArea.summaryUpdatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : dateLabel(currentArea.summaryUpdatedAt)}` : lane ? '摘要尚未更新' : '写下这个方向目前走到哪里，以及接下来准备做什么。'}</p></div>
      <div className="flex flex-wrap gap-2"><button className={summaryButton} disabled={busy} onClick={() => openEditor()}>编辑摘要</button><button className={summaryButton} disabled={busy} onClick={() => { setError(''); setDraftsOpen(true) }}>LLM 草稿</button><button className={summaryButton} disabled={busy} onClick={() => void showHistory()}>摘要历史</button></div>
    </div>
    <div className={lane ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2'}>
      {([['最新进展', currentArea.latestProgress || '尚未记录最新进展'], ['下一步计划', currentArea.nextStep || '尚未记录下一步计划']] as const).map(([heading, text]) => <div key={heading} className={lane ? 'line-clamp-2 text-xs leading-5' : ''} title={lane ? `${heading}：${text}` : undefined}><h3 className={`text-xs font-semibold text-muted-foreground ${lane ? 'inline' : ''}`}>{heading}{lane ? '：' : ''}</h3><p className={lane ? 'inline break-words' : `mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed ${compact ? 'line-clamp-2' : ''}`}>{text}</p></div>)}
    </div>
    {currentArea.summarySourceNoteId && <button className="text-xs text-primary underline" disabled={busy} onClick={() => void openNote(currentArea.summarySourceNoteId!)}>查看来源 Note · 采用时版本 {currentArea.summarySourceNoteRevision}</button>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {!editor && !draftsOpen && <ErrorMessage>{error}</ErrorMessage>}

    <Dialog open={!!editor} onOpenChange={open => { if (!open && !busy) { setEditor(null); setEditorKey(null); setError('') } }}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl"><DialogHeader><DialogTitle>{editor?.insight ? '审阅并采用方向摘要' : '编辑方向摘要'} · {area.name}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">{editor && <>
          <p className="text-sm text-muted-foreground">{editor.insight ? '最新进展来自模型的观察，下一步来自建议验证。请结合来源修改为你认可的表述，再采用为当前摘要。' : '用几句话记录整体进展和下一步计划。保存后会保留上一版摘要。'}</p>
          {editor.insight?.stale && <p className="rounded-lg border border-amber-500/30 p-3 text-sm text-amber-700">{editor.insight.staleReason || '生成后来源有变化，请核对下方快照。'}</p>}
          {editor.insight && (!editor.insight.evidence.coverage.complete || editor.insight.evidence.coverage.warnings.length > 0) && <div className="rounded-lg border border-amber-500/30 p-3 text-sm text-amber-700"><p>来源覆盖 {editor.insight.evidence.coverage.includedSources}/{editor.insight.evidence.coverage.totalSources}；请结合覆盖范围判断这份摘要。</p>{editor.insight.evidence.coverage.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
          <label className="block text-sm font-medium">最新进展<textarea className={`${control} mt-1 min-h-32 w-full font-normal`} aria-label="方向最新进展" value={editor.latestProgress} disabled={busy} onChange={event => changeEditor({ latestProgress: event.target.value })} /></label>
          <label className="block text-sm font-medium">下一步计划<textarea className={`${control} mt-1 min-h-32 w-full font-normal`} aria-label="方向下一步计划" value={editor.nextStep} disabled={busy} onChange={event => changeEditor({ nextStep: event.target.value })} /></label>
          {editor.insight && <>
            <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">核对模型原文与引用</summary><div className="mt-3 space-y-4"><InsightPoints title="观察" points={editor.insight.content!.observations} draft={editor.insight} onOpenNote={id => void openNote(id)} /><InsightPoints title="建议验证" points={editor.insight.content!.suggestedChecks} draft={editor.insight} onOpenNote={id => void openNote(id)} />{editor.insight.content!.evidenceGaps.map((gap, index) => <p className="text-amber-700" key={index}>证据缺口：{gap}</p>)}</div></details>
            <ProjectEvidenceView evidence={editor.insight.evidence} />
            {editor.acceptedNote && <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">采用的来源 Note · 版本 {editor.acceptedNote.revision}</summary><h3 className="mt-2 font-semibold">{editor.acceptedNote.title}</h3><div className="prose-mirror-display mt-2" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(editor.acceptedNote.contentHtml) }} /><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => { const current = await getNoteById(editor.acceptedNote!.id); if (!current) throw new Error('来源 Note 已删除。'); if (mounted.current) changeEditor({ acceptedNote: current }) })}>读取当前 Note 版本以重新核对</button></details>}
          </>}
          {editor.expectedRevision !== currentArea.revision && <div className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm"><p>方向在编辑期间有更新，你的文字已保留。请核对目前保存的摘要：</p><p className="whitespace-pre-wrap">最新进展：{currentArea.latestProgress || '空'}</p><p className="whitespace-pre-wrap">下一步计划：{currentArea.nextStep || '空'}</p><button className={button} disabled={busy} onClick={() => changeEditor({ expectedRevision: currentArea.revision })}>已核对，保留我的编辑继续保存</button></div>}
          <ErrorMessage>{error}</ErrorMessage>
          <p className="text-xs text-muted-foreground">关闭或查看来源后，未保存文字会保留在本次客户端会话中。{editor.insight ? '采用时会保存一篇关联 Note，包含模型原文与证据；当前摘要另存为你编辑后的表述。' : ''}</p>
        </>}</DialogBody>
        <DialogFooter><button className={button} disabled={busy} onClick={() => { if (editorKey) editors.delete(editorKey); setEditor(null); setEditorKey(null); setError('') }}>放弃未保存编辑</button><button className={button} disabled={busy} onClick={() => { setEditor(null); setEditorKey(null); setError('') }}>暂存并关闭</button><button className={primaryButton} disabled={busy || !editor || editor.expectedRevision !== currentArea.revision} onClick={() => void save()}>{busy ? '保存中…' : editor?.insight ? '采用为方向摘要' : '保存摘要'}</button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={draftsOpen} onOpenChange={open => { if (!busy) { setDraftsOpen(open); setError('') } }}>
      <DialogContent className="max-h-[90vh] sm:max-w-2xl"><DialogHeader><DialogTitle>方向摘要 · LLM 草稿</DialogTitle></DialogHeader><DialogBody className="space-y-4">
        <p className="text-sm text-muted-foreground">根据这个方向的里程碑、Task 和关联 Notes 提炼进展与建议。生成结果先保留为草稿，审阅、编辑并采用后才更新方向摘要。</p>
        <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">高级设置</summary><div className="mt-3 space-y-3"><label className="flex flex-wrap items-center gap-2">历史覆盖<select className={control} value={analysisDepth} onChange={event => setAnalysisDepth(event.target.value)}><option value="standard">标准</option><option value="expanded">扩大覆盖</option></select></label><label className="flex flex-wrap items-center gap-2">输出与推理预算<select className={control} value={maxOutputTokens} onChange={event => setMaxOutputTokens(Number(event.target.value))}><option value={4000}>4,000 tokens</option><option value={8000}>8,000 tokens</option><option value={16000}>16,000 tokens</option></select></label><p className="text-xs text-muted-foreground">扩大预算会增加调用成本和等待时间；结果会显示实际覆盖与证据缺口。生成和重试都使用当前设置。</p></div></details>
        <button className={primaryButton} disabled={busy || drafts.some(draft => draft.status === 'running')} onClick={() => void generate()}>生成进展与下一步草稿</button>
        <ErrorMessage>{error}</ErrorMessage>
        {draftsLoading && !drafts.length && <p role="status" className="text-sm text-muted-foreground">正在读取草稿…</p>}
        {!draftsLoading && !drafts.length && <p className="text-sm text-muted-foreground">还没有 LLM 草稿。</p>}
        {drafts.map(draft => <article key={draft.id} className="space-y-2 rounded-lg border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>{draftLabel[draft.status]} · {dateLabel(draft.createdAt)}{draft.acceptedNoteId ? ' · 已保存来源 Note' : ''}</span>{draft.stale && <span className="text-amber-700">来源已变化</span>}</div>{draft.error && <p role="alert" className="whitespace-pre-wrap text-red-600">{draft.error}</p>}{draft.status === 'running' && <p role="status" className="text-xs text-muted-foreground">正在生成。可以关闭窗口，稍后从这里继续查看。</p>}<div className="flex flex-wrap gap-2">{draft.status === 'success' && draft.content && <button className={primaryButton} disabled={busy} onClick={() => void reviewDraft(draft)}>审阅并编辑摘要</button>}{draft.status === 'running' ? <button className={button} disabled={busy} onClick={() => void run(async () => { await projectRequest('post', `/api/project-insights/${draft.id}/cancel`); if (mounted.current) setTick(value => value + 1) })}>取消生成</button> : <button className={button} disabled={busy || drafts.some(item => item.status === 'running')} onClick={() => void generate(draft)}>{draft.status === 'error' || draft.status === 'cancelled' ? '重试生成' : '重新生成'}</button>}{draft.acceptedNoteId && <button className={button} disabled={busy} onClick={() => void openNote(draft.acceptedNoteId!)}>查看来源 Note</button>}</div></article>)}
      </DialogBody></DialogContent>
    </Dialog>

    <Dialog open={history !== null} onOpenChange={open => { if (!open) setHistory(null) }}><DialogContent className="max-h-[90vh] sm:max-w-2xl"><DialogHeader><DialogTitle>方向摘要历史 · {area.name}</DialogTitle></DialogHeader><DialogBody className="space-y-3">{history?.length === 0 && <p className="text-sm text-muted-foreground">还没有保存过摘要。</p>}{history?.map(event => {
      const snapshot = event.after as Partial<Area>
      return <article className="space-y-2 rounded-lg border p-3 text-sm" key={event.id}><p className="text-xs text-muted-foreground">{dateLabel(event.createdAt)} · {summarySource(snapshot)}</p><h3 className="font-semibold">最新进展</h3><p className="whitespace-pre-wrap break-words">{snapshot.latestProgress || '未记录'}</p><h3 className="font-semibold">下一步计划</h3><p className="whitespace-pre-wrap break-words">{snapshot.nextStep || '未记录'}</p>{snapshot.summarySourceNoteId && <button className="text-primary underline" disabled={busy} onClick={() => void openNote(snapshot.summarySourceNoteId!)}>查看来源 Note · 采用时版本 {snapshot.summarySourceNoteRevision}</button>}</article>
    })}<ErrorMessage>{error}</ErrorMessage></DialogBody></DialogContent></Dialog>
  </section>
}

function InsightPoints({ title, points, draft, onOpenNote }: { title: string; points: ProjectInsightPoint[]; draft: ProjectInsightDraft; onOpenNote: (id: string) => void }) {
  return <section className="space-y-2"><h3 className="font-semibold">{title}</h3>{points.map((point, index) => <div key={index} className="space-y-1"><p className="whitespace-pre-wrap">{point.text}</p>{point.citations.map((citation, citationIndex) => {
    const source = draft.evidence.sources.find(item => item.id === citation.sourceId)
    return <details className="rounded bg-muted p-2 text-xs" key={citationIndex}><summary className="cursor-pointer">来源：{source?.title || citation.sourceId}</summary><blockquote className="mt-1 whitespace-pre-wrap">{citation.quote}</blockquote>{source?.kind === 'note' && <button className="mt-2 text-primary underline" onClick={() => onOpenNote(source.entityId)}>打开当前 Note</button>}</details>
  })}</div>)}</section>
}
