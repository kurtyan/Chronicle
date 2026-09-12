import { fetchStartOfDayOffset } from '@/services/api'
import { getWorkPeriodRange } from '@/lib/workPeriod'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, RefreshCw, Search, SlidersHorizontal, Rows, GanttChart } from 'lucide-react'
import { projectApi, projectError, entityPath } from '@/services/projectApi'
import type { ProjectOverview, MilestoneOverview } from '@/services/projectApi'
import { useProjectStore } from '@/stores/projectStore'
import { ProjectEditor } from '@/components/Projects/ProjectEditor'
import { ProjectGantt } from '@/components/Projects/ProjectGantt'
import { AreaSummary } from '@/components/Projects/AreaSummary'
import { ProjectNotesPanel } from '@/components/Projects/ProjectNotesPanel'
import type { ProjectSelection } from '@/components/Projects/ProjectNotesPanel'
import { duration, statusLabels, ErrorMessage, Empty, useProjectRefresh } from '@/components/Projects/common'

export function MilestoneCard({ milestone }: { milestone: MilestoneOverview }) {
  const navigate = useNavigate()
  return <button className="w-full rounded-xl border bg-card p-4 text-left transition hover:border-primary/50 hover:bg-primary/5" onClick={() => navigate(entityPath('milestone', milestone.id))} data-testid="milestone-card">
    <div className="flex flex-wrap justify-between gap-2"><div className="min-w-0"><p className="text-xs text-muted-foreground">{milestone.areaName} · {milestone.kind === 'ongoing' ? '持续型' : '阶段型'}</p><h3 className="mt-1 font-semibold">{milestone.name}</h3></div><span className="text-xs text-muted-foreground">{statusLabels[milestone.status]}{milestone.archived ? ' · 已归档' : ''}</span></div>
    <div className="my-3 flex flex-wrap gap-x-6 gap-y-2"><div><div className="text-xl font-semibold tabular-nums">{duration(milestone.periodMs)}</div><div className="text-xs text-muted-foreground">期间投入 · 累计 {duration(milestone.totalMs)}</div></div><div className="text-sm"><div>任务已完成 {milestone.doneTaskCount} / {milestone.taskCount}</div><div className="text-xs text-muted-foreground">{milestone.kind === 'ongoing' ? '持续跟踪，不设总体完成率' : '里程碑成果由你核对确认'}</div></div></div>
    {milestone.latestProgress && <p className="line-clamp-2 text-sm">{milestone.latestProgress}</p>}{milestone.nextStep && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">下一步：{milestone.nextStep}</p>}{milestone.blockers && <p className="mt-1 line-clamp-2 text-xs text-amber-600">阻碍：{milestone.blockers}</p>}
    <p className="mt-3 text-xs text-muted-foreground">{milestone.reviewStatus === 'pending' ? '待复盘' : milestone.lastReviewedAt ? `最近确认回顾 ${new Date(milestone.lastReviewedAt).toLocaleDateString()}` : '尚无确认回顾'}</p>
  </button>
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const { areas, load } = useProjectStore()
  const [data, setData] = useState<ProjectOverview | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [areaId, setAreaId] = useState('')
  const [status, setStatus] = useState('')
  const [archived, setArchived] = useState(false)
  const [range, setRange] = useState('week')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [workDayOffset, setWorkDayOffset] = useState(5)
  useEffect(() => { fetchStartOfDayOffset().then(setWorkDayOffset).catch(() => {}) }, [])
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [creating, setCreating] = useState<'area' | 'milestone' | null>(null)
  const [editingSchedule, setEditingSchedule] = useState<MilestoneOverview | null>(null)
  const [selection, setSelection] = useState<ProjectSelection | null>(null)
  const [view, setView] = useState<'gantt' | 'list'>(() => localStorage.getItem('chronicle:project-view') === 'list' ? 'list' : 'gantt')
  const refresh = useProjectRefresh()
  const [tick, setTick] = useState(0)
  useEffect(() => { void load() }, [load])
  useEffect(() => { const timer = window.setInterval(() => setTick(n => n + 1), 60_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    let active = true
    const now = Date.now()
    const normal = getWorkPeriodRange(range === 'month' ? 'month' : 'week', new Date(), workDayOffset)
    const start = range === 'all' ? 0 : range === 'custom' ? (customStart ? getWorkPeriodRange('day', new Date(`${customStart}T12:00:00`), workDayOffset).start : 0) : normal.start
    const end = range === 'custom' && customEnd ? getWorkPeriodRange('day', new Date(`${customEnd}T12:00:00`), workDayOffset).end : range === 'all' ? now : normal.end
    const timer = window.setTimeout(() => { projectApi.overview({ start, end, asOf: now, query: query || undefined, areaId: areaId || undefined, status: status || undefined, includeArchived: archived, limit: 1000 }).then(result => { if (active) { setData(result); setError('') } }).catch(e => { if (active) setError(projectError(e)) }) }, query ? 180 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, areaId, status, archived, range, customStart, customEnd, workDayOffset, refresh, tick])
  const periodLabel = range === 'week' ? '本周' : range === 'month' ? '本月' : range === 'all' ? '累计' : '期间'
  const compactControl = 'h-8 rounded-md border border-border/70 bg-background px-2.5 text-xs outline-none focus:border-primary/60'
  const visibleAreas = areas.filter(a => (archived || !a.archived) && (!areaId || a.id === areaId) && (!query || a.name.toLowerCase().includes(query.toLowerCase()) || data?.milestones.some(m => m.areaId === a.id)))
  const rangeContext = data ? { start: data.statistics.start, end: data.statistics.end, asOf: data.statistics.asOf } : undefined
  return <div className="h-full overflow-y-auto p-4 sm:p-6" data-testid="projects-page"><div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-[22px] font-semibold tracking-tight">项目总览</h1>{data && <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{periodLabel}全部投入 <strong className="ml-1 text-lg font-semibold tabular-nums text-foreground">{duration(data.statistics.totalMs)}</strong></span><span className="text-border">/</span><span>当前显示 {data.milestones.length} 个里程碑</span><span>{data.milestones.filter(m => m.status === 'completed').length} 个已完成</span>{data.milestones.some(m => m.reviewStatus === 'pending') && <span className="text-amber-700 dark:text-amber-400">{data.milestones.filter(m => m.reviewStatus === 'pending').length} 个待复盘</span>}</div>}</div>
      <div className="flex gap-2"><button className={`${compactControl} hover:bg-muted`} aria-label="新建方向" onClick={() => setCreating('area')}><Plus className="mr-1 inline h-3.5 w-3.5" />方向</button><button className={`${compactControl} border-primary bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40`} disabled={!areas.some(a => !a.archived)} aria-label="新建里程碑" onClick={() => setCreating('milestone')}><Plus className="mr-1 inline h-3.5 w-3.5" />里程碑</button></div>
    </header>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2"><label className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3 w-3 text-muted-foreground" /><input className={`${compactControl} w-44 pl-7`} placeholder="搜索里程碑…" aria-label="搜索里程碑" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="方向筛选" className={`${compactControl} max-w-40`} value={areaId} onChange={e => setAreaId(e.target.value)}><option value="">全部方向</option>{areas.map(a => <option key={a.id} value={a.id}>{a.name}{a.archived ? '（归档）' : ''}</option>)}</select><select aria-label="统计期间" className={compactControl} value={range} onChange={e => setRange(e.target.value)}><option value="week">本周</option><option value="month">本月</option><option value="all">全部时间</option><option value="custom">自定义期间</option></select><button className={`${compactControl} inline-flex items-center gap-1.5 hover:bg-muted ${filtersOpen || status || archived ? 'border-primary/40 text-primary' : 'text-muted-foreground'}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal className="h-3 w-3" />筛选{(status || archived) && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}</button></div>
        <div className="flex items-center gap-2"><div className="flex rounded-lg bg-muted/70 p-0.5" aria-label="项目展示方式">{(['gantt', 'list'] as const).map(value => { const Icon = value === 'gantt' ? GanttChart : Rows; return <button key={value} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${view === value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-pressed={view === value} onClick={() => { setView(value); localStorage.setItem('chronicle:project-view', value) }}><Icon className="h-3 w-3" />{value === 'gantt' ? '甘特图' : '里程碑列表'}</button> })}</div><button className="rounded-md p-2 text-muted-foreground hover:bg-muted" onClick={() => { setTick(n => n + 1); void load() }} aria-label="刷新项目总览"><RefreshCw className="h-3.5 w-3.5" /></button></div>
      </div>
      {filtersOpen && <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3 text-xs"><select aria-label="里程碑状态筛选" className={compactControl} value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{['planned', 'active', 'paused', 'completed', 'cancelled', 'ended'].map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select><label className="flex items-center gap-2"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />显示归档</label>{(status || archived) && <button className="text-muted-foreground hover:text-foreground" onClick={() => { setStatus(''); setArchived(false) }}>重置</button>}</div>}
      {range === 'custom' && <div className="flex flex-wrap items-center gap-2 text-xs"><input type="date" aria-label="投入开始日期" className={compactControl} value={customStart} onChange={e => setCustomStart(e.target.value)} /><span>至</span><input type="date" aria-label="投入结束日期" className={compactControl} value={customEnd} onChange={e => setCustomEnd(e.target.value)} /></div>}
      <ErrorMessage>{error}</ErrorMessage>
      {data && <>
        {view === 'gantt' ? <ProjectGantt areas={visibleAreas} milestones={data.milestones} statistics={data.statistics} onSelect={setSelection} onSchedule={setEditingSchedule} periodLabel={periodLabel} /> : <>
          <div className="grid gap-3 sm:grid-cols-2">{visibleAreas.map(a => <section className="rounded-xl border p-4" key={a.id}><button className="mb-3 font-semibold hover:text-primary hover:underline" onClick={() => setSelection({ type: 'area', id: a.id, name: a.name })}>{a.name} · 关联笔记</button><AreaSummary area={a} compact /></section>)}</div>
          {!data.milestones.length ? <Empty>{areas.length ? '当前筛选没有里程碑。可创建阶段目标或持续跟踪事项。' : '先创建一个方向，再添加里程碑。旧 Task 保留未归属，可以随后整理。'}</Empty> : <div className="grid gap-3 lg:grid-cols-2">{data.milestones.map(m => <MilestoneCard key={m.id} milestone={m} />)}</div>}
        </>}
        {!areas.length && <Empty>先创建一个方向，再为它添加里程碑。</Empty>}
        <div className="flex flex-wrap items-start justify-between gap-3 text-[11px] text-muted-foreground"><div className="flex flex-wrap gap-3">{(areaId || query || status) && <span>当前筛选投入 {duration(data.milestones.reduce((sum, m) => sum + m.periodMs, 0))}</span>}<button className="hover:text-foreground hover:underline" onClick={() => navigate('/?projectFilter=unassigned')}>未归属投入 {duration(data.statistics.unassignedMs)}</button></div><details className="max-w-md text-right"><summary className="cursor-pointer hover:text-foreground">计时口径</summary><p className="mt-2 text-left leading-5">投入来自实际计时，时间条表示计划日期。方向和里程碑汇总同一份投入，不能相加；相关标签不重复计时。筛选不改变全部投入。统计截至 {new Date(data.statistics.asOf).toLocaleString()}。</p></details></div>
        {!!data.statistics.anomalies.length && <details className="text-xs text-amber-600"><summary>发现 {data.statistics.anomalies.length} 条计时异常</summary>{data.statistics.anomalies.map((a, i) => <p key={i}>{a.sessionId}：{a.reason}</p>)}</details>}
      </>}
    </div>
    {creating && <ProjectEditor type={creating} areaId={areaId || undefined} onClose={() => setCreating(null)} onSaved={id => { const type = creating; setCreating(null); navigate(entityPath(type, id)) }} />}
    {editingSchedule && <ProjectEditor type="milestone" value={editingSchedule} onClose={() => setEditingSchedule(null)} onSaved={() => setEditingSchedule(null)} />}
    {selection && <ProjectNotesPanel key={`${selection.type}:${selection.id}`} target={selection} onClose={() => setSelection(null)} onSchedule={setEditingSchedule} range={rangeContext} periodLabel={periodLabel} />}
  </div></div>
}
