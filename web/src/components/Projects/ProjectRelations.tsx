import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectApi, projectError } from '@/services/projectApi'
import type { ProjectSourceType, ProjectReferenceInput, ProjectReferencesResult, ProjectReferenceRole } from '@/services/projectApi'
import type { Task } from '@/types'
import { useTaskStore } from '@/stores/taskStore'
import { useI18n } from '@/i18n/context'
import { MoreHorizontal } from 'lucide-react'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { registerShortcut } from '@/shortcuts/registry'
import { EntityReferenceChip, EntityReferencePicker } from './EntityReferencePicker'
import { AssignmentDialog } from './AssignmentDialog'
import { ErrorMessage, useProjectRefresh } from './common'

/** Relationship writes use their own revision and never send Note title or body. */
export function ProjectRelations({ sourceType, sourceId, task }: { sourceType: ProjectSourceType; sourceId: string; task?: Task }) {
  const { t } = useI18n()
  const [data, setData] = useState<ProjectReferencesResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDetailsElement>(null)
  const version = useProjectRefresh()
  const navigate = useNavigate()
  useEffect(() => {
    if (!moreOpen) return
    const close = () => { if (moreRef.current) moreRef.current.open = false }
    const outside = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) close() }
    const unregister = registerShortcut({ id: `project-reference-actions-${sourceType}-${sourceId}`, combo: 'Escape', label: 'Close milestone actions', scope: 'component', context: () => Boolean(moreRef.current?.contains(document.activeElement)), handler: () => { close(); moreRef.current?.querySelector('summary')?.focus() } })
    document.addEventListener('pointerdown', outside, true)
    return () => { unregister(); document.removeEventListener('pointerdown', outside, true) }
  }, [moreOpen, sourceType, sourceId])
  useEffect(() => { let current = true; projectApi.references(sourceType, sourceId).then(result => { if (current) { setData(result); setError('') } }).catch(e => { if (current) { setData(null); setError(projectError(e)) } }); return () => { current = false } }, [sourceType, sourceId, version, retryVersion])
  const save = async (references: ProjectReferenceInput[]) => {
    if (!data || busy) return
    setBusy(true); setError('')
    try {
      setData(await projectApi.setReferences(sourceType, sourceId, data.projectRevision, references))
    } catch (e) {
      const message = projectError(e)
      setError(message)
      // A failed write is never retried automatically. Reload only its revision;
      // a second read failure must remain local and visible as well.
      try { setData(await projectApi.references(sourceType, sourceId)) }
      catch (refreshError) { setData(null); setError(`${message} ${t('project.relations.reloadFailed', { error: projectError(refreshError) })}`) }
    } finally { setBusy(false) }
  }
  const refs = data?.references || []
  return <div className="space-y-2 border-b border-border/50 pb-3 text-xs" data-testid="project-relations">
    {task && <div className="flex flex-wrap items-center gap-2"><span className="w-20 shrink-0 text-muted-foreground">{t('project.relations.primary')}</span>{task.primaryMilestoneId ? <EntityReferenceChip targetType="milestone" targetId={task.primaryMilestoneId} sourceTaskId={task.id} /> : <span className="text-muted-foreground">{t('project.relations.unassigned')}</span>}<button type="button" className="rounded px-2 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" disabled={busy} onClick={() => setAssigning(true)}>{t('project.relations.change')}</button><details ref={moreRef} onToggle={event => setMoreOpen(event.currentTarget.open)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false }} className="relative ml-auto"><summary aria-label={t('project.relations.more')} className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden"><MoreHorizontal className="h-4 w-4" /></summary><div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md"><button type="button" className="w-full rounded px-2 py-2 text-left text-xs hover:bg-muted" onClick={() => { if (moreRef.current) moreRef.current.open = false; if (useTaskStore.getState().draftTask) { setError(t('project.relations.draftExists')); return } useTaskStore.getState().startDraft({ title: '', body: `<p>${t('project.relations.continueTask')} <a href="/?task=${encodeURIComponent(task.id)}" data-task-id="${task.id}">${task.title.replace(/[&<>"]/g, '')}</a></p>`, type: task.type, priority: task.priority, tags: [], dueDate: null, primaryMilestoneId: null, projectReferences: [] }); void useTaskStore.getState().setActiveTask('__draft__'); navigate('/') }}>{t('project.relations.continue')}</button></div></details></div>}
    <div className="flex flex-wrap items-center gap-2"><span className="w-20 shrink-0 text-muted-foreground">{t('project.relations.references')}</span>{refs.map((r, i) => <div className="flex max-w-full flex-wrap items-center gap-1" key={r.id}><EntityReferenceChip targetType={r.targetType} targetId={r.targetId} label={r.name} archived={r.archived} sourceTaskId={sourceType === 'task' ? sourceId : undefined} onRemove={busy ? undefined : () => void save(refs.filter((_, index) => index !== i))} />{sourceType === 'note' && <ProjectSelect compact label={t('project.relations.role', { name: r.name })} disabled={busy} triggerClassName="border-transparent bg-transparent text-muted-foreground" value={r.role} options={(['related', 'outcome', 'review', 'growth'] as const).map(value => ({ value, label: t(`project.relations.role.${value}`) }))} onChange={value => void save(refs.map((ref, index) => index === i ? { ...ref, role: value as ProjectReferenceRole } : ref))} />}</div>)}<EntityReferencePicker disabled={busy || !data} exclude={refs} onSelect={ref => void save([...refs, ref])} /></div>
    <ErrorMessage>{error}</ErrorMessage>
    {error && <button type="button" className="rounded px-2 py-1 text-primary hover:bg-muted" disabled={busy} onClick={() => setRetryVersion(value => value + 1)}>{t('project.relations.retry')}</button>}
    {assigning && task && <AssignmentDialog tasks={[{ ...task, primaryMilestoneId: task.primaryMilestoneId ?? null, projectRevision: data?.projectRevision ?? task.projectRevision ?? 0 }]} onClose={() => setAssigning(false)} />}
  </div>
}
