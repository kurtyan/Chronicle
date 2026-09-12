import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { FileText, ArrowUpRight, CalendarDays, X } from 'lucide-react'
import { projectApi, entityPath, projectError } from '@/services/projectApi'
import type { AreaDetail, MilestoneDetail, MilestoneOverview, ProjectTargetType, WorkStatisticsRange } from '@/services/projectApi'
import { AreaSummary } from './AreaSummary'
import { button, duration, Empty, ErrorMessage, roleLabels, statusLabels, useProjectRefresh } from './common'

export interface ProjectSelection { type: ProjectTargetType; id: string; name: string }

function scheduleLabel(milestone: MilestoneOverview) {
  const date = (value: number) => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
  if (milestone.startDate != null && milestone.targetDate != null) return `${date(milestone.startDate)} — ${date(milestone.targetDate)}`
  if (milestone.startDate != null) return `${date(milestone.startDate)} 开始 · 未设截止`
  if (milestone.targetDate != null) return `${date(milestone.targetDate)} 截止 · 未设开始`
  return '尚未设置日期'
}

/** Context stays beside the roadmap; reading a Note remains an explicit navigation. */
export function ProjectNotesPanel({ target, onClose, onSchedule, range, periodLabel = '期间' }: {
  target: ProjectSelection
  onClose: () => void
  onSchedule?: (milestone: MilestoneOverview) => void
  range?: WorkStatisticsRange
  periodLabel?: string
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const refresh = useProjectRefresh()
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const [data, setData] = useState<AreaDetail | MilestoneDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    // Retain same-object data during refreshes so SSE cannot unmount an open
    // summary editor or replace its independent, revision-checked text snapshot.
    setData(current => current?.id === target.id ? current : null)
    setError('')
    const request = target.type === 'area' ? projectApi.area(target.id, range) : projectApi.milestone(target.id, range)
    request.then(value => { if (active) setData(value) }).catch(e => { if (active) setError(projectError(e)) })
    return () => { active = false }
  }, [target.type, target.id, refresh, range?.start, range?.end, range?.asOf])
  const current = data?.id === target.id ? data : null
  const area = current && 'focus' in current ? current : null
  const milestone = current && 'kind' in current ? current : null
  const periodMs = area ? area.statistics.byArea.find(item => item.id === area.id)?.totalMs || 0 : milestone?.periodMs || 0
  const totalMs = area ? area.milestones.reduce((sum, item) => sum + item.totalMs, 0) : milestone?.totalMs || 0
  const limitedPeriod = periodLabel !== '累计' && (range?.start != null || range?.end != null)
  const open = (path: string) => { onClose(); navigate(path, { state: { returnTo: location.pathname + location.search } }) }
  return <DialogPrimitive.Root open onOpenChange={value => { if (!value) onClose() }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-transparent" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        data-testid="project-context-panel"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-border bg-background shadow-[-16px_0_48px_-24px_hsl(var(--foreground)/0.25)] outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right"
        onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus() }}
      >
        <header className="shrink-0 border-b border-border/60 px-6 py-5 pr-14">
          <p className="mb-2 text-xs text-muted-foreground">{milestone ? `${milestone.areaName} / 里程碑` : target.type === 'area' ? '方向' : '里程碑'}</p>
          <DialogPrimitive.Title className="break-words text-xl font-semibold leading-snug tracking-tight">{current?.name || target.name}</DialogPrimitive.Title>
          {current && <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><span className="rounded bg-muted px-2 py-0.5">{statusLabels[current.status]}</span>{milestone?.kind === 'ongoing' && <span>持续跟踪</span>}{current.archived && <span>已归档</span>}</div>}
        </header>
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="h-4 w-4" /><span className="sr-only">Close</span>
        </DialogPrimitive.Close>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <ErrorMessage>{error}</ErrorMessage>
          {current ? <>
            <section className="space-y-3">
              {milestone && <div className="flex items-start justify-between gap-3 text-xs"><p className="flex items-start gap-2 leading-5 text-muted-foreground"><CalendarDays className="mt-0.5 h-4 w-4 shrink-0" />{scheduleLabel(milestone)}</p>{onSchedule && <button className="shrink-0 rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { onClose(); onSchedule(milestone) }}>调整排期</button>}</div>}
              <div className={`grid gap-4 rounded-lg bg-muted/40 px-4 py-3 ${limitedPeriod ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {limitedPeriod && <div><p className="text-xs text-muted-foreground">{periodLabel}投入</p><p className="mt-1 text-lg font-semibold tabular-nums">{duration(periodMs)}</p></div>}
                <div className={limitedPeriod ? 'border-l border-border/60 pl-4' : ''}><p className="text-xs text-muted-foreground">累计投入</p><p className="mt-1 text-lg font-semibold tabular-nums">{duration(totalMs)}</p></div>
              </div>
              {milestone && <p className="text-xs text-muted-foreground">Task 已完成 {milestone.doneTaskCount} / {milestone.taskCount}{milestone.reviewStatus === 'pending' ? ' · 待复盘' : milestone.reviewStatus === 'confirmed' ? ' · 已复盘' : ''}</p>}
            </section>
            {area && <section className="space-y-3 border-t border-border/60 pt-5 [&_[data-testid=area-summary]_.grid]:grid-cols-1 [&_[data-testid=area-summary]_.line-clamp-2]:line-clamp-none"><h2 className="text-sm font-semibold">进展与下一步</h2><AreaSummary area={area} compact /></section>}
            {milestone && (milestone.latestProgress || milestone.nextStep || milestone.blockers) && <section className="space-y-4 border-t border-border/60 pt-5">{[['最新进展', milestone.latestProgress], ['下一步计划', milestone.nextStep], ['阻碍', milestone.blockers]].filter(([, text]) => text).map(([label, text]) => <div key={label}><h2 className="text-xs font-semibold text-muted-foreground">{label}</h2><p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</p></div>)}</section>}
            <section className="space-y-3 border-t border-border/60 pt-5">
              <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">关联 Notes <span className="ml-1 font-normal text-muted-foreground">共 {current.backlinks.notes.length} 篇</span></h2><button className="shrink-0 rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => open(`/notes?projectFilter=${encodeURIComponent(`${target.type}:${target.id}`)}`)}>在 Notes 中查看</button></div>
              {current.backlinks.notes.length ? <div className="divide-y divide-border/50" data-testid="project-linked-notes">{current.backlinks.notes.map(note => {
                const via = note.via.map(item => item.viaTaskTitle ? `${item.name} · 来自 Task ${item.viaTaskTitle}` : item.name).filter((name, index, all) => all.indexOf(name) === index).join(' · ')
                return <button key={note.sourceId} className="group -mx-2 block w-[calc(100%+1rem)] rounded-lg px-2 py-3 text-left transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => open(`/notes?id=${encodeURIComponent(note.sourceId)}`)}>
                  <div className="flex items-start gap-2.5"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium leading-5 group-hover:text-primary">{note.title || '未命名笔记'}</p><p className="mt-1.5 text-xs text-muted-foreground">{note.roles.map(role => roleLabels[role]).join(' · ')}</p><p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground" title={via}>{via}</p></div><ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50 group-hover:text-primary" /></div>
                </button>
              })}</div> : <Empty>还没有关联笔记。在 Notes 中添加这个{target.type === 'area' ? '方向' : '里程碑'}标签，即可在这里找到。</Empty>}
            </section>
          </> : !error && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}
        </div>
        <footer className="shrink-0 border-t border-border/60 px-6 py-4"><button className={`${button} flex w-full items-center justify-between`} onClick={() => open(entityPath(target.type, target.id))}>查看目标与 Task <ArrowUpRight className="h-4 w-4" /></button></footer>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
}
