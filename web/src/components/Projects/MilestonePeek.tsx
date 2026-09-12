import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MilestoneOverview } from '@/services/projectApi'
import { duration, statusLabels } from './common'

export interface MilestonePeekTarget { milestone: MilestoneOverview; anchor: HTMLElement }
export function MilestonePeek({ target, periodLabel, onEnter, onLeave }: { target: MilestonePeekTarget; periodLabel: string; onEnter: () => void; onLeave: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false })
  const m = target.milestone
  useLayoutEffect(() => {
    const rect = target.anchor.getBoundingClientRect()
    const height = panel.current?.offsetHeight ?? 220
    const width = Math.min(310, window.innerWidth - 24)
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: Math.max(12, rect.bottom + height + 12 < window.innerHeight ? rect.bottom + 8 : rect.top - height - 8), ready: true,
    })
  }, [target])
  const date = (value: number) => new Date(value).toLocaleDateString('zh-CN')
  const schedule = m.startDate !== null && m.targetDate !== null ? `${date(m.startDate)} — ${date(m.targetDate)}` : m.startDate !== null ? `${date(m.startDate)} 起 · ${m.kind === 'ongoing' ? '持续跟踪' : '结束待定'}` : m.targetDate !== null ? `目标 ${date(m.targetDate)} · 开始待定` : '待排期'
  return createPortal(<div ref={panel} id="milestone-peek" role="tooltip" data-testid="milestone-peek" onMouseEnter={onEnter} onMouseLeave={onLeave} className="fixed z-[60] max-h-[calc(100vh-24px)] w-[310px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border/70 bg-popover p-4 text-popover-foreground shadow-xl" style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}>
    <p className="text-[11px] text-muted-foreground">{m.areaName} <span className="mx-1">/</span> {statusLabels[m.status]}{m.reviewStatus === 'pending' ? ' · 待复盘' : ''}</p>
    <p className="mt-1 break-words text-sm font-semibold leading-5">{m.name}</p>
    <p className="mt-2 text-xs text-muted-foreground">{schedule}</p>
    <div className="mt-3 flex gap-6 border-t border-border/60 pt-3 text-xs">{periodLabel !== '累计' && <div><p className="text-[10px] text-muted-foreground">{periodLabel}投入</p><p className="mt-1 font-medium">{duration(m.periodMs)}</p></div>}<div><p className="text-[10px] text-muted-foreground">累计投入</p><p className="mt-1 font-medium">{duration(m.totalMs)}</p></div></div>
    {m.latestProgress && <p className="mt-3 line-clamp-3 text-xs leading-5"><span className="text-muted-foreground">最新进展 · </span>{m.latestProgress}</p>}
    {m.blockers && <p className="mt-2 line-clamp-2 text-xs leading-5 text-amber-700 dark:text-amber-400">阻碍 · {m.blockers}</p>}
    <p className="mt-3 text-[10px] text-muted-foreground">点击查看详情与关联笔记</p>
  </div>, document.body)
}
