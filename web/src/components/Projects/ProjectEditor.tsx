import { useEffect, useRef, useState } from 'react'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useI18n } from '@/i18n/context'
import { projectApi, projectError } from '@/services/projectApi'
import type { Area, Milestone, MilestoneKind, MilestoneStatus, AreaStatus, MilestoneDetail, AreaDetail } from '@/services/projectApi'
import { useProjectStore } from '@/stores/projectStore'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { button, primaryButton, control, Field, ErrorMessage, dateInputValue, useProjectLabels } from './common'

export type ProjectEditorMode = 'properties' | 'progress' | 'schedule' | 'complete'
type ProjectValue = Area | Milestone | MilestoneDetail | AreaDetail
interface EditorFields {
  name: string; description: string; focus: string; areaId: string; kind: MilestoneKind; status: string
  goal: string; criteria: string; progress: string; next: string; blockers: string; priority: string
  startDate: string; targetDate: string; archived: boolean
}
interface EditorDraft { values: EditorFields; expectedRevision?: number }
// A null tombstone keeps an explicit discard effective even if storage is unavailable.
const draftMemory = new Map<string, EditorDraft | null>()
function defaults(value: ProjectValue | undefined, areaId: string): EditorDraft {
  const milestone = value && 'kind' in value ? value : undefined
  const area = value && 'focus' in value ? value : undefined
  return { expectedRevision: value?.revision, values: {
    name: value?.name || '', description: area?.description || '', focus: area?.focus || '', areaId: milestone?.areaId || areaId,
    kind: milestone?.kind || 'stage', status: value?.status || 'active', goal: milestone?.goal || '', criteria: milestone?.completionCriteria || '',
    progress: value?.latestProgress || '', next: value?.nextStep || '', blockers: milestone?.blockers || '', priority: milestone?.priority || '',
    startDate: milestone?.startDate ? dateInputValue(milestone.startDate) : '', targetDate: milestone?.targetDate ? dateInputValue(milestone.targetDate) : '', archived: value?.archived || false,
  } }
}
function readDraft(key: string, fallback: EditorDraft): EditorDraft {
  if (draftMemory.has(key)) return draftMemory.get(key) || fallback
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    if (saved?.values && Object.entries(fallback.values).every(([field, value]) => typeof saved.values[field] === typeof value)
      && (saved.expectedRevision === undefined || Number.isInteger(saved.expectedRevision))) return saved
  } catch { /* A local cache cannot prevent project editing. */ }
  return fallback
}
function rememberDraft(key: string, draft: EditorDraft) {
  draftMemory.set(key, draft)
  try { localStorage.setItem(key, JSON.stringify(draft)) } catch { /* Keep a session fallback when local storage is unavailable. */ }
}
function discardDraft(key: string, submitted?: EditorDraft) {
  if (submitted) {
    // Another editor may have opened the same object while this save was in flight.
    // Only retire the snapshot that this request actually saved.
    const latest = draftMemory.get(key)
    if (latest && JSON.stringify(latest) !== JSON.stringify(submitted)) return
  }
  draftMemory.set(key, null)
  try { localStorage.removeItem(key) } catch { /* Session state remains usable. */ }
}

export function ProjectEditor({ type, value, areaId, mode = 'properties', inline = false, onClose, onSaved }: {
  type: 'area' | 'milestone'; value?: ProjectValue; areaId?: string; mode?: ProjectEditorMode; inline?: boolean
  onClose: () => void; onSaved: (id: string) => void
}) {
  const { t } = useI18n()
  const { statusLabels } = useProjectLabels()
  const areas = useProjectStore(state => state.areas)
  const key = `chronicle:project-editor:${type}:${value?.id || `new:${areaId || ''}`}:${mode}`
  const [draft, setDraft] = useState<EditorDraft>(() => readDraft(key, defaults(value, areaId || areas.find(area => !area.archived)?.id || '')))
  const [initialValues] = useState(() => JSON.stringify(defaults(value, areaId || areas.find(area => !area.archived)?.id || '').values))
  const [confirmed, setConfirmed] = useState(false)
  const [confirmKind, setConfirmKind] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const fields = draft.values
  const milestone = value && 'kind' in value ? value : undefined
  const dirty = JSON.stringify(fields) !== initialValues
  const conflict = value && draft.expectedRevision !== value.revision
  const kindChanged = mode === 'properties' && !!milestone && fields.kind !== milestone.kind
  const completing = mode === 'complete' || (type === 'milestone' && fields.status === 'completed' && milestone?.status !== 'completed')
  const availableStatuses = type === 'area' ? ['active', 'paused', 'ended'] : fields.kind === 'ongoing' ? ['planned', 'active', 'paused', 'ended'] : ['planned', 'active', 'paused', ...(milestone?.status === 'completed' ? ['completed'] : []), 'cancelled']
  const change = (changes: Partial<EditorFields>) => {
    const next = { ...draft, values: { ...fields, ...changes } }
    setDraft(next); rememberDraft(key, next)
  }
  const close = () => { if (!busyRef.current) onClose() }
  const save = async () => {
    if (busyRef.current || conflict) return
    const submitted = draft
    busyRef.current = true; setBusy(true); setError('')
    try {
      if (!fields.name.trim()) throw new Error(t('project.editor.nameRequired'))
      if (completing && !confirmed) throw new Error(t('project.editor.confirmRequired'))
      if (kindChanged && !confirmKind) throw new Error(t('project.editor.kindConfirmationRequired'))
      if (mode === 'schedule' && fields.startDate && fields.targetDate && fields.startDate > fields.targetDate) throw new Error(t('project.editor.invalidDates'))
      const revision = { expectedRevision: draft.expectedRevision! }
      let saved: Area | Milestone
      if (type === 'area') {
        const values = mode === 'progress' ? { latestProgress: fields.progress, nextStep: fields.next }
          : { name: fields.name.trim(), description: fields.description, focus: fields.focus, status: fields.status as AreaStatus, archived: fields.archived }
        saved = value ? await projectApi.updateArea(value.id, { ...values, ...revision }) : await projectApi.createArea({ name: fields.name.trim(), ...values })
      } else if (value) {
        const values = mode === 'progress' ? { latestProgress: fields.progress, nextStep: fields.next, blockers: fields.blockers }
          : mode === 'schedule' ? { startDate: fields.startDate ? new Date(`${fields.startDate}T00:00:00`).getTime() : null, targetDate: fields.targetDate ? new Date(`${fields.targetDate}T00:00:00`).getTime() : null }
          : mode === 'complete' ? { status: 'completed' as const, confirmCompletion: confirmed }
          : { name: fields.name.trim(), kind: fields.kind, goal: fields.goal, completionCriteria: fields.criteria, priority: fields.priority || null, status: fields.status as MilestoneStatus, archived: fields.archived, confirmKindChange: confirmKind }
        saved = await projectApi.updateMilestone(value.id, { ...values, ...revision })
      } else {
        saved = await projectApi.createMilestone({ areaId: fields.areaId, name: fields.name.trim(), kind: fields.kind, goal: fields.goal, completionCriteria: fields.criteria, priority: fields.priority || null })
      }
      discardDraft(key, submitted)
      if (mounted.current) onSaved(saved.id)
    } catch (error) { if (mounted.current) setError(projectError(error)) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const title = t(mode === 'properties' ? type === 'area' ? value ? 'project.editor.editArea' : 'project.editor.newArea' : value ? 'project.editor.editMilestone' : 'project.editor.newMilestone' : `project.object.editor.${mode}`)
  const content = <fieldset disabled={busy} className="min-w-0 space-y-4">
    {mode === 'properties' && <>
      <Field label={t('project.editor.name')}><input autoFocus className={control} value={fields.name} onChange={event => change({ name: event.target.value })} /></Field>
      {type === 'area' ? <><Field label={t('project.editor.description')}><textarea rows={3} className={control} value={fields.description} onChange={event => change({ description: event.target.value })} /></Field><Field label={t('project.editor.focus')}><textarea rows={2} className={control} value={fields.focus} onChange={event => change({ focus: event.target.value })} /></Field></> : <>
        {!value && <Field label={t('project.editor.area')}><ProjectSelect className="w-full" label={t('project.editor.area')} value={fields.areaId} onChange={areaId => change({ areaId })} options={areas.filter(area => !area.archived).map(area => ({ value: area.id, label: area.name }))} /></Field>}
        <Field label={t('project.editor.goal')}><textarea className={control} rows={3} value={fields.goal} onChange={event => change({ goal: event.target.value })} /></Field>
        <Field label={fields.kind === 'stage' ? t('project.editor.criteria') : t('project.editor.observationCriteria')}><textarea className={control} rows={2} value={fields.criteria} onChange={event => change({ criteria: event.target.value })} /></Field>
        <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('project.object.moreProperties')}</summary><div className="mt-3 space-y-3">
          <Field label={t('project.editor.kind')}><ProjectSelect className="w-full" label={t('project.editor.kind')} value={fields.kind} onChange={kind => { change({ kind: kind as MilestoneKind, status: (kind === 'ongoing' && ['completed', 'cancelled'].includes(fields.status)) || (kind === 'stage' && fields.status === 'ended') ? 'paused' : fields.status }); setConfirmKind(false) }} options={[{ value: 'stage', label: t('project.editor.stage') }, { value: 'ongoing', label: t('project.editor.ongoing') }]} /></Field>
          <Field label={t('project.editor.priority')}><ProjectSelect className="w-full" label={t('project.editor.priority')} value={fields.priority} onChange={priority => change({ priority })} options={[{ value: '', label: t('project.editor.notSet') }, ...['HIGH', 'MEDIUM', 'LOW'].map(value => ({ value, label: t(`project.editor.${value.toLowerCase()}`) }))]} /></Field>
        </div></details>
      </>}
      {value && <><Field label={t('project.editor.status')}><ProjectSelect className="w-full" label={t('project.editor.status')} value={fields.status} onChange={status => change({ status })} options={availableStatuses.map(status => ({ value: status, label: statusLabels[status] }))} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fields.archived} onChange={event => change({ archived: event.target.checked })} />{t('project.editor.archive')}</label></>}
      {kindChanged && <label className="flex items-start gap-2 rounded border border-amber-400/40 p-3 text-sm"><input type="checkbox" checked={confirmKind} onChange={event => setConfirmKind(event.target.checked)} />{t('project.editor.confirmKind')}</label>}
    </>}
    {mode === 'progress' && <>
      <Field label={t('project.editor.progress')}><textarea autoFocus className={`${control} min-h-24`} value={fields.progress} onChange={event => change({ progress: event.target.value })} /></Field>
      <Field label={t('project.editor.nextStep')}><textarea className={control} rows={3} value={fields.next} onChange={event => change({ next: event.target.value })} /></Field>
      {type === 'milestone' && <details open={!!fields.blockers}><summary className="cursor-pointer text-xs text-muted-foreground">{t('project.editor.blockers')}</summary><textarea aria-label={t('project.editor.blockers')} className={`${control} mt-2 w-full`} value={fields.blockers} onChange={event => change({ blockers: event.target.value })} /></details>}
    </>}
    {mode === 'schedule' && <div className="grid gap-3 sm:grid-cols-2"><Field label={t('project.editor.startDate')}><input autoFocus type="date" className={control} value={fields.startDate} onChange={event => change({ startDate: event.target.value })} /></Field><Field label={t('project.editor.targetDate')}><input type="date" className={control} value={fields.targetDate} min={fields.startDate || undefined} onChange={event => change({ targetDate: event.target.value })} /></Field></div>}
    {mode === 'complete' && <>
      <p className="text-sm font-medium">{value?.name}</p><p className="whitespace-pre-wrap text-sm leading-relaxed">{milestone?.goal || t('project.details.noGoal')}</p>
      <div className="rounded-md bg-muted/50 p-3 text-sm"><p className="mb-1 text-xs font-medium text-muted-foreground">{t('project.editor.criteria')}</p><p className="whitespace-pre-wrap">{milestone?.completionCriteria || t('project.editor.criteriaMissing')}</p></div>
      {value && 'tasks' in value && <div className="text-sm"><p>{t('project.editor.openTasks', { count: String(value.tasks.filter(task => !['DONE', 'DROPPED'].includes(task.status)).length) })}</p><ul className="mt-2 max-h-32 space-y-1 overflow-auto text-xs text-muted-foreground">{value.tasks.filter(task => !['DONE', 'DROPPED'].includes(task.status)).map(task => <li key={task.id}>{task.title}</li>)}</ul></div>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('project.editor.confirmComplete')}</label>
    </>}
    {conflict && <div role="alert" className="space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p>{t('project.object.conflict')}</p><p className="whitespace-pre-wrap text-xs text-muted-foreground">{mode === 'progress' ? `${t('project.editor.progress')}: ${value.latestProgress}\n${t('project.editor.nextStep')}: ${value.nextStep}` : `${value.name} · ${statusLabels[value.status]}`}</p><button type="button" className={button} onClick={() => { const next = { ...draft, expectedRevision: value.revision }; setDraft(next); rememberDraft(key, next); setConfirmed(false) }}>{t('project.object.keepDraftLatest')}</button></div>}
    <ErrorMessage>{error}</ErrorMessage>
    {mode !== 'complete' && <p className="text-xs text-muted-foreground">{t('project.object.draftHint')}</p>}
  </fieldset>
  const footer = <>
    {dirty && <button type="button" className={`${button} sm:mr-auto`} disabled={busy} onClick={() => { discardDraft(key); onClose() }}>{t('project.object.discard')}</button>}
    <button type="button" className={button} disabled={busy} onClick={close}>{t(mode === 'complete' ? 'project.details.cancel' : dirty ? 'project.object.keepClose' : 'project.details.close')}</button>
    <button type="button" className={primaryButton} disabled={busy || !!conflict || !fields.name.trim() || (type === 'milestone' && !value && !fields.areaId) || (completing && !confirmed)} onClick={() => void save()}>{t(busy ? 'project.details.saving' : completing ? 'project.editor.completeAndSave' : 'project.details.save')}</button>
  </>
  if (inline) return <div data-testid="project-inline-editor" className="space-y-4 rounded-lg border border-primary/20 bg-muted/20 p-4" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}><div className="text-sm font-medium">{title}</div>{content}<div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">{footer}</div></div>
  return <Dialog open onOpenChange={open => { if (!open) close() }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} className="max-h-[90vh] sm:max-w-xl"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>{content}</DialogBody><DialogFooter>{footer}</DialogFooter></DialogContent></Dialog>
}
