import { useState } from 'react'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EntityReferenceChip, EntityReferencePicker } from './EntityReferencePicker'
import { projectApi, projectError } from '@/services/projectApi'
import type { AssignmentPreview, ProjectTaskSummary, WorkStatistics } from '@/services/projectApi'
import { refreshTaskProjectMetadata } from '@/lib/projectTaskRefresh'
import { button, primaryButton, ErrorMessage, duration, dateLabel } from './common'

export function AssignmentChanges({ before, after }: { before: WorkStatistics; after: WorkStatistics }) {
  return <div className="space-y-2">{(['byArea', 'byMilestone'] as const).map(kind => {
    const ids = [...new Set([...before[kind], ...after[kind]].map(g => g.id))]
    const changed = ids.filter(id => (before[kind].find(g => g.id === id)?.totalMs || 0) !== (after[kind].find(g => g.id === id)?.totalMs || 0))
    return changed.length ? <div key={kind}><p className="font-medium">{kind === 'byArea' ? '方向投入变化' : '里程碑投入变化'}</p>{changed.map(id => { const a = before[kind].find(g => g.id === id); const b = after[kind].find(g => g.id === id); return <p key={id}>{b?.name || a?.name}：{duration(a?.totalMs || 0)} → {duration(b?.totalMs || 0)}</p> })}</div> : null
  })}</div>
}

export function AssignmentDialog({ tasks, onClose, onApplied }: { tasks: ProjectTaskSummary[]; onClose: () => void; onApplied?: () => void }) {
  const [target, setTarget] = useState<string | null>(tasks.length === 1 ? tasks[0].primaryMilestoneId : null)
  const [preview, setPreview] = useState<AssignmentPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [eventId, setEventId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError(projectError(e)); setPreview(null) } finally { setBusy(false) } }
  const refreshTask = async () => { await refreshTaskProjectMetadata(tasks.map(task => task.id)); onApplied?.() }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent><DialogHeader><DialogTitle>调整 {tasks.length} 个任务的主归属</DialogTitle></DialogHeader><DialogBody className="space-y-4">
    <p className="text-sm text-muted-foreground">历史日志和已记录投入将整体归入新里程碑。相关引用不会分配工时。</p>
    <div className="max-h-28 overflow-y-auto text-sm">{tasks.map(task => <div key={task.id}>{task.title}</div>)}</div>
    {!eventId && <div className="flex flex-wrap items-center gap-2">{target ? <EntityReferenceChip targetType="milestone" targetId={target} onRemove={() => { setTarget(null); setPreview(null) }} /> : <span className="text-sm">未归属</span>}<EntityReferencePicker disabled={busy} milestoneOnly label="选择主里程碑" onSelect={r => { setTarget(r.targetId); setPreview(null) }} /></div>}
    {preview && <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-2"><p>涉及 {preview.affectedTaskIds.length} 个任务；历史范围 {dateLabel(preview.historicalStart)} — {dateLabel(preview.historicalEnd)}</p><p>已记录总投入 {duration(preview.before.totalMs)} → {duration(preview.after.totalMs)}（总量不变）</p><p>未归属投入 {duration(preview.before.unassignedMs)} → {duration(preview.after.unassignedMs)}</p><AssignmentChanges before={preview.before} after={preview.after} /></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}<ErrorMessage>{error}</ErrorMessage>
  </DialogBody><DialogFooter><button className={button} onClick={onClose} disabled={busy}>{eventId ? '关闭' : '取消'}</button>{eventId ? <button disabled={busy} className={button} onClick={() => void run(async () => { await projectApi.undo(eventId); setNotice('已撤销归属调整'); setEventId(null); await refreshTask(); onClose() })}>撤销这次调整</button> : preview ? <button disabled={busy} className={primaryButton} onClick={() => void run(async () => { const result = await projectApi.apply(preview.token); setEventId(result.eventId); setNotice(`归属已保存。预览后新增记录 ${duration(result.additionalRecordedMs)}。`); setPreview(null); await refreshTask() })}>保存归属</button> : <button disabled={busy} className={primaryButton} onClick={() => void run(async () => { setPreview(await projectApi.preview({ changes: tasks.map(t => ({ taskId: t.id, primaryMilestoneId: target, expectedRevision: t.projectRevision })) })) })}>{busy ? '计算中…' : '预览历史影响'}</button>}</DialogFooter></DialogContent></Dialog>
}
