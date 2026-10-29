import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Link2Off, ListFilter, RefreshCw, Save, X } from 'lucide-react'
import { FindBar } from '@/components/FindBar'
import { OutlineEditor, type OutlineEditorHandle, type OutlineRowLayout } from '@/components/WorkOutline/OutlineEditor'
import { TaskDetailWorkspace } from '@/components/TaskDetailWorkspace'
import { useWorkOutlineStore, pendingOutlineCreation } from '@/stores/workOutlineStore'
import { useTaskStore } from '@/stores/taskStore'
import { fetchTodos } from '@/services/api'
import { outlineError, workOutlineApi, type TaskDaysResponse, type TaskDayDetails } from '@/services/workOutlineApi'
import { outlineDocumentText, outlineTaskId, outlineTaskIds, visibleOutlineRows } from '@/lib/workOutline'
import type { Task, CreateTaskRequest, TaskType, Priority } from '@/types'
import { registerNavigationGuard } from '@/lib/navigationGuard'
import { registerShortcut } from '@/shortcuts/registry'
import { useI18n } from '@/i18n/context'
import '@/components/WorkOutline/workOutline.css'

type Panel = { mode: 'closed' } | { mode: 'view'; taskId: string; rowId: string } | { mode: 'create'; rowId: string; title: string; requestKey: string; restored?: CreateTaskRequest } | { mode: 'day'; taskId: string; rowId: string; date: string }
const CLOSED: Panel = { mode: 'closed' }
const DAY_WIDTH = 176
const TOTAL_WIDTH = 86
function storage<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback } }
function store(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* optional view preferences */ } }
function shiftDate(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
type Translate = (key: string, params?: Record<string, string>) => string
function duration(t: Translate, ms: number | null | undefined) {
  if (ms == null) return '—'
  if (ms === 0) return t('outline.minutes', { n: '0' })
  const minutes = Math.floor(ms / 60000)
  if (minutes === 0) return t('outline.lessThanMinute')
  return minutes < 60 ? t('outline.minutes', { n: String(minutes) }) : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
}
function summaryState(t: Translate, state: string) { return t(`outline.job.${state}`) === `outline.job.${state}` ? t('outline.job.queued') : t(`outline.job.${state}`) }
type HistoricalSummary = Extract<TaskDaysResponse['cells'][number]['summary'], { availability: 'historical' }>
/** Text for a closed-day grid cell. A date outside the backfill window is not "waiting": nothing is scheduled for it. */
function cellSummaryText(t: Translate, summary: HistoricalSummary | null) {
  if (!summary) return ''
  if (summary.text) return summary.text
  if (summary.kind === 'empty' || (summary.outsideBackfill && summary.freshness === 'missing')) return ''
  return summaryState(t, summary.jobState)
}

function CreateTaskPanel({ panel, onCreated, onCancel, onAbandon }: { panel: Extract<Panel, { mode: 'create' }>; onCreated: (task: Task, linked: boolean) => void; onCancel: () => void; onAbandon: () => void }) {
  const { t } = useI18n()
  // The component is keyed by requestKey: closing an unsubmitted form discards
  // that session. Only an actually submitted, uncertain request is recoverable.
  const initial = panel.restored
  const [title, setTitle] = useState(initial?.title ?? panel.title)
  const [body, setBody] = useState(initial?.body ?? '')
  const [type, setType] = useState<TaskType>(initial?.type ?? 'TODO')
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'MEDIUM')
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '')
  const [due, setDue] = useState(initial?.dueDate ? new Date(initial.dueDate).toISOString().slice(0, 10) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const uncertain = !!pendingOutlineCreation()
  const busyRef = useRef(false)
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    try { localStorage.removeItem('chronicle:outline:createDraft') } catch { /* legacy optional storage */ }
    titleRef.current?.focus()
  }, [])
  const task: CreateTaskRequest = { title: title.trim(), body, type, priority, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), ...(due ? { dueDate: new Date(`${due}T12:00:00`).getTime() } : {}) }
  const submit = async () => {
    if (busyRef.current || !title.trim()) return
    busyRef.current = true; setBusy(true); setError('')
    try {
      const result = await useWorkOutlineStore.getState().createLinkedTask(panel.rowId, task, panel.requestKey)
      onCreated(result.task, result.linked)
    } catch (reason) { setError(outlineError(reason)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <form className="outline-create-form" data-testid="outline-create-form" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.ctrlKey && !event.metaKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit() }
    if (event.metaKey && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation() }
  }}>
    {uncertain && !busy && <p className="outline-muted">{t('outline.create.uncertain')}</p>}
    <label>{t('outline.create.name')}<input ref={titleRef} data-testid="outline-create-title" required value={title} onChange={event => setTitle(event.target.value)} disabled={busy || uncertain} /></label>
    <div className="outline-form-columns"><label>{t('outline.create.type')}<select value={type} onChange={event => setType(event.target.value as TaskType)} disabled={busy || uncertain}><option value="TODO">TODO</option><option value="TOREAD">TOREAD</option><option value="DAILY_IMPROVE">DAILY IMPROVE</option></select></label><label>{t('outline.create.priority')}<select value={priority} onChange={event => setPriority(event.target.value as Priority)} disabled={busy || uncertain}><option value="HIGH">{t('outline.create.high')}</option><option value="MEDIUM">{t('outline.create.medium')}</option><option value="LOW">{t('outline.create.low')}</option></select></label></div>
    <label>{t('outline.create.body')}<textarea data-testid="outline-create-body" value={body} onChange={event => setBody(event.target.value)} rows={8} disabled={busy || uncertain} /></label>
    <label>{t('outline.create.tags')}<input value={tags} onChange={event => setTags(event.target.value)} placeholder={t('outline.create.tagsPlaceholder')} disabled={busy || uncertain} /></label>
    <label>{t('outline.create.due')}<input type="date" value={due} onChange={event => setDue(event.target.value)} disabled={busy || uncertain} /></label>
    {error && <p role="alert" className="outline-error">{error}</p>}
    <div className="outline-form-actions">{uncertain && <button type="button" data-testid="outline-create-abandon" className="dialog-button-secondary" onClick={onAbandon} disabled={busy}>{t('outline.create.abandon')}</button>}<button type="button" className="dialog-button-secondary" onClick={onCancel} disabled={busy || uncertain}>{t('outline.create.cancel')}</button><button data-testid="outline-create-submit" className="dialog-button-primary" type="submit" disabled={busy || !title.trim()}>{busy ? t('outline.create.creating') : t('outline.create.submit')} <kbd>Ctrl ↵</kbd></button></div>
  </form>
}

function DayDetails({ panel, onTask, onRefresh }: { panel: Extract<Panel, { mode: 'day' }>; onTask: () => void; onRefresh: () => void }) {
  const { t, locale } = useI18n()
  const [detail, setDetail] = useState<TaskDayDetails | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    setDetail(null); setError('')
    workOutlineApi.day(panel.taskId, panel.date).then(value => { if (!cancelled) setDetail(value) }).catch(reason => { if (!cancelled) setError(outlineError(reason)) })
    return () => { cancelled = true }
  }, [panel.taskId, panel.date])
  async function refresh() {
    setBusy(true); setError('')
    try { await workOutlineApi.refresh(panel.taskId, panel.date); setDetail(await workOutlineApi.day(panel.taskId, panel.date)); onRefresh() }
    catch (reason) { setError(outlineError(reason)) } finally { setBusy(false) }
  }
  return <div className="outline-day-details" data-testid="outline-day-details">
    <div className="outline-form-actions"><button className="dialog-button-secondary" onClick={onTask}>{t('outline.day.openTask')}</button>{detail?.summary.availability === 'historical' && <button className="dialog-button-secondary" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} /> {t('outline.day.recheck')}</button>}</div>
    {error && <p role="alert" className="outline-error">{error}</p>}
    {!detail && !error && <p>{t('outline.day.loading')}</p>}
    {detail && <>
      <p className="outline-day-duration">{duration(t, detail.recordedMs)}</p>
      {detail.summary.availability === 'historical' ? <><p className="outline-day-summary">{detail.summary.text || (detail.summary.kind === 'empty' ? t('outline.day.empty') : t('outline.day.pending'))}</p>{detail.summary.outsideBackfill && detail.summary.freshness !== 'fresh' ? <p className="outline-muted">{t('outline.day.outsideBackfill')}</p> : detail.summary.freshness === 'stale' && <p className="outline-muted">{t('outline.day.stale')}</p>}{detail.summary.jobState !== 'idle' && <p className="outline-muted">{summaryState(t, detail.summary.jobState)}</p>}</> : <p className="outline-muted">{t('outline.day.todayOnly')}</p>}
      {detail.evidence.map(entry => <article key={entry.entryId} className="outline-evidence"><small>{entry.workDate} · {entry.type} · {entry.entryId}</small><p>{entry.content}</p></article>)}
      {detail.nextCursor && <button className="dialog-button-secondary" disabled={busy} onClick={async () => {
        setBusy(true)
        try { const next = await workOutlineApi.day(panel.taskId, panel.date, detail.nextCursor!); setDetail({ ...next, evidence: [...detail.evidence, ...next.evidence] }) }
        catch (reason) { setError(outlineError(reason)) } finally { setBusy(false) }
      }}>{t('outline.day.loadMore')}</button>}
      {detail.sessions.length > 0 && <div className="outline-session-list"><h3>{t('outline.day.sessions')}</h3>{detail.sessions.map(session => <div key={session.id}><span>{new Intl.DateTimeFormat(locale, { timeZone: detail.calendar.timeZone, hour: '2-digit', minute: '2-digit' }).format(session.clippedStart)} – {new Intl.DateTimeFormat(locale, { timeZone: detail.calendar.timeZone, hour: '2-digit', minute: '2-digit' }).format(session.clippedEnd)}</span><span>{duration(t, session.durationMs)}</span></div>)}</div>}
      {detail.anomalies.length > 0 && <p className="outline-error">{t('outline.day.anomalies')}</p>}
    </>}
  </div>
}

export function WorkOutlinePage() {
  const { t, locale } = useI18n()
  const outlineState = useWorkOutlineStore()
  const { document: outlineDocument, status, dirty, error } = outlineState
  const liveTasks = useTaskStore(state => state.tasks)
  const selectedTask = useTaskStore(state => state.selectedTask)
  const entryLoading = useTaskStore(state => state.entryLoading)
  const [tasks, setTasks] = useState<Task[]>([])
  const [days, setDays] = useState<TaskDaysResponse | null>(null)
  const [dataError, setDataError] = useState('')
  const [dayLoading, setDayLoading] = useState(false)
  const [rangeEnd, setRangeEnd] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(CLOSED)
  const [notice, setNotice] = useState('')
  const [activeRow, setActiveRow] = useState('')
  const [width, setWidth] = useState(() => Math.max(280, Math.min(800, storage('chronicle:outline:width', 420))))
  const [pageWidth, setPageWidth] = useState(() => window.innerWidth)
  const [collapsed, setCollapsed] = useState(() => new Set<string>(storage<string[]>('chronicle:outline:collapsed', [])))
  const [activeOnly, setActiveOnly] = useState(() => storage<boolean>('chronicle:outline:activeOnly', false))
  const [layout, setLayout] = useState<{ rows: OutlineRowLayout[]; height: number }>({ rows: [], height: 100 })
  const [showConflict, setShowConflict] = useState(false)
  const editorHandle = useRef<OutlineEditorHandle | null>(null)
  const pageElement = useRef<HTMLElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const detailScope = useRef<HTMLDivElement>(null)
  const restoreAfterClose = useRef<{ rowId: string; scroll: { top: number; left: number } | null } | null>(null)
  const requestNumber = useRef(0)
  const dateInitialized = useRef(false)
  const tasksRef = useRef<string[]>([])
  const endRef = useRef(rangeEnd); endRef.current = rangeEnd
  const todayRef = useRef<string | null>(null)
  const taskIds = useMemo(() => outlineDocument ? outlineTaskIds(outlineDocument) : [], [outlineDocument])
  tasksRef.current = taskIds
  const idsKey = taskIds.join(',')
  const knownTasks = useMemo(() => {
    const byId = new Map(tasks.map(task => [task.id, task]))
    for (const task of liveTasks) { const previous = byId.get(task.id); if (!previous || task.updatedAt >= previous.updatedAt) byId.set(task.id, task) }
    if (selectedTask && (!byId.has(selectedTask.id) || selectedTask.updatedAt >= byId.get(selectedTask.id)!.updatedAt)) byId.set(selectedTask.id, selectedTask)
    return [...byId.values()]
  }, [tasks, liveTasks, selectedTask])
  const statuses = useMemo(() => {
    const values: Record<string, string> = Object.fromEntries((days?.tasks ?? []).map(task => [task.taskId, task.status]))
    for (const task of knownTasks) if (values[task.id] !== 'MISSING') values[task.id] = task.status
    return values
  }, [days, knownTasks])
  const [showFind, setShowFind] = useState(false)
  const [findTokens, setFindTokens] = useState<string[]>([])
  const [findIndex, setFindIndex] = useState(-1)
  const [findCloseSignal, setFindCloseSignal] = useState(0)
  const searching = showFind && findTokens.length > 0
  const effectiveCollapsed = useMemo(() => searching ? new Set<string>() : collapsed, [searching, collapsed])
  const visible = useMemo(() => outlineDocument ? visibleOutlineRows(outlineDocument, effectiveCollapsed, statuses, activeOnly) : [], [outlineDocument, effectiveCollapsed, statuses, activeOnly])
  const hiddenByFilter = useMemo(() => outlineDocument && activeOnly ? visibleOutlineRows(outlineDocument, effectiveCollapsed, statuses).length - visible.length : 0, [outlineDocument, effectiveCollapsed, statuses, activeOnly, visible])
  const byRow = useMemo(() => new Map(visible.map(row => [row.line.attrs.id, row])), [visible])
  const taskStats = useMemo(() => new Map(days?.tasks.map(task => [task.taskId, task])), [days])
  const cells = useMemo(() => new Map(days?.cells.map(cell => [`${cell.taskId}:${cell.date}`, cell])), [days])
  const columns = days?.columns ?? []
  // Keep the preferred width, but leave usable detail space when a saved wide
  // outline is opened in a smaller window. Both panes share this actual boundary.
  const editorWidth = Math.min(width, Math.max(80, pageWidth - TOTAL_WIDTH - Math.min(340, pageWidth / 2)))

  useLayoutEffect(() => {
    if (!pageElement.current) return
    const element = pageElement.current
    const measure = () => setPageWidth(element.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (panel.mode !== 'closed' || !restoreAfterClose.current) return
    const { rowId, scroll } = restoreAfterClose.current
    restoreAfterClose.current = null
    editorHandle.current?.restoreFocus(rowId)
    if (scroll) grid.current?.scrollTo(scroll)
  }, [panel])

  const refreshDays = useCallback(async () => {
    const serial = ++requestNumber.current
    const ids = tasksRef.current
    setDayLoading(true)
    try {
      // The server's current workday is learned once and then refreshed by every response.
      let end = endRef.current ?? todayRef.current
      if (!end) {
        const initial = await workOutlineApi.days([])
        end = initial.calendar.currentWorkDate
      }
      const batches: string[][] = []
      for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100))
      if (!batches.length) batches.push([])
      const results = await Promise.all(batches.map(batch => workOutlineApi.days(batch, shiftDate(end!, -13), end!)))
      if (serial !== requestNumber.current) return
      todayRef.current = results[0].calendar.currentWorkDate
      setDays({ ...results[0], tasks: results.flatMap(result => result.tasks), cells: results.flatMap(result => result.cells) })
      setDataError('')
    } catch (reason) { if (serial === requestNumber.current) setDataError(outlineError(reason)) }
    finally { if (serial === requestNumber.current) setDayLoading(false) }
  }, [])

  const reloadTasks = useCallback(async () => {
    try { setTasks(await fetchTodos(undefined, 'PENDING,DOING,DONE,DROPPED,ON_HOLD')) } catch { /* task/day fetch exposes its own error */ }
  }, [])
  useEffect(() => {
    void outlineState.load(); void reloadTasks()
    const pending = pendingOutlineCreation()
    if (pending) setPanel({ mode: 'create', rowId: pending.rowId, title: pending.task.title, requestKey: pending.idempotencyKey, restored: pending.task })
    return () => { void useWorkOutlineStore.getState().save().catch(() => {}) }
  }, [])
  useEffect(() => { void refreshDays() }, [idsKey, rangeEnd, refreshDays])
  useEffect(() => {
    const changed = () => { void refreshDays(); void reloadTasks() }
    const focused = () => { changed(); void useWorkOutlineStore.getState().checkRemote() }
    const outlineChanged = () => { void useWorkOutlineStore.getState().checkRemote() }
    window.addEventListener('chronicle:task-days-updated', changed)
    window.addEventListener('chronicle:projects-changed', changed)
    window.addEventListener('chronicle:outline-updated', outlineChanged)
    window.addEventListener('focus', focused)
    const timer = window.setInterval(() => { void refreshDays() }, 30000)
    return () => {
      window.removeEventListener('chronicle:task-days-updated', changed); window.removeEventListener('chronicle:projects-changed', changed)
      window.removeEventListener('chronicle:outline-updated', outlineChanged); window.removeEventListener('focus', focused); clearInterval(timer)
    }
  }, [refreshDays, reloadTasks])
  useEffect(() => {
    if (days && !dateInitialized.current && grid.current) { grid.current.scrollLeft = grid.current.scrollWidth; dateInitialized.current = true }
  }, [days])
  useEffect(() => { store('chronicle:outline:collapsed', [...collapsed]) }, [collapsed])
  useEffect(() => { store('chronicle:outline:activeOnly', activeOnly) }, [activeOnly])
  useEffect(() => { store('chronicle:outline:width', width) }, [width])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (useWorkOutlineStore.getState().dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => registerNavigationGuard(async () => {
    const current = useWorkOutlineStore.getState()
    if (current.creating || pendingOutlineCreation()) { setNotice(t('outline.notice.confirmCreation')); return false }
    try { await current.save(); return !useWorkOutlineStore.getState().dirty } catch { return false }
  }), [])
  useEffect(() => registerShortcut({ id: 'work-outline-find', combo: 'mod+f', label: 'Find in outline', scope: 'page', handler: () => {
    const input = window.document.querySelector<HTMLInputElement>('[data-find-bar="true"] input')
    if (input) { input.focus(); input.select() } else setShowFind(true)
  } }), [])
  useEffect(() => registerShortcut({ id: 'work-outline-toggle-active', combo: 'mod+o', label: 'Toggle unfinished-only outline', scope: 'page', handler: () => setActiveOnly(current => !current) }), [])
  useEffect(() => registerShortcut({ id: 'work-outline-refresh', combo: 'mod+r', label: 'Refresh work outline', scope: 'page', handler: () => { void refreshDays(); void reloadTasks(); void useWorkOutlineStore.getState().checkRemote() } }), [refreshDays, reloadTasks])
  useEffect(() => {
    const skip = (event: KeyboardEvent) => event.isComposing || event.key !== 'Escape' || !!window.document.querySelector('[data-outline-mention], [role="dialog"]') || !!(event.target as Element | null)?.closest?.('[data-find-bar="true"]')
    // While editing inside the Task detail, its own Esc handling (leave the editor, cancel a title edit) goes first;
    // Esc only reaches the bubble listener below, and closes the panel, when nothing there consumed it.
    const editingInDetail = (event: KeyboardEvent) => panel.mode === 'view' && !!(event.target as Element | null)?.closest?.('.outline-side-panel') && !!(event.target as Element).closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
    const onEscape = (event: KeyboardEvent) => {
      if (skip(event) || editingInDetail(event)) return
      // The panel closes first; once it is gone, Esc closes the find bar even though focus is no longer in it.
      if (panel.mode !== 'closed') { event.preventDefault(); event.stopPropagation(); closePanel() }
      else if (showFind) { event.preventDefault(); event.stopPropagation(); setFindCloseSignal(signal => signal + 1) }
    }
    const onEscapeUnhandled = (event: KeyboardEvent) => {
      if (skip(event) || !editingInDetail(event) || event.defaultPrevented) return
      event.preventDefault(); closePanel()
    }
    window.addEventListener('keydown', onEscape, true)
    window.addEventListener('keydown', onEscapeUnhandled)
    return () => { window.removeEventListener('keydown', onEscape, true); window.removeEventListener('keydown', onEscapeUnhandled) }
  }, [panel, showFind])
  const onLayout = useCallback((rows: OutlineRowLayout[], height: number) => {
    setLayout(current => current.height === height && JSON.stringify(current.rows) === JSON.stringify(rows) ? current : { rows, height })
  }, [])
  function closePanel() {
    if (!canSwitchPanel()) return
    const rowId = panel.mode !== 'closed' ? panel.rowId : activeRow
    const scroll = grid.current ? { top: grid.current.scrollTop, left: grid.current.scrollLeft } : null
    restoreAfterClose.current = { rowId, scroll }
    setPanel(CLOSED)
  }
  // Clicking the tree dismisses the task/day panel; task chips still switch it and the create form is left alone.
  function closeReadOnlyPanelOnTreeClick(event: React.PointerEvent) {
    if (panel.mode !== 'view' && panel.mode !== 'day') return
    if ((event.target as Element).closest('[data-outline-task]')) return
    closePanel()
    restoreAfterClose.current = null
  }
  async function openTask(taskId: string, rowId: string) {
    if (!canSwitchPanel()) return
    if (statuses[taskId] === 'MISSING') { setNotice(t('outline.notice.taskDeleted')); return }
    setPanel({ mode: 'view', taskId, rowId })
    await useTaskStore.getState().setActiveTask(taskId)
    detailScope.current?.focus()
  }
  function canSwitchPanel() {
    if (useWorkOutlineStore.getState().creating || pendingOutlineCreation()) {
      setNotice(t('outline.notice.creationPending'))
      return false
    }
    return true
  }
  function switchPanel(next: Panel) { if (canSwitchPanel()) setPanel(next) }
  function abandonCreation() {
    useWorkOutlineStore.getState().abandonCreation()
    setNotice(t('outline.notice.abandoned'))
    closePanel()
  }
  function onCreated(task: Task, linked: boolean, rowId: string) {
    setTasks(current => [...current.filter(item => item.id !== task.id), task])
    if (!linked) setNotice(t('outline.notice.notLinked'))
    void openTask(task.id, rowId); void refreshDays()
  }
  function exportLocal() {
    if (!outlineDocument) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(outlineDocument, null, 2)], { type: 'application/json' }))
    const link = window.document.createElement('a'); link.href = url; link.download = 'work-outline-local.json'; link.click(); URL.revokeObjectURL(url)
  }
  function resize(event: React.PointerEvent) {
    event.preventDefault()
    const start = event.clientX, previous = editorWidth
    const move = (next: PointerEvent) => setWidth(Math.max(280, Math.min(800, previous + next.clientX - start)))
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
  }
  const panelTitle = panel.mode === 'create' ? t('outline.panel.create') : panel.mode === 'day' ? t('outline.panel.day', { date: panel.date }) : panel.mode === 'view' ? t('outline.panel.detail') : ''

  return <main ref={pageElement} className="work-outline-page" data-testid="work-outline-page">
    <header className="outline-toolbar">
      <div><h1>{t('outline.title')}</h1><span className="outline-muted">{t('outline.subtitle')}</span></div>
      <div className="outline-toolbar-actions">
        <button data-testid="outline-active-only" className={activeOnly ? 'is-active' : ''} aria-pressed={activeOnly} title={t('outline.activeOnly.title')} onClick={() => setActiveOnly(current => !current)}><ListFilter size={14} />{activeOnly ? t('outline.activeOnly.on', { count: String(hiddenByFilter) }) : t('outline.activeOnly.off')}</button>
        <span role="status" data-testid="outline-save-status" className={status === 'error' || status === 'conflict' ? 'outline-error' : 'outline-muted'}>{status === 'conflict' ? t('outline.status.conflict') : status === 'error' ? t('outline.status.error') : dirty || status === 'saving' ? t('outline.status.saving') : status === 'loading' ? t('outline.status.loading') : t('outline.status.saved')}</span>
        <button title={t('outline.save')} onClick={() => void outlineState.save().catch(() => {})}><Save size={16} /></button>
        <button title={t('outline.prevWeek')} onClick={() => setRangeEnd(shiftDate(rangeEnd || days?.calendar.currentWorkDate || new Date().toISOString().slice(0, 10), -7))}><ChevronLeft size={16} /></button>
        <button onClick={() => { setRangeEnd(null); dateInitialized.current = false; void refreshDays() }}>{t('outline.today')}</button>
        <button title={t('outline.nextWeek')} disabled={!rangeEnd || !!days && rangeEnd >= days.calendar.currentWorkDate} onClick={() => setRangeEnd(shiftDate(rangeEnd!, 7) > (days?.calendar.currentWorkDate || '') ? null : shiftDate(rangeEnd!, 7))}><ChevronRight size={16} /></button>
      </div>
    </header>
    <div className="outline-edit-toolbar"><span>{t('outline.hint')}</span><div><button disabled={!activeRow} title={t('outline.moveUp')} onClick={() => editorHandle.current?.move(activeRow, -1)}><ArrowUp size={14} /></button><button disabled={!activeRow} title={t('outline.moveDown')} onClick={() => editorHandle.current?.move(activeRow, 1)}><ArrowDown size={14} /></button><button disabled={!activeRow || !outlineDocument?.content.some(line => line.attrs.id === activeRow && outlineTaskId(line))} title={t('outline.unlink')} data-testid="outline-unlink" onClick={() => editorHandle.current?.unlink(activeRow)}><Link2Off size={14} /></button></div></div>
    {status === 'conflict' && <div className="outline-conflict" role="alert"><span>{t('outline.conflict.message')}</span><button onClick={() => setShowConflict(value => !value)}>{t('outline.conflict.view')}</button><button onClick={exportLocal}>{t('outline.conflict.export')}</button>{showConflict && <div className="outline-conflict-versions"><pre aria-label={t('outline.conflict.serverVersion')}>{outlineState.remote ? outlineDocumentText(outlineState.remote.document) : t('outline.conflict.reading')}</pre><div><button onClick={() => void outlineState.reloadRemote().then(() => setShowConflict(false))}>{t('outline.conflict.useServer')}</button><button onClick={() => void outlineState.keepLocal().then(() => setShowConflict(false)).catch(() => {})}>{t('outline.conflict.keepLocal')}</button></div></div>}</div>}
    {(error || dataError || notice) && <div className="outline-feedback" role="alert">{notice || error || t('outline.dataError', { message: dataError })}<button onClick={() => { setNotice(''); void refreshDays(); if (status === 'error') void outlineState.save().catch(() => {}) }}>{t('outline.retryClose')}</button></div>}
    <div className="outline-workspace">
      <div className="pointer-events-none absolute left-0 top-0 z-30 [&>*]:pointer-events-auto" style={{ width: TOTAL_WIDTH + editorWidth }}>
        <FindBar open={showFind} closeSignal={findCloseSignal} onClose={() => { setShowFind(false); setFindTokens([]); setFindIndex(-1) }} containerRef={grid} onTokensChange={setFindTokens} onCurrentMatchChange={setFindIndex} />
      </div>
      <div ref={grid} className="outline-grid-scroll" data-testid="outline-grid-scroll">
        <div className="outline-grid-header" style={{ minWidth: TOTAL_WIDTH + editorWidth + Math.max(1, columns.length) * DAY_WIDTH }}>
          <div className="outline-total-heading" style={{ width: TOTAL_WIDTH }}>{t('outline.col.total')}</div><div className="outline-text-heading" style={{ left: TOTAL_WIDTH, width: editorWidth }}>{t('outline.col.text')}</div>
          {columns.map(column => <div key={column.date} className={`outline-date-heading ${column.isCurrent ? 'is-current' : ''}`} style={{ width: DAY_WIDTH }}><span>{column.date.slice(5).replace('-', '/')}</span><small>{column.isCurrent ? t('outline.col.todayOnly') : new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${column.date}T12:00:00Z`))}</small></div>)}
        </div>
        <div className="outline-grid-body" style={{ minWidth: TOTAL_WIDTH + editorWidth + Math.max(1, columns.length) * DAY_WIDTH, minHeight: layout.height }}>
          <div className="outline-total-column" style={{ width: TOTAL_WIDTH, height: layout.height }}>
            {layout.rows.map(row => { const source = byRow.get(row.id); const taskId = source && outlineTaskId(source.line); return <div key={row.id} className="outline-total-cell" style={{ top: row.top, height: row.height }} data-testid="outline-total" data-row-id={row.id}>{taskId ? duration(t, taskStats.get(taskId)?.totalRecordedMs) : ''}</div> })}
          </div>
          <div className="outline-text-column" style={{ width: editorWidth, left: TOTAL_WIDTH }} onPointerDownCapture={closeReadOnlyPanelOnTreeClick}>
            {outlineDocument ? <OutlineEditor value={outlineDocument} tasks={knownTasks} statuses={statuses} collapsed={effectiveCollapsed} activeOnly={activeOnly} searchTokens={findTokens} searchCurrentMatchIndex={findIndex} onChange={outlineState.edit} onSave={() => void outlineState.save().catch(() => {})} onOpenTask={(id, rowId) => void openTask(id, rowId)} onCreateTask={(rowId, title) => switchPanel({ mode: 'create', rowId, title, requestKey: crypto.randomUUID() })} onLayout={onLayout} onActiveRow={setActiveRow} handleRef={editorHandle} /> : <div className="outline-initial">{status === 'error' ? <button onClick={() => void outlineState.load()}>{t('outline.reload')}</button> : t('outline.loadingOutline')}</div>}
            {layout.rows.map(row => { const source = byRow.get(row.id); return source?.hasChildren ? <button key={row.id} className="outline-fold" aria-label={effectiveCollapsed.has(row.id) ? t('outline.expand') : t('outline.collapse')} data-testid="outline-fold" data-row-id={row.id} style={{ top: row.top + 2, left: source.line.attrs.depth * 22 + 3 }} onMouseDown={event => event.preventDefault()} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next })}>{effectiveCollapsed.has(row.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : null })}
            <div className="outline-resize" role="separator" aria-label={t('outline.resize')} onPointerDown={resize} />
          </div>
          <div className="outline-dates-body" style={{ width: Math.max(1, columns.length) * DAY_WIDTH, height: layout.height }} aria-busy={dayLoading}>
            {layout.rows.map(row => { const source = byRow.get(row.id); const taskId = source && outlineTaskId(source.line); return <div key={row.id} className="outline-date-row" style={{ top: row.top, height: row.height }} data-testid="outline-date-row" data-row-id={row.id}>
              {columns.map(column => { const cell = taskId ? cells.get(`${taskId}:${column.date}`) : null; const summary = !column.isCurrent && cell?.summary.availability === 'historical' ? cell.summary : null; const missing = taskId && taskStats.get(taskId)?.missing; return <button key={column.date} disabled={!taskId || !!missing || !!dataError} style={{ width: DAY_WIDTH }} className={`outline-day-cell ${column.isCurrent ? 'is-current' : ''}`} data-testid="outline-day-cell" data-date={column.date} data-task-id={taskId || ''} onClick={() => taskId && switchPanel({ mode: 'day', taskId, rowId: row.id, date: column.date })}>
                {taskId && !missing && <><span className="outline-cell-summary">{dataError ? t('outline.cell.failed') : column.isCurrent ? '' : cellSummaryText(t, summary)}</span><span className="outline-cell-time">{cell ? `${cell.running ? '● ' : ''}${duration(t, cell.recordedMs)}` : days ? '—' : '…'}{summary?.freshness === 'stale' && !summary.outsideBackfill && <small>{t('outline.cell.stale')}</small>}</span></>}
              </button> })}
            </div> })}
          </div>
        </div>
      </div>
    </div>
      {panel.mode !== 'closed' && <aside ref={detailScope} tabIndex={-1} className="outline-side-panel" data-testid="outline-side-panel" style={{ left: TOTAL_WIDTH + editorWidth }}>
        <header><h2>{panelTitle}</h2><button aria-label={t('outline.panel.close')} onClick={closePanel} disabled={outlineState.creating}><X size={18} /></button></header>
        <div className={`outline-panel-content${panel.mode === 'view' ? ' outline-task-detail' : ''}`}>
          {panel.mode === 'create' && <CreateTaskPanel key={panel.requestKey} panel={panel} onCreated={(task, linked) => onCreated(task, linked, panel.rowId)} onCancel={closePanel} onAbandon={abandonCreation} />}
          {panel.mode === 'view' && (entryLoading || selectedTask?.id !== panel.taskId ? <p className="outline-initial">{entryLoading ? t('outline.panel.loadingTask') : t('outline.panel.taskUnavailable')}</p> : <TaskDetailWorkspace keepCompletedTaskVisible shortcutScopeRef={detailScope} />)}
          {panel.mode === 'day' && <DayDetails panel={panel} onTask={() => void openTask(panel.taskId, panel.rowId)} onRefresh={() => void refreshDays()} />}
        </div>
      </aside>}
  </main>
}
