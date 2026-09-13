import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronRight } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useI18n } from '@/i18n/context'
import { useProjectStore } from '@/stores/projectStore'
import { projectApi, projectError } from '@/services/projectApi'
import type { AssignmentPreview, ProjectTaskSummary, WorkStatistics } from '@/services/projectApi'
import { refreshTaskProjectMetadata } from '@/lib/projectTaskRefresh'
import { ErrorMessage, useProjectLabels } from './common'

export function AssignmentChanges({ before, after }: { before: WorkStatistics; after: WorkStatistics }) {
  const { t } = useI18n()
  const { duration } = useProjectLabels()
  return <div className="space-y-3">{(['byArea', 'byMilestone'] as const).map(kind => {
    const ids = [...new Set([...before[kind], ...after[kind]].map(group => group.id))]
    const changed = ids.filter(id => (before[kind].find(group => group.id === id)?.totalMs || 0) !== (after[kind].find(group => group.id === id)?.totalMs || 0))
    return changed.length ? <div key={kind}><p className="mb-1 text-xs font-medium text-muted-foreground">{t(kind === 'byArea' ? 'project.assignment.areaChanges' : 'project.assignment.milestoneChanges')}</p>{changed.map(id => {
      const a = before[kind].find(group => group.id === id)
      const b = after[kind].find(group => group.id === id)
      return <div key={id} className="flex items-center justify-between gap-4 py-1"><span className="min-w-0 truncate">{b?.name || a?.name}</span><span className="flex shrink-0 items-center gap-2 tabular-nums"><span className="text-muted-foreground">{duration(a?.totalMs || 0)}</span><ArrowRight className="h-3 w-3 text-muted-foreground" /><span>{duration(b?.totalMs || 0)}</span></span></div>
    })}</div> : null
  })}</div>
}

export function AssignmentDialog({ tasks, onClose, onApplied }: { tasks: ProjectTaskSummary[]; onClose: () => void; onApplied?: () => void }) {
  const { t } = useI18n()
  const { duration, dateLabel } = useProjectLabels()
  const { areas, milestones, loaded, load } = useProjectStore()
  const [target, setTarget] = useState<string | undefined>(tasks.length === 1 ? tasks[0].primaryMilestoneId || '' : undefined)
  const [preview, setPreview] = useState<AssignmentPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [eventId, setEventId] = useState<string | null>(null)
  const [additionalMs, setAdditionalMs] = useState(0)
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await fn() } catch (error) { setError(projectError(error)); setPreview(null) }
    finally { setBusy(false) }
  }
  const refreshTask = async () => { await refreshTaskProjectMetadata(tasks.map(task => task.id)); onApplied?.() }
  const targetMilestone = milestones.find(milestone => milestone.id === target)
  const targetArea = areas.find(area => area.id === targetMilestone?.areaId)
  const targetLabel = targetMilestone?.name || t('project.relations.unassigned')
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="sm:max-w-lg" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onCloseAutoFocus={event => {
      const trigger = document.querySelector<HTMLElement>('[data-project-assignment-trigger]:not(:disabled)') || document.querySelector<HTMLElement>('[data-project-selection-exit]')
      if (trigger) { event.preventDefault(); trigger.focus() }
    }}>
      <DialogHeader>
        <DialogTitle>{t(eventId ? 'project.assignment.saved' : preview ? 'project.assignment.review' : 'project.assignment.title', { count: String(tasks.length) })}</DialogTitle>
        {!eventId && <DialogDescription>{t('project.assignment.description')}</DialogDescription>}
      </DialogHeader>
      <DialogBody className="max-h-[65vh] space-y-4">
        {eventId ? <div className="space-y-3 py-3 text-center" role="status">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Check className="h-5 w-5" /></span>
          <p className="text-sm font-medium">{targetArea ? `${targetArea.name} / ` : ''}{targetLabel}</p>
          {additionalMs > 0 && <p className="text-xs text-muted-foreground">{t('project.assignment.additional', { time: duration(additionalMs) })}</p>}
        </div> : <>
          <details className="group rounded-lg border border-border/60 text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 truncate">{tasks.length === 1 ? tasks[0].title : t('project.assignment.count', { count: String(tasks.length) })}</span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><span>{t('project.assignment.showTasks')}</span><ChevronRight className="h-3 w-3 transition group-open:rotate-90" /></span>
            </summary>
            <ul className="max-h-32 space-y-1 overflow-y-auto border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">{tasks.map(task => <li key={task.id} className="truncate">{task.title}</li>)}</ul>
          </details>
          {!preview ? <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('project.relations.primary')}</p>
            <ProjectSelect className="w-full" triggerClassName="w-full" value={target ?? '__choose__'} label={t('project.relations.choose')} placeholder={t('project.assignment.chooseHint')} searchPlaceholder={t('project.relations.search')} onChange={setTarget} disabled={busy} testId="assignment-milestone-options" options={[
              ...milestones.filter(milestone => !milestone.archived && !areas.find(area => area.id === milestone.areaId)?.archived).map(milestone => ({ value: milestone.id, label: milestone.name, description: areas.find(area => area.id === milestone.areaId)?.name })),
              { value: '', label: t('project.assignment.clear'), description: t('project.assignment.clearHint') },
            ]} />
          </div> : <div className="space-y-4 text-sm">
            <div className="rounded-lg bg-muted/50 px-3 py-3"><p className="text-xs text-muted-foreground">{targetArea?.name || t('project.relations.primary')}</p><p className="mt-1 font-medium">{targetLabel}</p></div>
            <div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('project.assignment.recorded')}</span><span className="text-right tabular-nums">{duration(preview.after.totalMs)}<span className="block text-xs text-muted-foreground">{t('project.assignment.unchanged')}</span></span></div>
            {(preview.historicalStart || preview.historicalEnd) && <div className="flex items-start justify-between gap-4 text-xs text-muted-foreground"><span>{t('project.assignment.history')}</span><span className="text-right">{dateLabel(preview.historicalStart)} — {dateLabel(preview.historicalEnd)}</span></div>}
            <div className="border-t border-border/60 pt-3"><AssignmentChanges before={preview.before} after={preview.after} /></div>
            {preview.before.unassignedMs !== preview.after.unassignedMs && <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">{t('project.assignment.unassignedTime')}</span><span className="tabular-nums">{duration(preview.before.unassignedMs)} → {duration(preview.after.unassignedMs)}</span></div>}
          </div>}
        </>}
        <ErrorMessage>{error}</ErrorMessage>
      </DialogBody>
      <DialogFooter>
        {eventId ? <>
          <button type="button" disabled={busy} className="dialog-button-secondary sm:mr-auto" onClick={() => void run(async () => { await projectApi.undo(eventId); await refreshTask(); onClose() })}>{t('project.assignment.undo')}</button>
          <button type="button" className="dialog-button-primary" onClick={onClose} disabled={busy}>{t('project.assignment.close')}</button>
        </> : <>
          <button type="button" className="dialog-button-secondary" onClick={() => preview ? setPreview(null) : onClose()} disabled={busy}>{t(preview ? 'project.assignment.back' : 'project.assignment.cancel')}</button>
          <button type="button" disabled={busy || target === undefined || !tasks.length} className="dialog-button-primary" onClick={() => void run(async () => {
            if (preview) {
              const result = await projectApi.apply(preview.token)
              setEventId(result.eventId); setAdditionalMs(result.additionalRecordedMs); setPreview(null)
              await refreshTask()
            } else {
              setPreview(await projectApi.preview({ changes: tasks.map(task => ({ taskId: task.id, primaryMilestoneId: target || null, expectedRevision: task.projectRevision })) }))
            }
          })}>{t(busy ? 'project.assignment.busy' : preview ? 'project.assignment.save' : 'project.assignment.preview')}</button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
