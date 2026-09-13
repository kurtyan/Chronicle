import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Maximize2, X } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { entityPath } from '@/services/projectApi'
import type { MilestoneOverview, WorkStatisticsRange } from '@/services/projectApi'
import { projectNavigationState, withProjectNavigation } from '@/lib/projectNavigation'
import { ProjectObjectWorkspace } from './ProjectObjectWorkspace'

export interface ProjectSelection { type: 'area' | 'milestone'; id: string; name: string }

/** A nonmodal inspector: selecting another object never closes the workspace. */
export function ProjectNotesPanel({ target, onClose, range = {}, periodLabel = '', onSelect }: {
  target: ProjectSelection
  onClose: () => void
  range?: WorkStatisticsRange
  periodLabel?: string
  onSelect?: (target: ProjectSelection) => void
  onSchedule?: (milestone: MilestoneOverview) => void
}) {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const panel = useRef<HTMLElement>(null)
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const [width, setWidth] = useState(() => { try { return Math.max(380, Math.min(760, Number(localStorage.getItem('chronicle:project-inspector-width')) || 480)) } catch { return 480 } })
  const returnTo = location.pathname + location.search
  const context = { returnTo, range, periodLabel }
  const close = () => {
    // Switching views replaces the original opener without replacing this panel.
    // Resolve the selected object's current row/bar before removing the inspector.
    const workspace = panel.current?.closest('[data-testid="project-workspace"]')
    const objectKey = `${target.type}:${target.id}`
    const currentObject = Array.from(workspace?.querySelectorAll<HTMLButtonElement>('button[data-project-object]') || [])
      .find(button => !panel.current?.contains(button) && button.getAttribute('data-project-object') === objectKey)
    const destination = currentObject || opener.current
    onClose()
    if (destination?.isConnected && !panel.current?.contains(destination)) destination.focus()
  }
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !panel.current?.contains(active)) opener.current = active
  }, [target.type, target.id])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"]')) return
      if (event.target instanceof Element && event.target.closest('[data-testid="project-inline-editor"]')) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  })
  const resize = (value: number) => {
    const next = Math.max(380, Math.min(760, window.innerWidth * 0.5, value))
    setWidth(next)
    try { localStorage.setItem('chronicle:project-inspector-width', String(next)) } catch { /* Optional preference. */ }
  }
  return <aside ref={panel} role="region" aria-label={t('project.workspace.inspect')} data-testid="project-context-panel"
    className="absolute inset-y-0 right-0 z-30 flex max-w-[calc(100vw-84px)] flex-col rounded-lg border border-border bg-background shadow-xl xl:relative xl:inset-auto xl:z-auto xl:shrink-0 xl:shadow-none" style={{ width }}>
    <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('project.workspace.resize')} aria-valuenow={width}
      className="absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize rounded hover:bg-primary/10 focus-visible:bg-primary/10 xl:block"
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); resize(width + (event.key === 'ArrowLeft' ? 32 : -32)) } }}
      onPointerDown={event => {
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        const startX = event.clientX; const startWidth = width
        const move = (next: PointerEvent) => resize(startWidth + startX - next.clientX)
        const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop)
      }} />
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
      <span className="truncate">{t('project.overview.effort', { period: periodLabel })}</span>
      <div className="flex items-center gap-1">
        <button className="rounded-md p-1.5 hover:bg-muted hover:text-foreground" title={t('project.workspace.expand')} aria-label={t('project.workspace.expand')}
          onClick={() => navigate(withProjectNavigation(entityPath(target.type, target.id), context), { state: projectNavigationState(context) })}><Maximize2 className="h-3.5 w-3.5" /></button>
        <button className="rounded-md p-1.5 hover:bg-muted hover:text-foreground" title={`${t('project.workspace.close')} (Esc)`} aria-label={t('project.workspace.close')} onClick={close}><X className="h-4 w-4" /></button>
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto" key={`${target.type}:${target.id}`}>
      <ProjectObjectWorkspace target={target} range={range} periodLabel={periodLabel} returnTo={returnTo} onSelect={selection => onSelect?.({ ...selection, name: selection.name || '' })} compact />
    </div>
  </aside>
}
