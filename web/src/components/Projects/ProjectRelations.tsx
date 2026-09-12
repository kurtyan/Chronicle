import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectApi, projectError } from '@/services/projectApi'
import type { ProjectSourceType, ProjectReferenceInput, ProjectReferencesResult, ProjectReferenceRole } from '@/services/projectApi'
import type { Task } from '@/types'
import { useTaskStore } from '@/stores/taskStore'
import { EntityReferenceChip, EntityReferencePicker } from './EntityReferencePicker'
import { AssignmentDialog } from './AssignmentDialog'
import { button, control, ErrorMessage, roleLabels, useProjectRefresh } from './common'

/** Relationship writes use their own revision and never send Note title or body. */
export function ProjectRelations({ sourceType, sourceId, task }: { sourceType: ProjectSourceType; sourceId: string; task?: Task }) {
  const [data, setData] = useState<ProjectReferencesResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const version = useProjectRefresh()
  const navigate = useNavigate()
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
      catch (refreshError) { setData(null); setError(`${message} 重新加载也未成功：${projectError(refreshError)}`) }
    } finally { setBusy(false) }
  }
  const refs = data?.references || []
  return <div className="space-y-2 rounded-lg border border-border bg-card/60 p-3 text-xs" data-testid="project-relations">
    {task && <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-muted-foreground">主归属</span>{task.primaryMilestoneId ? <EntityReferenceChip targetType="milestone" targetId={task.primaryMilestoneId} /> : <span className="text-muted-foreground">未归属</span>}<button className={button} disabled={busy} onClick={() => setAssigning(true)}>调整归属</button><button className="text-muted-foreground underline" onClick={() => { if (useTaskStore.getState().draftTask) { setError('已有未提交 Task 草稿，请先在 Board 完成或取消。'); return } useTaskStore.getState().startDraft({ title: '', body: `<p>继续任务 <a href="/?task=${encodeURIComponent(task.id)}" data-task-id="${task.id}">${task.title.replace(/[&<>"]/g, '')}</a></p>`, type: task.type, priority: task.priority, tags: [], dueDate: null, primaryMilestoneId: null, projectReferences: [] }); void useTaskStore.getState().setActiveTask('__draft__'); navigate('/') }}>在另一里程碑继续</button></div>}
    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-muted-foreground">相关引用</span>{refs.map((r, i) => <div className="flex max-w-full flex-wrap items-center gap-1" key={r.id}><EntityReferenceChip targetType={r.targetType} targetId={r.targetId} label={r.name} archived={r.archived} onRemove={busy ? undefined : () => void save(refs.filter((_, index) => index !== i))} />{sourceType === 'note' && <select aria-label={`${r.name} 的笔记用途`} disabled={busy} className={`${control} !px-1 !py-1 text-xs`} value={r.role} onChange={e => void save(refs.map((ref, index) => index === i ? { ...ref, role: e.target.value as ProjectReferenceRole } : ref))}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</div>)}<EntityReferencePicker disabled={busy || !data} exclude={refs} onSelect={ref => void save([...refs, ref])} /></div>
    <ErrorMessage>{error}</ErrorMessage>
    {error && <button type="button" className="underline" disabled={busy} onClick={() => setRetryVersion(value => value + 1)}>重新加载关联信息</button>}
    {assigning && task && <AssignmentDialog tasks={[{ ...task, primaryMilestoneId: task.primaryMilestoneId ?? null, projectRevision: data?.projectRevision ?? task.projectRevision ?? 0 }]} onClose={() => setAssigning(false)} />}
  </div>
}
