import { useState } from 'react'
import { useI18n } from '@/i18n/context'
import { useProjectStore } from '@/stores/projectStore'
import { useTaskStore } from '@/stores/taskStore'
import { projectApi, projectError } from '@/services/projectApi'
import type { MilestoneDetail, AssignmentPreview, ProjectEvent } from '@/services/projectApi'
import { refreshTaskProjectMetadata } from '@/lib/projectTaskRefresh'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { AssignmentChanges } from './AssignmentDialog'
import { button, primaryButton, ErrorMessage, useProjectLabels } from './common'

export function ProjectHistory({ events }: { events: ProjectEvent[] }) {
  const { t } = useI18n()
  const { dateLabel } = useProjectLabels()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const milestones = useProjectStore(s => s.milestones)
  const tasks = useTaskStore(s => s.tasks)
  const milestoneName = (id: string | null) => id ? milestones.find(m => m.id === id)?.name || id : t('project.details.unassigned')
  const undo = async (event: ProjectEvent) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await projectApi.undo(event.id)
      setConfirming(null); setNotice(t('project.details.undoSuccess'))
      await refreshTaskProjectMetadata(result.affectedTaskIds)
    } catch (err) { setError(projectError(err)) } finally { setBusy(false) }
  }
  type TaskState = { id: string; primary_milestone_id: string | null }
  return <details className="border-t border-border/60 pt-5"><summary className="cursor-pointer text-sm font-semibold">{t('project.details.historyTitle', { count: String(events.length) })}</summary>
    <p className="mt-3 text-xs text-muted-foreground">{t('project.details.historyHint')}</p>
    <div className="mt-3 max-h-80 space-y-2 overflow-auto">{events.map(e => {
      const before = e.targetType === 'task_assignment' && Array.isArray(e.before) ? e.before as TaskState[] : []
      const after = e.targetType === 'task_assignment' && Array.isArray(e.after) ? e.after as TaskState[] : []
      const ids = [...new Set([...before, ...after].map(t => t.id))]
      const label = e.targetType === 'task_assignment' ? `${e.kind === 'assignment_undone' ? t('project.details.taskAssignmentUndone') : t('project.details.taskAssignment')} · ${t('project.details.tasksCount', { count: String(ids.length) })}` : ({ created: t('project.details.created'), updated: t('project.details.updated'), assignment: t('project.details.areaAssignment'), assignment_undone: t('project.details.areaAssignmentUndone') } as Record<string, string>)[e.kind] || e.kind
      return <details className="rounded border p-2 text-xs" key={e.id}><summary>{dateLabel(e.createdAt)} · {label}{e.undoneAt ? t('project.details.undone') : ''}</summary>
        {!!ids.length && <div className="my-3 space-y-2">{ids.map(id => <p key={id}>{tasks.find(t => t.id === id)?.title || id}: {milestoneName(before.find(t => t.id === id)?.primary_milestone_id ?? null)} → {milestoneName(after.find(t => t.id === id)?.primary_milestone_id ?? null)}</p>)}{ids.length > 1 && <p className="font-medium">{t('project.details.batchHint', { count: String(ids.length) })}</p>}</div>}
        <details className="my-2"><summary>{t('project.details.rawChanges')}</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre></details>
        {!e.undoneAt && e.kind === 'assignment' && (confirming === e.id ? <div className="space-y-2"><p>{t('project.details.confirmUndoQuestion', { count: String(ids.length) })}</p><div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => void undo(e)}>{t('project.details.confirmUndo')}</button><button disabled={busy} className={button} onClick={() => setConfirming(null)}>{t('project.details.cancel')}</button></div></div> : <button disabled={busy} className={button} onClick={() => ids.length > 1 ? setConfirming(e.id) : void undo(e)}>{ids.length > 1 ? t('project.details.undoBatchCount', { count: String(ids.length) }) : t('project.details.undoBatch')}</button>)}
      </details>
    })}</div>{notice && <p className="mt-3 text-sm" role="status">{notice}</p>}<ErrorMessage>{error}</ErrorMessage></details>
}

export function MoveAreaDialog({ milestone, onClose }: { milestone: MilestoneDetail; onClose: () => void }) {
  const { t } = useI18n()
  const { duration } = useProjectLabels()
  const areas = useProjectStore(s => s.areas)
  const [areaId, setAreaId] = useState(milestone.areaId)
  const [preview, setPreview] = useState<AssignmentPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [eventId, setEventId] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError(projectError(e)); setPreview(null) } finally { setBusy(false) } }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }}><DialogHeader><DialogTitle>{t('project.details.moveTitle')}</DialogTitle></DialogHeader><DialogBody className="space-y-4"><p className="text-sm">{t('project.details.moveHint')}</p><ProjectSelect className="w-full" label={t('project.details.newArea')} disabled={busy || !!eventId} value={areaId} onChange={value => { setAreaId(value); setPreview(null) }} options={areas.filter(a => !a.archived || a.id === milestone.areaId).map(a => ({ value: a.id, label: a.name }))} />{preview && <div className="text-sm"><p>{t('project.details.moveImpact', { count: String(preview.affectedTaskIds.length), before: duration(preview.before.totalMs), after: duration(preview.after.totalMs) })}</p><AssignmentChanges before={preview.before} after={preview.after} /></div>}{eventId && <p role="status">{t('project.details.areaUpdated')}</p>}<ErrorMessage>{error}</ErrorMessage></DialogBody><DialogFooter><button className={button} disabled={busy} onClick={onClose}>{t('project.details.close')}</button>{eventId ? <button className={button} disabled={busy} onClick={() => void run(async () => { await projectApi.undo(eventId); onClose() })}>{t('project.details.undo')}</button> : preview ? <button className={primaryButton} disabled={busy} onClick={() => void run(async () => { const result = await projectApi.apply(preview.token); setEventId(result.eventId); setPreview(null) })}>{t('project.details.saveAssignment')}</button> : <button className={primaryButton} disabled={busy || areaId === milestone.areaId} onClick={() => void run(async () => { setPreview(await projectApi.preview({ milestoneId: milestone.id, areaId, expectedRevision: milestone.revision })) })}>{t('project.details.previewImpact')}</button>}</DialogFooter></DialogContent></Dialog>
}
