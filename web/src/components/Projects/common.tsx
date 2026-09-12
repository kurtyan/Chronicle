import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
export const control = 'rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50'
export const button = `${control} hover:bg-muted transition`
export const primaryButton = `${control} bg-primary text-primary-foreground hover:opacity-90`
export const statusLabels: Record<string, string> = { active: '进行中', paused: '暂停', ended: '结束跟踪', planned: '筹备', completed: '已完成', cancelled: '已取消', PENDING: '待开始', DOING: '进行中', DONE: '已完成', DROPPED: '已取消', ON_HOLD: '暂停' }
export const roleLabels: Record<string, string> = { related: '相关资料', outcome: '成果', review: '复盘', growth: '成长证据' }
export function duration(ms: number) { return ms < 60_000 ? '0 分钟' : ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${(ms / 3_600_000).toFixed(1)} 小时` }
export function dateLabel(ms: number | null | undefined) { return ms ? new Date(ms).toLocaleString() : '—' }
export function ErrorMessage({ children }: { children?: ReactNode }) { return children ? <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">{children}</p> : null }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">{label}</span>{children}</label> }
export function useProjectRefresh() {
  const [version, setVersion] = useState(0)
  useEffect(() => { const update = () => setVersion(n => n + 1); window.addEventListener('chronicle:projects-changed', update); return () => window.removeEventListener('chronicle:projects-changed', update) }, [])
  return version
}
export function Empty({ children }: { children: ReactNode }) { return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{children}</div> }

export function dateInputValue(ms: number) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
