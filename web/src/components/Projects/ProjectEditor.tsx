import { useEffect, useRef, useState } from 'react'
import { projectApi, projectError } from '@/services/projectApi'
import type { Area, Milestone, MilestoneKind, MilestoneStatus, AreaStatus, MilestoneDetail, AreaDetail } from '@/services/projectApi'
import { useProjectStore } from '@/stores/projectStore'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { button, primaryButton, control, Field, ErrorMessage, statusLabels, dateInputValue } from './common'

export function ProjectEditor({ type, value, areaId, onClose, onSaved }: { type: 'area' | 'milestone'; value?: Area | Milestone | MilestoneDetail | AreaDetail; areaId?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const areas = useProjectStore(s => s.areas)
  // The form and its concurrency revision must refer to the same edit snapshot.
  // Incoming SSE props must not silently acknowledge edits the user never saw.
  const [initialValue] = useState(value)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const milestone = initialValue && 'kind' in initialValue ? initialValue : undefined
  const area = initialValue && 'focus' in initialValue ? initialValue : undefined
  const [name, setName] = useState(value?.name || '')
  const [description, setDescription] = useState(area?.description || '')
  const [focus, setFocus] = useState(area?.focus || '')
  const [selectedArea, setSelectedArea] = useState(milestone?.areaId || areaId || areas.find(a => !a.archived)?.id || '')
  const [kind, setKind] = useState<MilestoneKind>(milestone?.kind || 'stage')
  const [status, setStatus] = useState(value?.status || 'active')
  const [goal, setGoal] = useState(milestone?.goal || '')
  const [criteria, setCriteria] = useState(milestone?.completionCriteria || '')
  const [progress, setProgress] = useState(milestone?.latestProgress || '')
  const [next, setNext] = useState(milestone?.nextStep || '')
  const [blockers, setBlockers] = useState(milestone?.blockers || '')
  const [priority, setPriority] = useState(milestone?.priority || '')
  const [targetDate, setTargetDate] = useState(milestone?.targetDate ? dateInputValue(milestone.targetDate) : '')
  const [startDate, setStartDate] = useState(milestone?.startDate ? dateInputValue(milestone.startDate) : '')
  const [archived, setArchived] = useState(value?.archived || false)
  const [confirmed, setConfirmed] = useState(false)
  const [confirmType, setConfirmType] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isCompleting = type === 'milestone' && status === 'completed' && milestone?.status !== 'completed'
  const kindChanged = !!milestone && kind !== milestone.kind
  const availableStatuses = type === 'area' ? ['active', 'paused', 'ended'] : kind === 'ongoing' ? ['planned', 'active', 'paused', 'ended'] : ['planned', 'active', 'paused', ...(milestone ? ['completed'] : []), 'cancelled']
  async function save() {
    setBusy(true); setError('')
    try {
      if (!name.trim()) throw new Error('请填写名称')
      if (isCompleting && !confirmed) throw new Error('请核对成果后勾选确认完成')
      if (kindChanged && !confirmType) throw new Error('请确认类型调整的影响')
      if (type === 'milestone' && startDate && targetDate && startDate > targetDate) throw new Error('计划开始日期不能晚于目标日期')
      if (type === 'area') {
        const data = { name: name.trim(), description, focus, status: status as AreaStatus }
        const saved = area ? await projectApi.updateArea(area.id, { ...data, expectedRevision: area.revision, archived }) : await projectApi.createArea(data)
        if (mounted.current) onSaved(saved.id)
      } else {
        const data = { name: name.trim(), areaId: selectedArea, kind, goal, completionCriteria: criteria, status: status as MilestoneStatus, latestProgress: progress, nextStep: next, blockers, priority: priority || null, startDate: startDate ? new Date(`${startDate}T00:00:00`).getTime() : null, targetDate: targetDate ? new Date(`${targetDate}T00:00:00`).getTime() : null }
        const saved = milestone ? await projectApi.updateMilestone(milestone.id, { ...data, expectedRevision: milestone.revision, archived, confirmCompletion: confirmed, confirmKindChange: confirmType }) : await projectApi.createMilestone(data)
        if (mounted.current) onSaved(saved.id)
      }
    } catch (e) { setError(projectError(e)) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90vh] sm:max-w-2xl"><DialogHeader><DialogTitle>{value ? '编辑' : '新建'}{type === 'area' ? '方向' : '里程碑'}</DialogTitle></DialogHeader><DialogBody className="space-y-4"><Field label="名称"><input className={control} value={name} autoFocus onChange={e => setName(e.target.value)} /></Field>
    {type === 'area' ? <><Field label="描述 / 关注点"><textarea rows={3} className={control} value={description} onChange={e => setDescription(e.target.value)} /></Field><Field label="当前重点"><textarea rows={2} className={control} value={focus} onChange={e => setFocus(e.target.value)} /></Field></> : <>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="所属方向"><select className={control} value={selectedArea} disabled={!!milestone} onChange={e => setSelectedArea(e.target.value)}><option value="">请选择方向</option>{areas.filter(a => !a.archived || a.id === selectedArea).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="类型"><select className={control} value={kind} onChange={e => { const newKind = e.target.value as MilestoneKind; setKind(newKind); if ((newKind === 'ongoing' && ['completed', 'cancelled'].includes(status)) || (newKind === 'stage' && status === 'ended')) setStatus('paused'); setConfirmType(false) }}><option value="stage">阶段型：有完成条件</option><option value="ongoing">持续型：长期跟踪</option></select></Field></div>
      {milestone && <p className="text-xs text-muted-foreground">调整所属方向请使用详情页的“调整方向”，先预览历史投入变化。</p>}
      <div className="grid gap-3 sm:grid-cols-2"><Field label="计划开始日期（可选）"><input type="date" className={control} value={startDate} onChange={e => setStartDate(e.target.value)} /></Field><Field label="目标日期（可选）"><input type="date" className={control} value={targetDate} min={startDate || undefined} onChange={e => setTargetDate(e.target.value)} /></Field></div>
      <p className="text-xs text-muted-foreground">用于甘特图排期。未填写日期时显示待排期；持续型可以只设开始日期。日期不代表实际投入或自动完成。</p>
      <Field label="目标"><textarea className={control} rows={3} value={goal} onChange={e => setGoal(e.target.value)} /></Field><Field label={kind === 'stage' ? '完成标准' : '阶段观察标准（可选，不计算总体完成率）'}><textarea className={control} rows={2} value={criteria} onChange={e => setCriteria(e.target.value)} /></Field>
      <Field label="优先级"><select className={control} value={priority} onChange={e => setPriority(e.target.value)}><option value="">未设定</option><option value="HIGH">高</option><option value="MEDIUM">中</option><option value="LOW">低</option></select></Field>
      <Field label="最新成果 / 进展"><textarea className={control} rows={2} value={progress} onChange={e => setProgress(e.target.value)} /></Field><Field label="下一步"><textarea className={control} rows={2} value={next} onChange={e => setNext(e.target.value)} /></Field><Field label="阻碍"><textarea className={control} rows={2} value={blockers} onChange={e => setBlockers(e.target.value)} /></Field>
    </>}
    <Field label="状态"><select className={control} value={status} onChange={e => { setStatus(e.target.value as typeof status); setConfirmed(false) }}>{availableStatuses.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></Field>
    {kindChanged && <label className="flex gap-2 rounded border border-amber-400 p-3 text-sm"><input type="checkbox" checked={confirmType} onChange={e => setConfirmType(e.target.checked)} />确认调整类型。已有标准和历史复盘保留，持续型不计算阶段达成。</label>}
    {isCompleting && <div className="space-y-2 rounded-lg border border-primary/40 p-3 text-sm"><p className="font-medium">完成核对</p><p>目标：{goal || '尚未填写'}</p><p>完成标准：{criteria || '尚未填写，请先明确本次完成的依据。'}</p>{value && 'tasks' in value && <p>当前未完成 Task：{value.tasks.filter(t => !['DONE', 'DROPPED'].includes(t.status)).length}。任务状态不会自动改变。</p>}<label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对成果，确认里程碑完成。复盘可以稍后补充。</label></div>}
    {value && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />归档（保留历史投入与引用）</label>}
    {type === 'area' && (archived || status === 'ended' || status === 'paused') && <p className="text-sm text-amber-600">{value && 'milestones' in value ? `当前有 ${value.milestones.filter(m => !m.archived && ['planned', 'active', 'paused'].includes(m.status)).length} 个未结束的下属里程碑。` : ''}下属里程碑和 Task 的状态不会随方向自动改变，历史投入仍保留。</p>}
    <ErrorMessage>{error}</ErrorMessage>
  </DialogBody><DialogFooter><button className={button} disabled={busy} onClick={onClose}>取消</button><button className={primaryButton} disabled={busy || !name.trim() || (type === 'milestone' && !selectedArea)} onClick={() => void save()}>{busy ? '保存中…' : isCompleting ? '确认完成并保存' : '保存'}</button></DialogFooter></DialogContent></Dialog>
}
