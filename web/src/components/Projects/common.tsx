import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useI18n } from '@/i18n/context'
export const control = 'rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50'
export const button = `${control} hover:bg-muted transition`
export const primaryButton = `${control} bg-primary text-primary-foreground hover:opacity-90`
export function useProjectLabels() {
  const { t, locale } = useI18n()
  const statusLabels: Record<string, string> = Object.fromEntries(['active', 'paused', 'ended', 'planned', 'completed', 'cancelled', 'PENDING', 'DOING', 'DONE', 'DROPPED', 'ON_HOLD'].map(status => [status, t(`project.status.${status}`)]))
  const roleLabels: Record<string, string> = Object.fromEntries(['related', 'outcome', 'review', 'growth'].map(role => [role, t(`project.role.${role}`)]))
  const duration = (ms: number) => ms < 3_600_000
    ? t('project.duration.minutes', { count: String(ms < 60_000 ? 0 : Math.round(ms / 60_000)) })
    : t('project.duration.hours', { count: (ms / 3_600_000).toFixed(1) })
  const dateLabel = (ms: number | null | undefined) => ms == null ? '—' : new Date(ms).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
  return { statusLabels, roleLabels, duration, dateLabel }
}
export function ErrorMessage({ children }: { children?: ReactNode }) { return children ? <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">{children}</p> : null }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">{label}</span>{children}</label> }
export function useProjectRefresh() {
  const [version, setVersion] = useState(0)
  useEffect(() => { const update = () => setVersion(n => n + 1); window.addEventListener('chronicle:projects-changed', update); return () => window.removeEventListener('chronicle:projects-changed', update) }, [])
  return version
}
export function Empty({ children }: { children: ReactNode }) { return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{children}</div> }

export function dateInputValue(ms: number) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
