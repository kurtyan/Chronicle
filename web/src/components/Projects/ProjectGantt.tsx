import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Pause, X } from 'lucide-react'
import type { Area, MilestoneOverview, WorkStatistics } from '@/services/projectApi'
import type { ProjectSelection } from './ProjectNotesPanel'
import { MilestonePeek } from './MilestonePeek'
import type { MilestonePeekTarget } from './MilestonePeek'
import { addCalendarDays as addDays, calendarDay as day, layoutMilestones, TRACK_HEIGHT } from './ganttLayout'

const label = (value: number) => new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
const fullLabel = (value: number) => new Date(value).toLocaleDateString('zh-CN')
const compactDuration = (ms: number) => ms < 60_000 ? '0h' : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Number((ms / 3_600_000).toFixed(1))}h`
const iconButton = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary'
const colors: Record<string, string> = {
  active: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
  planned: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  paused: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
  cancelled: 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
  ended: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
}
export function milestoneSchedule(m: Pick<MilestoneOverview, 'startDate' | 'targetDate' | 'kind'>) {
  if (m.startDate !== null && m.targetDate !== null) return `${fullLabel(m.startDate)} — ${fullLabel(m.targetDate)}`
  if (m.startDate !== null) return `${fullLabel(m.startDate)} 开始 · ${m.kind === 'ongoing' ? '持续跟踪' : '结束待定'}`
  if (m.targetDate !== null) return `目标 ${fullLabel(m.targetDate)} · 开始待定`
  return '待排期'
}

export function ProjectGantt({ areas, milestones, statistics, onSelect, onSchedule, periodLabel }: {
  areas: Area[]; milestones: MilestoneOverview[]; statistics: WorkStatistics
  onSelect: (target: ProjectSelection) => void; onSchedule: (milestone: MilestoneOverview) => void; periodLabel: string
}) {
  const [scale, setScale] = useState<'week' | 'month'>('week')
  const [anchor, setAnchor] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [shelves, setShelves] = useState<Record<string, 'undated' | 'outside' | undefined>>({})
  const [peek, setPeek] = useState<MilestonePeekTarget | null>(null)
  const peekTimer = useRef<ReturnType<typeof setTimeout>>()
  const clearPeekTimer = () => { clearTimeout(peekTimer.current) }
  const closePeek = () => { clearPeekTimer(); setPeek(null) }
  const leavePeek = () => { clearPeekTimer(); peekTimer.current = setTimeout(() => setPeek(null), 180) }
  const showPeek = (milestone: MilestoneOverview, element: HTMLElement, immediate = false) => {
    clearPeekTimer()
    if (immediate) setPeek({ milestone, anchor: element })
    else peekTimer.current = setTimeout(() => setPeek({ milestone, anchor: element }), 280)
  }
  useEffect(() => () => clearTimeout(peekTimer.current), [])
  useEffect(() => { closePeek() }, [milestones, anchor, scale])
  useEffect(() => {
    if (!peek) return
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') closePeek() }
    const scrolled = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest('#milestone-peek')) closePeek() }
    document.addEventListener('keydown', keydown)
    document.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', closePeek)
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', closePeek) }
  }, [peek])
  const axis = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(700)
  useLayoutEffect(() => {
    if (!axis.current) return
    const measure = () => setTrackWidth(axis.current!.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(axis.current)
    return () => observer.disconnect()
  }, [])
  const timeWindow = useMemo(() => {
    const d = new Date(anchor)
    if (scale === 'month') {
      const start = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime()
      return { start, end: new Date(d.getFullYear(), d.getMonth() + 5, 1).getTime(), ticks: Array.from({ length: 6 }, (_, i) => new Date(d.getFullYear(), d.getMonth() - 1 + i, 1).getTime()) }
    }
    const monday = addDays(day(anchor), -((d.getDay() + 6) % 7))
    const start = addDays(monday, -14)
    return { start, end: addDays(start, 70), ticks: Array.from({ length: 10 }, (_, i) => addDays(start, i * 7)) }
  }, [anchor, scale])
  const position = (date: number) => (date - timeWindow.start) / (timeWindow.end - timeWindow.start) * 100
  const todayPosition = position(day(Date.now()))
  const move = (direction: number) => setAnchor(value => {
    const date = new Date(value)
    if (scale === 'month') { date.setDate(1); date.setMonth(date.getMonth() + direction * 3) }
    else date.setDate(date.getDate() + direction * 35)
    return date.getTime()
  })
  const selectMilestone = (m: MilestoneOverview) => { closePeek(); onSelect({ type: 'milestone', id: m.id, name: m.name }) }
  return <section data-testid="project-gantt" className="overflow-hidden rounded-xl border border-border/70 bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex items-center gap-1"><button className={iconButton} aria-label="上一时间窗口" onClick={() => move(-1)}><ChevronLeft className="h-4 w-4" /></button><span className="min-w-[174px] text-center text-[13px] font-medium tabular-nums">{fullLabel(timeWindow.start)} — {label(addDays(timeWindow.end, -1))}</span><button className={iconButton} aria-label="下一时间窗口" onClick={() => move(1)}><ChevronRight className="h-4 w-4" /></button><button className="ml-2 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setAnchor(Date.now())}>今天</button></div>
      <div className="flex rounded-lg bg-muted/70 p-0.5">{(['week', 'month'] as const).map(value => <button key={value} className={`rounded-md px-3 py-1 text-xs transition ${scale === value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-pressed={scale === value} onClick={() => setScale(value)}>{value === 'week' ? '按周' : '按月'}</button>)}</div>
    </div>
    <div className="max-h-[70vh] overflow-auto" role="region" aria-label="方向与里程碑时间规划" tabIndex={0}>
      <div className="min-w-[920px]" style={{ display: 'grid', gridTemplateColumns: '220px minmax(700px, 1fr)' }}>
        <div className="sticky left-0 top-0 z-30 flex h-10 items-center justify-between border-b border-r border-t border-border/60 bg-muted px-4 text-[11px] text-muted-foreground"><span>方向</span><span>{periodLabel}投入</span></div>
        <div ref={axis} className="sticky top-0 z-20 h-10 border-b border-t border-border/60 bg-muted" data-testid="gantt-axis">{timeWindow.ticks.map(tick => <span key={tick} className="absolute top-3 pl-2 text-[11px] tabular-nums text-muted-foreground" style={{ left: `${position(tick)}%` }}>{scale === 'month' ? `${new Date(tick).getMonth() + 1}月` : label(tick)}</span>)}{todayPosition >= 0 && todayPosition < 100 && <span className="absolute top-0 border-l border-rose-400 px-1 text-[9px] font-medium text-rose-500" style={{ left: `${todayPosition}%` }}>今天</span>}</div>
        {!areas.length && <p role="status" className="col-span-2 px-5 py-10 text-center text-sm text-muted-foreground">没有符合筛选的方向或里程碑</p>}
        {areas.map(area => {
          const children = milestones.filter(m => m.areaId === area.id)
          const hidden = collapsed.has(area.id)
          const layout = layoutMilestones(children, timeWindow.start, timeWindow.end, trackWidth)
          const shelf = shelves[area.id]
          return <div key={area.id} className="contents" data-testid="gantt-area-lane" data-area-id={area.id}>
            <div className="group sticky left-0 z-10 border-b border-r border-border/60 bg-card px-3 py-3" data-testid="gantt-area-label">
              <div className="flex h-5 items-center gap-1"><button aria-label={`${hidden ? '展开' : '折叠'}方向 ${area.name}`} aria-expanded={!hidden} className="shrink-0 rounded text-muted-foreground/60 hover:text-foreground" onClick={() => setCollapsed(previous => { const next = new Set(previous); if (hidden) next.delete(area.id); else next.add(area.id); return next })}><ChevronDown className={`h-3 w-3 transition ${hidden ? '-rotate-90' : ''}`} /></button><button className="min-w-0 truncate text-left text-[13px] font-semibold hover:text-primary" title={area.name} onClick={() => { closePeek(); onSelect({ type: 'area', id: area.id, name: area.name }) }}>{area.name}</button><span className="ml-auto pl-2 text-xs font-medium tabular-nums text-muted-foreground">{compactDuration(statistics.byArea.find(g => g.id === area.id)?.totalMs || 0)}</span></div>
              <p className="ml-4 mt-1 truncate text-[11px] text-muted-foreground">{area.archived ? '已归档 · ' : ''}{area.latestProgress || `${children.length} 个里程碑`}</p>
            </div>
            <div className="relative flex min-h-[72px] flex-col border-b border-border/60 bg-card" data-testid="gantt-track">
              {timeWindow.ticks.map(tick => <div key={tick} className="pointer-events-none absolute inset-y-0 border-l border-border/25" style={{ left: `${position(tick)}%` }} />)}
              {todayPosition >= 0 && todayPosition < 100 && <div className="pointer-events-none absolute inset-y-0 z-[1] border-l border-rose-300/80" style={{ left: `${todayPosition}%` }} />}
              {hidden ? <p className="relative p-5 text-xs text-muted-foreground">{children.length} 个里程碑已收起</p> : <>
                {!!layout.scheduled.length && <div className="relative grow" style={{ minHeight: layout.trackCount * TRACK_HEIGHT + 24 }}>
                  {layout.scheduled.map(item => {
                    const m = item.milestone
                    const width = Math.max(3, item.right - item.left)
                    const Icon = m.status === 'completed' ? Check : m.status === 'paused' ? Pause : m.status === 'cancelled' ? X : null
                    return <div key={m.id} className="absolute" data-testid="gantt-milestone-row" data-milestone-id={m.id} data-track-index={item.track} style={{ top: 12 + item.track * TRACK_HEIGHT, left: item.left, width, height: 28 }}>
                      <button className="absolute inset-y-0 rounded-md text-left text-[11px] outline-offset-2 transition hover:brightness-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" style={{ left: item.hitLeft - item.left, width: item.hitRight - item.hitLeft }} aria-label={`${m.name}，${milestoneSchedule(m)}，查看关联笔记`} aria-describedby={peek?.milestone.id === m.id ? 'milestone-peek' : undefined} onMouseEnter={event => showPeek(m, event.currentTarget)} onMouseLeave={leavePeek} onFocus={event => showPeek(m, event.currentTarget, true)} onBlur={closePeek} onClick={() => selectMilestone(m)}>
                        <span data-testid={item.point ? undefined : 'gantt-time-mark'} className={`absolute inset-y-0 flex items-center gap-1.5 overflow-hidden rounded-md ${item.point ? 'text-foreground' : `border ${width > 40 ? 'px-2' : 'px-0'} ${colors[m.status]} ${m.targetDate === null ? 'rounded-r-none border-r-2 border-r-dashed' : ''}`}`} style={{ left: item.left - item.hitLeft, width }}>
                          {item.point ? <><span data-testid="gantt-time-mark" className={`ml-0.5 h-2.5 w-2.5 shrink-0 rotate-45 rounded-sm border ${colors[m.status]}`} /><span className="truncate">{m.name}</span></> : <>{item.clippedStart && width > 70 && <span className="shrink-0 opacity-60">←</span>}{Icon && width > 45 && <Icon className="h-3 w-3 shrink-0" />}<span className="min-w-0 truncate font-medium">{m.name}</span>{m.periodMs > 0 && width > 110 && <span className="ml-auto shrink-0 text-[10px] opacity-70">{compactDuration(m.periodMs)}</span>}{(item.clippedEnd || m.targetDate === null) && width > 70 && <span className={`shrink-0 opacity-60 ${m.periodMs > 0 && width > 110 ? 'ml-1' : 'ml-auto'}`}>→</span>}</>}
                        </span>
                      </button>
                    </div>
                  })}
                </div>}
                {!children.length && <p className="relative px-5 py-6 text-[11px] text-muted-foreground">当前没有匹配的里程碑</p>}
                {(!!layout.undated.length || !!layout.outside.length) && <div className="relative mt-auto bg-card/95 px-4 py-1.5" data-testid="gantt-unscheduled">
                  <div className="flex gap-3">{([['undated', layout.undated, '待排期'], ['outside', layout.outside, '视窗外']] as const).map(([key, values, title]) => !!values.length && <button key={key} className={`inline-flex items-center gap-1 rounded text-[11px] ${shelf === key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`} aria-expanded={shelf === key} onClick={() => setShelves(previous => ({ ...previous, [area.id]: shelf === key ? undefined : key }))}>{title} {values.length}<ChevronDown className={`h-3 w-3 ${shelf === key ? 'rotate-180' : ''}`} /></button>)}</div>
                  {shelf && <div className="mt-2 space-y-2 pb-2">{layout[shelf].map(m => <div key={m.id} className="flex items-center justify-between gap-3 text-xs" data-testid="gantt-milestone-row" data-milestone-id={m.id}><button className="min-w-0 truncate font-medium hover:text-primary" onClick={() => selectMilestone(m)}>{m.name}</button>{shelf === 'undated' ? <button className="shrink-0 text-muted-foreground hover:text-primary" onClick={() => onSchedule(m)}>待排期 · 设置日期</button> : <button className="shrink-0 text-muted-foreground hover:text-primary" onClick={() => setAnchor(day(m.startDate ?? m.targetDate!))}>排期在当前视窗外 · 定位 {label(m.startDate ?? m.targetDate!)}</button>}</div>)}</div>}
                </div>}
              </>}
            </div>
          </div>
        })}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[10px] text-muted-foreground"><div className="flex gap-4"><span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-blue-400" />进行中</span><span className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-emerald-600" />已完成</span><span className="inline-flex items-center gap-1"><Pause className="h-2.5 w-2.5 text-amber-600" />暂停</span><span>◇ 目标日期</span><span>→ 延续</span></div><span>点击查看进展与笔记</span></div>
    {peek && <MilestonePeek target={peek} periodLabel={periodLabel} onEnter={clearPeekTimer} onLeave={leavePeek} />}
  </section>
}
