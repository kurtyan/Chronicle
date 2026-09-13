import { fetchStartOfDayOffset } from '@/services/api'
import { getWorkPeriodRange } from '@/lib/workPeriod'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, RefreshCw, Search, SlidersHorizontal, Rows, GanttChart } from 'lucide-react'
import { projectApi, projectError, entityPath } from '@/services/projectApi'
import type { ProjectOverview, MilestoneOverview } from '@/services/projectApi'
import { useProjectStore } from '@/stores/projectStore'
import { ProjectEditor } from '@/components/Projects/ProjectEditor'
import { ProjectGantt } from '@/components/Projects/ProjectGantt'
import { ProjectNotesPanel } from '@/components/Projects/ProjectNotesPanel'
import type { ProjectSelection } from '@/components/Projects/ProjectNotesPanel'
import { useI18n } from '@/i18n/context'
import { registerShortcut } from '@/shortcuts/registry'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useProjectLabels, ErrorMessage, Empty, useProjectRefresh } from '@/components/Projects/common'
import { projectNavigationState, withProjectNavigation } from '@/lib/projectNavigation'
import { projectScrollKey, readProjectScroll, saveProjectScroll, useProjectViewQuery } from '@/lib/projectWorkspaceState'

export function MilestoneCard({ milestone, onSelect }: { milestone: MilestoneOverview; onSelect?: (selection: ProjectSelection) => void }) {
  const navigate = useNavigate()
  const { t, locale } = useI18n()
  const { duration, statusLabels } = useProjectLabels()
  return <button className="group w-full rounded-lg border border-border/70 bg-card p-4 text-left transition hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect ? onSelect({ type: 'milestone', id: milestone.id, name: milestone.name }) : navigate(entityPath('milestone', milestone.id))} data-testid="milestone-card">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[11px] text-muted-foreground">{milestone.areaName} · {t(milestone.kind === 'ongoing' ? 'project.overview.ongoing' : 'project.overview.stage')}</p><h3 className="mt-1 truncate text-sm font-medium">{milestone.name}</h3></div><span className="shrink-0 text-[11px] text-muted-foreground">{statusLabels[milestone.status]}</span></div>
    <div className="my-3 flex items-baseline justify-between gap-3"><span className="font-semibold tabular-nums">{duration(milestone.periodMs)}</span><span className="text-xs text-muted-foreground">{t('project.overview.doneTasks', { done: String(milestone.doneTaskCount), count: String(milestone.taskCount) })}</span></div>
    {milestone.latestProgress && <p className="line-clamp-2 text-xs leading-relaxed">{milestone.latestProgress}</p>}
    {milestone.nextStep && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{t('project.overview.next')}: {milestone.nextStep}</p>}
    {milestone.reviewStatus === 'pending' ? <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">{t('project.overview.reviewPending')}</p> : milestone.lastReviewedAt && <p className="mt-3 text-[11px] text-muted-foreground">{t('project.overview.reviewed', { date: new Date(milestone.lastReviewedAt).toLocaleDateString(locale) })}</p>}
  </button>
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { duration, statusLabels, dateLabel } = useProjectLabels()
  const { params, update, location } = useProjectViewQuery()
  const resumedView = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listScrollOwner = useRef<{ key: string; element: HTMLDivElement } | null>(null)
  const { areas, load } = useProjectStore()
  const [data, setData] = useState<ProjectOverview | null>(null)
  const [dataPeriod, setDataPeriod] = useState('week')
  const [loadedDataScope, setLoadedDataScope] = useState('')
  const [error, setError] = useState('')
  const query = params.get('q') || ''
  const areaId = params.get('area') || ''
  const status = params.get('status') || ''
  const archived = params.get('archived') === '1'
  const range = ['week', 'month', 'all', 'custom'].includes(params.get('period') || '') ? params.get('period')! : 'week'
  const filtersOpen = params.get('filters') === '1'
  const customStart = params.get('start') || ''
  const customEnd = params.get('end') || ''
  const [preferredView] = useState(() => { try { return localStorage.getItem('chronicle:project-view') === 'list' ? 'list' : 'gantt' } catch { return 'gantt' } })
  const view = params.get('view') === 'list' ? 'list' : params.get('view') === 'gantt' ? 'gantt' : preferredView
  const [workDayOffset, setWorkDayOffset] = useState(5)
  const dataScope = JSON.stringify([query, areaId, status, archived, range, customStart, customEnd, workDayOffset])
  const [creating, setCreating] = useState<'area' | 'milestone' | null>(null)
  const [editingSchedule, setEditingSchedule] = useState<MilestoneOverview | null>(null)
  const selected = params.get('selected') || ''
  const selectedMatch = /^(area|milestone):(.+)$/.exec(selected)
  const selection: ProjectSelection | null = selectedMatch ? {
    type: selectedMatch[1] as 'area' | 'milestone', id: selectedMatch[2],
    name: selectedMatch[1] === 'area' ? areas.find(a => a.id === selectedMatch[2])?.name || '' : data?.milestones.find(m => m.id === selectedMatch[2])?.name || '',
  } : null
  const select = (target: ProjectSelection) => update({ selected: `${target.type}:${target.id}` })
  useLayoutEffect(() => {
    if (!resumedView.current) {
      resumedView.current = true
      const explicit = new URLSearchParams(location.search)
      explicit.delete('lang')
      if (!explicit.size) {
        try {
          const saved = sessionStorage.getItem('chronicle:project-last-view')
          if (saved?.startsWith('/projects?')) {
            const next = new URL(saved, window.location.origin)
            const language = new URLSearchParams(location.search).get('lang')
            if (language) next.searchParams.set('lang', language)
            if (next.pathname + next.search !== location.pathname + location.search) {
              navigate(next.pathname + next.search, { replace: true })
              return
            }
          }
        } catch { /* Resume is optional when session storage is unavailable. */ }
      }
    }
    try { sessionStorage.setItem('chronicle:project-last-view', location.pathname + location.search) } catch { /* The URL still preserves this view. */ }
  }, [location.pathname, location.search, navigate])
  useEffect(() => { fetchStartOfDayOffset().then(setWorkDayOffset).catch(() => {}) }, [])
  useEffect(() => {
    const remove = [
      registerShortcut({ id: 'projects-search', combo: 'mod+f', label: t('project.overview.search'), scope: 'page', handler: () => { searchRef.current?.focus(); searchRef.current?.select() } }),
      registerShortcut({ id: 'projects-new', combo: 'mod+n', label: t('project.overview.newMilestone'), scope: 'page', handler: () => setCreating(areas.some(a => !a.archived) ? 'milestone' : 'area') }),
    ]
    return () => remove.forEach(unregister => unregister())
  }, [areas, t])
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
    const timer = window.setTimeout(() => { projectApi.overview({ start, end, asOf: now, query: query || undefined, areaId: areaId || undefined, status: status || undefined, includeArchived: archived, limit: 1000 }).then(result => { if (active) { setData(result); setDataPeriod(range); setLoadedDataScope(dataScope); setError('') } }).catch(e => { if (active) setError(projectError(e)) }) }, query ? 180 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, areaId, status, archived, range, customStart, customEnd, workDayOffset, dataScope, refresh, tick])
  // A pending filter cannot relabel the last successful statistics snapshot.
  const shownPeriod = data ? dataPeriod : range
  const periodLabel = t(shownPeriod === 'week' ? 'project.overview.week' : shownPeriod === 'month' ? 'project.overview.month' : shownPeriod === 'all' ? 'project.overview.totalShort' : 'project.overview.periodShort')
  const compactControl = 'h-8 rounded-md border border-border/70 bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30'
  const visibleAreas = areas.filter(a => (archived || !a.archived) && (!areaId || a.id === areaId) && (!query || a.name.toLowerCase().includes(query.toLowerCase()) || data?.milestones.some(m => m.areaId === a.id)))
  const rangeContext = data ? { start: data.statistics.start, end: data.statistics.end, asOf: data.statistics.asOf } : {}
  const navigationContext = { returnTo: location.pathname + location.search, range: rangeContext, periodLabel }
  const listKey = projectScrollKey('list', location.search)
  // The retained rows belong to their successful request, not a pending filter.
  // Restore only after the matching rows have their full scrollable height.
  const listDataReady = Boolean(data) && loadedDataScope === dataScope
  useLayoutEffect(() => {
    if (view !== 'list' || !listDataReady || !listRef.current) return
    const element = listRef.current
    const position = readProjectScroll(listKey)
    element.scrollLeft = position.left; element.scrollTop = position.top
    const owner = { key: listKey, element }
    listScrollOwner.current = owner
    return () => {
      if (listScrollOwner.current !== owner) return
      if (owner.element.isConnected) saveProjectScroll(owner.key, owner.element)
      listScrollOwner.current = null
    }
  }, [view, listKey, listDataReady, dataScope])
  return <div className="flex h-full min-h-0 flex-col" data-testid="projects-page">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
      <div><h1 className="text-xl font-semibold tracking-tight">{t('project.overview.title')}</h1>{data && <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t('project.overview.effort', { period: periodLabel })} <strong className="ml-1 font-semibold tabular-nums text-foreground">{duration(data.statistics.totalMs)}</strong></span><span className="text-border">/</span><span>{t('project.overview.visible', { count: String(data.milestones.length) })}</span><span>{t('project.overview.completed', { count: String(data.milestones.filter(m => m.status === 'completed').length) })}</span>{data.milestones.some(m => m.reviewStatus === 'pending') && <span className="text-amber-700 dark:text-amber-400">{t('project.overview.reviewDue', { count: String(data.milestones.filter(m => m.reviewStatus === 'pending').length) })}</span>}</div>}</div>
      <div className="flex gap-2"><button className={`${compactControl} inline-flex items-center gap-1.5 hover:bg-muted`} aria-label={t('project.overview.newArea')} onClick={() => setCreating('area')}><Plus className="h-3.5 w-3.5" />{t('project.overview.area')}</button><button className={`${compactControl} inline-flex items-center gap-1.5 border-primary bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40`} disabled={!areas.some(a => !a.archived)} aria-label={t('project.overview.newMilestone')} title={`${t('project.overview.newMilestone')} (⌘N)`} onClick={() => setCreating('milestone')}><Plus className="h-3.5 w-3.5" />{t('project.overview.milestone')}</button></div>
    </header>
    <div className="shrink-0 space-y-2 px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3 w-3 text-muted-foreground" /><input ref={searchRef} className={`${compactControl} w-52 pl-7 pr-10`} placeholder={t('project.overview.searchHint')} aria-label={t('project.overview.search')} value={query} onChange={e => update({ q: e.target.value })} /><kbd className="pointer-events-none absolute right-2.5 top-2 text-[10px] text-muted-foreground/70">⌘F</kbd></label>
          <ProjectSelect compact className="max-w-48" label={t('project.overview.areaFilter')} value={areaId} onChange={value => update({ area: value })} options={[{ value: '', label: t('project.overview.allAreas') }, ...areas.map(a => ({ value: a.id, label: a.name, description: a.archived ? t('project.overview.archived') : undefined }))]} />
          <ProjectSelect compact label={t('project.overview.period')} value={range} onChange={value => update({ period: value })} options={['week', 'month', 'all', 'custom'].map(value => ({ value, label: t(`project.overview.${value === 'all' ? 'allTime' : value}`) }))} />
          <button className={`${compactControl} inline-flex items-center gap-1.5 border-transparent hover:bg-muted ${filtersOpen || status || archived ? 'bg-muted text-foreground' : 'text-muted-foreground'}`} aria-expanded={filtersOpen} onClick={() => update({ filters: filtersOpen ? null : '1' })}><SlidersHorizontal className="h-3 w-3" />{t('project.overview.filters')}{(status || archived) && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}</button>
        </div>
        <div className="flex items-center gap-2"><div className="flex rounded-md bg-muted/70 p-0.5" aria-label={t('project.overview.view')}>{(['gantt', 'list'] as const).map(value => { const Icon = value === 'gantt' ? GanttChart : Rows; return <button key={value} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs ${view === value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-pressed={view === value} onClick={() => { update({ view: value }); try { localStorage.setItem('chronicle:project-view', value) } catch { /* Optional preference. */ } }}><Icon className="h-3 w-3" />{t(value === 'gantt' ? 'project.overview.timeline' : 'project.workspace.effortView')}</button> })}</div><button className="rounded-md p-2 text-muted-foreground hover:bg-muted" onClick={() => { setTick(n => n + 1); void load() }} aria-label={t('project.overview.refresh')}><RefreshCw className="h-3.5 w-3.5" /></button></div>
      </div>
      {filtersOpen && <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-2 text-xs"><ProjectSelect compact label={t('project.overview.statusFilter')} value={status} onChange={value => update({ status: value })} options={[{ value: '', label: t('project.overview.allStatuses') }, ...['planned', 'active', 'paused', 'completed', 'cancelled', 'ended'].map(value => ({ value, label: statusLabels[value] }))]} /><label className="flex items-center gap-2"><input type="checkbox" checked={archived} onChange={e => update({ archived: e.target.checked ? '1' : null })} />{t('project.overview.showArchived')}</label>{(status || archived) && <button className="text-muted-foreground hover:text-foreground" onClick={() => update({ status: null, archived: null })}>{t('project.overview.reset')}</button>}</div>}
      {range === 'custom' && <div className="flex flex-wrap items-center gap-2 text-xs"><input type="date" aria-label={t('project.overview.start')} className={compactControl} value={customStart} onChange={e => update({ start: e.target.value })} /><span>{t('project.overview.to')}</span><input type="date" aria-label={t('project.overview.end')} className={compactControl} value={customEnd} onChange={e => update({ end: e.target.value })} /></div>}
      <ErrorMessage>{error}</ErrorMessage>
    </div>
    <div className="relative mx-5 mb-3 flex min-h-0 flex-1 gap-3" data-testid="project-workspace">
      <div className="min-w-0 flex-1" onKeyDown={event => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !['ArrowDown', 'ArrowUp', 'j', 'k'].includes(event.key)) return
        if (!(event.target instanceof Element) || !event.target.closest('[data-project-object]')) return
        const objects = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-project-object]'))
        const index = objects.findIndex(button => button === event.target || button.contains(event.target as Node))
        const next = objects[Math.max(0, Math.min(objects.length - 1, index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1)))]
        if (next) { event.preventDefault(); next.focus(); next.click() }
      }}>
        {data && (!areas.length ? <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center"><GanttChart className="mb-4 h-8 w-8 text-muted-foreground/50" /><h2 className="text-base font-medium">{t('project.overview.empty')}</h2><p className="mb-5 mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{t('project.overview.emptyHint')}</p><button className={`${compactControl} bg-primary text-primary-foreground`} onClick={() => setCreating('area')}>{t('project.overview.newArea')}</button></div> : view === 'gantt' ? <ProjectGantt areas={visibleAreas} milestones={data.milestones} statistics={data.statistics} onSelect={select} onSchedule={setEditingSchedule} periodLabel={periodLabel} /> : <div ref={listRef} className="h-full overflow-auto rounded-lg border border-border/70 bg-card" onScroll={event => {
          const owner = listScrollOwner.current
          if (listDataReady && owner?.key === listKey && owner.element === event.currentTarget) saveProjectScroll(owner.key, owner.element)
        }} data-testid="project-effort-list">
          <div className="sticky top-0 z-10 border-b bg-card px-4 py-3 text-xs text-muted-foreground">{t('project.workspace.allSchedules')}</div>
          {!data.milestones.length ? <Empty>{t('project.overview.emptyFilter')}</Empty> : <div className="min-w-[640px]">
            <div className="grid grid-cols-[minmax(180px,1fr)_80px_100px_minmax(180px,1.2fr)] gap-4 border-b bg-muted/50 px-4 py-2 text-[11px] text-muted-foreground"><span>{t('project.workspace.name')}</span><span className="text-right">{periodLabel}</span><span>{t('project.overview.statusFilter')}</span><span>{t('project.workspace.progress')}</span></div>
            {[...data.milestones].sort((a, b) => b.periodMs - a.periodMs || a.name.localeCompare(b.name)).map(m => <button key={m.id} data-testid="milestone-card" data-project-object={`milestone:${m.id}`} aria-pressed={selected === `milestone:${m.id}`} className={`grid w-full grid-cols-[minmax(180px,1fr)_80px_100px_minmax(180px,1.2fr)] items-start gap-4 border-b border-l-2 px-4 py-3 text-left text-xs transition hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${selected === `milestone:${m.id}` ? 'border-l-primary bg-primary/5' : 'border-l-transparent'}`} onClick={() => select({ type: 'milestone', id: m.id, name: m.name })}>
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{m.name}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{m.areaName}</span></span>
              <span className="text-right font-medium tabular-nums">{duration(m.periodMs)}</span>
              <span className="text-muted-foreground">{statusLabels[m.status]}{m.reviewStatus === 'pending' && <span className="mt-1 block text-[10px] text-amber-700 dark:text-amber-400">{t('project.overview.reviewPending')}</span>}</span>
              <span className="min-w-0"><span className="line-clamp-2">{m.latestProgress || '—'}</span>{m.nextStep && <span className="mt-1 line-clamp-1 text-muted-foreground">{t('project.overview.next')}: {m.nextStep}</span>}</span>
            </button>)}
          </div>}
        </div>)}
      </div>
      {selection && data && <ProjectNotesPanel target={selection} onClose={() => update({ selected: null })} onSelect={select} range={rangeContext} periodLabel={periodLabel} />}
    </div>
    {data && <footer className="relative flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-2 text-[11px] text-muted-foreground"><div className="flex flex-wrap gap-3">{(areaId || query || status) && <span>{t('project.overview.filteredEffort', { duration: duration(data.milestones.reduce((sum, m) => sum + m.periodMs, 0)) })}</span>}<button className="hover:text-foreground hover:underline" onClick={() => navigate(withProjectNavigation('/?projectFilter=unassigned', navigationContext), { state: projectNavigationState(navigationContext) })}>{t('project.overview.unassignedEffort', { duration: duration(data.statistics.unassignedMs) })}</button>{!!data.statistics.anomalies.length && <span className="text-amber-600">{t('project.overview.anomalies', { count: String(data.statistics.anomalies.length) })}</span>}</div><details className="group text-right"><summary className="cursor-pointer hover:text-foreground">{t('project.overview.accounting')}</summary><p className="absolute bottom-full right-5 z-30 mb-2 w-80 rounded-lg border bg-popover p-4 text-left leading-5 text-popover-foreground shadow-lg">{t('project.overview.accountingHint')}<span className="mt-2 block text-muted-foreground">{t('project.overview.asOf', { date: dateLabel(data.statistics.asOf) })}</span></p></details></footer>}
    {creating && <ProjectEditor type={creating} areaId={areaId || undefined} onClose={() => setCreating(null)} onSaved={id => { const type = creating; setCreating(null); update({ selected: `${type}:${id}` }) }} />}
    {editingSchedule && <ProjectEditor type="milestone" mode="schedule" value={editingSchedule} onClose={() => setEditingSchedule(null)} onSaved={() => setEditingSchedule(null)} />}
  </div>
}
