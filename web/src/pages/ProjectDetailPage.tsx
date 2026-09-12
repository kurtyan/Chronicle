import { fetchStartOfDayOffset } from '@/services/api'
import { getWorkPeriodRange } from '@/lib/workPeriod'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { projectApi, projectError, entityPath } from '@/services/projectApi'
import type { AreaDetail, MilestoneDetail, ProjectBacklinks, ProjectReferenceRole, AssignmentPreview, ProjectEvent } from '@/services/projectApi'
import { useProjectStore } from '@/stores/projectStore'
import { useTaskStore } from '@/stores/taskStore'
import { ProjectEditor } from '@/components/Projects/ProjectEditor'
import { ProjectReviews } from '@/components/Projects/ProjectReviews'
import { AreaSummary } from '@/components/Projects/AreaSummary'
import { ProjectNotesPanel } from '@/components/Projects/ProjectNotesPanel'
import { milestoneSchedule } from '@/components/Projects/ProjectGantt'
import { AssignmentDialog, AssignmentChanges } from '@/components/Projects/AssignmentDialog'
import { NotePickerDialog } from '@/components/NotePickerDialog'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { button, primaryButton, control, ErrorMessage, Empty, duration, statusLabels, roleLabels, dateLabel, useProjectRefresh } from '@/components/Projects/common'
import { MilestoneCard } from './ProjectsPage'
import type { Note } from '@/types'

function Backlinks({ links }: { links: ProjectBacklinks }) {
  const navigate = useNavigate()
  return <div className="space-y-3">{(['tasks', 'notes'] as const).map(kind => <div key={kind}><h3 className="mb-2 text-sm font-semibold">{kind === 'tasks' ? '相关引用 Task（不计入本目标工时）' : '关联笔记（已去重）'}</h3>{!links[kind].length ? <p className="text-sm text-muted-foreground">暂无关联</p> : <div className="space-y-2">{links[kind].map(link => <button className="block w-full rounded-lg border p-3 text-left hover:bg-muted" key={link.sourceId} onClick={() => { if (kind === 'notes') navigate(`/notes?id=${encodeURIComponent(link.sourceId)}`); else { navigate('/'); void useTaskStore.getState().setActiveTask(link.sourceId) } }}><p className="text-sm font-medium">{link.title}</p><p className="mt-1 text-xs text-muted-foreground">{link.roles.map(r => roleLabels[r]).join(' · ')}{link.via.length ? ` · 来源：${link.via.map(v => v.viaTaskId ? `${v.name}（经 Task ${v.viaTaskTitle || v.viaTaskId}）` : v.name).join('、')}` : ''}</p></button>)}</div>}</div>)}</div>
}

function History({ events }: { events: ProjectEvent[] }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const milestones = useProjectStore(s => s.milestones)
  const tasks = useTaskStore(s => s.tasks)
  const milestoneName = (id: string | null) => id ? milestones.find(m => m.id === id)?.name || id : '未归属'
  const undo = async (event: ProjectEvent) => {
    setBusy(true); setError(''); setNotice('')
    try {
      await projectApi.undo(event.id)
      setConfirming(null); setNotice('已撤销整次归属调整，历史投入已恢复。')
      await useTaskStore.getState().loadTodos()
      const active = useTaskStore.getState().activeTaskId
      if (active && active !== '__draft__') await useTaskStore.getState().setActiveTask(active)
    } catch (err) { setError(projectError(err)) } finally { setBusy(false) }
  }
  type TaskState = { id: string; primary_milestone_id: string | null }
  return <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-semibold">变更历史与归属调整（{events.length}）</summary>
    <p className="mt-3 text-xs text-muted-foreground">关闭调整窗口后，仍可在原里程碑或新里程碑的历史中找回并撤销归属调整。后续关系变化会阻止撤销。</p>
    <div className="mt-3 max-h-80 space-y-2 overflow-auto">{events.map(e => {
      const before = e.targetType === 'task_assignment' && Array.isArray(e.before) ? e.before as TaskState[] : []
      const after = e.targetType === 'task_assignment' && Array.isArray(e.after) ? e.after as TaskState[] : []
      const ids = [...new Set([...before, ...after].map(t => t.id))]
      const label = e.targetType === 'task_assignment' ? `${e.kind === 'assignment_undone' ? '已撤销 Task 归属调整' : 'Task 归属调整'} · ${ids.length} 个 Task` : ({ created: '创建', updated: '更新', assignment: '里程碑方向调整', assignment_undone: '已撤销里程碑方向调整' } as Record<string, string>)[e.kind] || e.kind
      return <details className="rounded border p-2 text-xs" key={e.id}><summary>{dateLabel(e.createdAt)} · {label}{e.undoneAt ? ' · 已撤销' : ''}</summary>
        {!!ids.length && <div className="my-3 space-y-2">{ids.map(id => <p key={id}>{tasks.find(t => t.id === id)?.title || id}：{milestoneName(before.find(t => t.id === id)?.primary_milestone_id ?? null)} → {milestoneName(after.find(t => t.id === id)?.primary_milestone_id ?? null)}</p>)}{ids.length > 1 && <p className="font-medium">本次调整涉及 {ids.length} 个 Task。撤销会恢复整个批次，包括其他里程碑中的任务。</p>}</div>}
        <details className="my-2"><summary>查看原始变更</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre></details>
        {!e.undoneAt && e.kind === 'assignment' && (confirming === e.id ? <div className="space-y-2"><p>确认恢复这次调整涉及的全部 {ids.length} 个 Task？</p><div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => void undo(e)}>确认撤销整次调整</button><button disabled={busy} className={button} onClick={() => setConfirming(null)}>取消</button></div></div> : <button disabled={busy} className={button} onClick={() => ids.length > 1 ? setConfirming(e.id) : void undo(e)}>撤销整次调整{ids.length > 1 ? `（${ids.length} 个 Task）` : ''}</button>)}
      </details>
    })}</div>{notice && <p className="mt-3 text-sm" role="status">{notice}</p>}<ErrorMessage>{error}</ErrorMessage></details>
}

function MoveAreaDialog({ milestone, onClose }: { milestone: MilestoneDetail; onClose: () => void }) {
  const areas = useProjectStore(s => s.areas)
  const [areaId, setAreaId] = useState(milestone.areaId)
  const [preview, setPreview] = useState<AssignmentPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [eventId, setEventId] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError(projectError(e)); setPreview(null) } finally { setBusy(false) } }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent><DialogHeader><DialogTitle>调整里程碑所属方向</DialogTitle></DialogHeader><DialogBody className="space-y-4"><p className="text-sm">全部历史投入将随里程碑归入新方向；已确认复盘保留当时的归属快照。</p><select className={`${control} w-full`} aria-label="新的所属方向" disabled={busy || !!eventId} value={areaId} onChange={e => { setAreaId(e.target.value); setPreview(null) }}>{areas.filter(a => !a.archived || a.id === milestone.areaId).map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select>{preview && <div className="text-sm"><p>涉及 {preview.affectedTaskIds.length} 个 Task；全部投入 {duration(preview.before.totalMs)} → {duration(preview.after.totalMs)}。</p><AssignmentChanges before={preview.before} after={preview.after} /></div>}{eventId && <p role="status">所属方向已更新。</p>}<ErrorMessage>{error}</ErrorMessage></DialogBody><DialogFooter><button className={button} disabled={busy} onClick={onClose}>关闭</button>{eventId ? <button className={button} disabled={busy} onClick={() => void run(async () => { await projectApi.undo(eventId); onClose() })}>撤销</button> : preview ? <button className={primaryButton} disabled={busy} onClick={() => void run(async () => { const result = await projectApi.apply(preview.token); setEventId(result.eventId); setPreview(null) })}>保存归属</button> : <button className={primaryButton} disabled={busy || areaId === milestone.areaId} onClick={() => void run(async () => { setPreview(await projectApi.preview({ milestoneId: milestone.id, areaId, expectedRevision: milestone.revision })) })}>预览历史影响</button>}</DialogFooter></DialogContent></Dialog>
}

function ProjectDetailPage({ type }: { type: 'area' | 'milestone' }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [data, setData] = useState<AreaDetail | MilestoneDetail | null>(null)
  const [error, setError] = useState('')
  const [period, setPeriod] = useState<'all' | 'week' | 'month'>('all')
  const [workDayOffset, setWorkDayOffset] = useState(5)
  useEffect(() => { fetchStartOfDayOffset().then(setWorkDayOffset).catch(() => {}) }, [])
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [moving, setMoving] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [notePicker, setNotePicker] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [role, setRole] = useState<ProjectReferenceRole>('related')
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const refresh = useProjectRefresh()
  const load = useProjectStore(s => s.load)
  useEffect(() => { void load() }, [load])
  useEffect(() => { setData(null); setError(''); setEditing(false); setCreating(false); setMoving(false); setAssigning(false); setShowNotes(false); setSelectedTaskIds([]) }, [id, type])
  useEffect(() => { if (!id) return; let active = true; (type === 'area' ? projectApi.area(id, period === 'all' ? {} : getWorkPeriodRange(period, new Date(), workDayOffset)) : projectApi.milestone(id, period === 'all' ? {} : getWorkPeriodRange(period, new Date(), workDayOffset))).then(result => { if (active) { setData(result); setError('') } }).catch(e => { if (active) setError(projectError(e)) }); return () => { active = false } }, [type, id, refresh, period, workDayOffset])
  const milestone = data && 'kind' in data ? data : null
  const area = data && 'focus' in data ? data : null
  const attachNote = async (note: Note) => {
    if (!id) return
    try { const current = await projectApi.references('note', note.id); await projectApi.setReferences('note', note.id, current.projectRevision, [...current.references.filter(r => !(r.targetType === type && r.targetId === id)), { targetType: type, targetId: id, role }]) } catch (e) { setError(projectError(e)); throw e }
  }
  return <div className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl space-y-5"><button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => navigate(location.state?.returnTo || '/projects')}><ArrowLeft className="h-4 w-4" />返回</button><ErrorMessage>{error}</ErrorMessage>{data ? <>
    <header className="flex flex-wrap items-start justify-between gap-3"><div>{milestone && <button className="text-sm text-muted-foreground underline" onClick={() => navigate(entityPath('area', milestone.areaId))}>{milestone.areaName}</button>}<h1 className="mt-1 text-2xl font-bold">{data.name}</h1><p className="mt-1 text-sm text-muted-foreground">{area ? '方向' : milestone?.kind === 'ongoing' ? '持续型里程碑' : '阶段型里程碑'} · {statusLabels[data.status]}{data.archived ? ' · 已归档' : ''}</p></div><div className="flex flex-wrap gap-2"><button className={button} onClick={() => setEditing(true)}>编辑 / 状态</button>{area && <button className={button} disabled={area.archived} onClick={() => setCreating(true)}>新建里程碑</button>}{milestone && <button className={button} onClick={() => setMoving(true)}>调整方向</button>}</div></header>
    <div className="flex flex-wrap items-center gap-3"><button className={button} onClick={() => setShowNotes(true)}>关联 Notes（{data.backlinks.notes.length}）</button><button className={button} onClick={() => navigate(`/notes?projectFilter=${encodeURIComponent(`${type}:${data.id}`)}`)}>在 Notes 中筛选</button>{milestone && <span className="text-sm text-muted-foreground">计划：{milestoneSchedule(milestone)}</span>}</div>
    {area && <AreaSummary area={area} />}
    <section className="rounded-xl border bg-card p-4"><div className="flex flex-wrap justify-between gap-2"><p className="text-xs text-muted-foreground">所选期间已记录投入</p><select aria-label="详情统计期间" className={control} value={period} onChange={e => setPeriod(e.target.value as typeof period)}><option value="all">全部时间</option><option value="week">本周</option><option value="month">本月</option></select></div><p className="my-1 text-2xl font-semibold">{duration(area ? data.statistics.byArea.find(a => a.id === data.id)?.totalMs || 0 : milestone!.periodMs)}</p><p className="mb-2 text-xs text-muted-foreground">累计 {duration(area ? area.milestones.reduce((sum, m) => sum + m.totalMs, 0) : milestone!.totalMs)}</p><p className="text-xs text-muted-foreground">统计截至 {dateLabel(data.statistics.asOf)}，相关引用不重复计时。</p></section>
    {area && <><section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">关注点与当前重点</h2><p className="whitespace-pre-wrap text-sm">{area.description || '尚未填写描述'}</p><p className="whitespace-pre-wrap text-sm text-muted-foreground">{area.focus || '尚未填写当前重点'}</p></section><section className="space-y-3"><h2 className="font-semibold">下属里程碑</h2>{area.milestones.length ? <div className="grid gap-3 sm:grid-cols-2">{area.milestones.map(m => <MilestoneCard key={m.id} milestone={m} />)}</div> : <Empty>此方向尚无里程碑。</Empty>}</section></>}
    {milestone && <><section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">目标与进展</h2><p className="whitespace-pre-wrap text-sm">{milestone.goal || '尚未填写目标'}</p><div className="text-sm"><p className="font-medium">{milestone.kind === 'ongoing' ? '阶段观察标准' : '完成标准'}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{milestone.completionCriteria || '尚未填写'}</p></div>{[['最新成果 / 进展', milestone.latestProgress], ['下一步', milestone.nextStep], ['阻碍', milestone.blockers]].map(([label, text]) => <div key={label} className="text-sm"><p className="font-medium">{label}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{text || '尚未记录'}</p></div>)}<p className="text-xs text-muted-foreground">{milestone.kind === 'ongoing' ? '持续跟踪，通过阶段回顾观察变化，不显示总体完成率。' : `Task 已完成 ${milestone.doneTaskCount}/${milestone.taskCount}，里程碑完成需人工核对。`}{milestone.reviewStatus === 'pending' ? ' 当前已完成，待复盘。' : ''}</p></section>
      <section className="space-y-3 rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">主归属 Task</h2><div className="flex flex-wrap gap-2">{!!selectedTaskIds.length && <button className={button} onClick={() => setAssigning(true)}>调整选中任务归属（{selectedTaskIds.length}）</button>}<button className={button} disabled={milestone.archived} onClick={() => { if (useTaskStore.getState().draftTask) { setError('已有未提交 Task 草稿。请先到 Board 完成或取消，再新建任务。'); return } useTaskStore.getState().startDraft({ title: '', body: '', type: 'TODO', priority: 'MEDIUM', tags: [], dueDate: null, primaryMilestoneId: milestone.id }); void useTaskStore.getState().setActiveTask('__draft__'); navigate('/') }}>新建 Task</button><button className={button} onClick={() => navigate(`/?projectFilter=milestone:${encodeURIComponent(milestone.id)}`)}>在 Board 筛选</button></div></div>{milestone.tasks.length ? milestone.tasks.map(t => <div key={t.id} className="flex items-center gap-3 rounded border p-2"><input aria-label={`选择 ${t.title}`} type="checkbox" checked={selectedTaskIds.includes(t.id)} onChange={e => setSelectedTaskIds(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} /><button className="min-w-0 flex-1 text-left text-sm hover:underline" onClick={() => { navigate('/'); void useTaskStore.getState().setActiveTask(t.id) }}>{t.title}</button><span className="text-xs text-muted-foreground">{statusLabels[t.status] || t.status}</span></div>) : <Empty>尚无主归属 Task。任务可随着推进逐步补充。</Empty>}</section></>}
    <section className="space-y-4 rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">双向引用与笔记</h2><div className="flex flex-wrap gap-2"><select aria-label="笔记关联用途" className={control} value={role} onChange={e => setRole(e.target.value as ProjectReferenceRole)}>{Object.entries(roleLabels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select><button className={button} onClick={() => setNotePicker(true)}>关联 / 新建 Note</button></div></div><Backlinks links={milestone ? { ...data.backlinks, tasks: data.backlinks.tasks.filter(link => !milestone.tasks.some(task => task.id === link.sourceId)) } : data.backlinks} /></section>
    <ProjectReviews key={`${type}:${data.id}`} targetType={type} targetId={data.id} targetName={data.name} completed={milestone?.kind === 'stage' && ['completed', 'cancelled'].includes(milestone.status)} />
    <History events={data.events} />
    {editing && <ProjectEditor type={type} value={data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
    {creating && area && <ProjectEditor type="milestone" areaId={area.id} onClose={() => setCreating(false)} onSaved={newId => { setCreating(false); navigate(entityPath('milestone', newId)) }} />}
    {moving && milestone && <MoveAreaDialog milestone={milestone} onClose={() => setMoving(false)} />}
    {assigning && milestone && <AssignmentDialog tasks={milestone.tasks.filter(t => selectedTaskIds.includes(t.id))} onClose={() => { setAssigning(false); setSelectedTaskIds([]) }} />}
    <NotePickerDialog open={notePicker} onOpenChange={setNotePicker} defaultTitle={`${data.name} · ${roleLabels[role]}`} onPick={attachNote} />
    {showNotes && <ProjectNotesPanel target={{ type, id: data.id, name: data.name }} onClose={() => setShowNotes(false)} />}
  </> : !error && <p className="text-sm text-muted-foreground">加载中…</p>}</div></div>
}
export function AreaDetailPage() { return <ProjectDetailPage key="area" type="area" /> }
export function MilestoneDetailPage() { return <ProjectDetailPage key="milestone" type="milestone" /> }
