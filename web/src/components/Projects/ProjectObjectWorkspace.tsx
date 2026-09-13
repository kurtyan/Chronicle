import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, Check, ChevronRight, Edit3, FileText, Plus } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { useProjectStore } from '@/stores/projectStore'
import { useTaskStore } from '@/stores/taskStore'
import { entityPath, projectApi, projectError } from '@/services/projectApi'
import type { AreaDetail, MilestoneDetail, ProjectTaskSummary, ProjectReferenceRole, WorkStatisticsRange } from '@/services/projectApi'
import type { Note } from '@/types'
import { withProjectNavigation, projectNavigationState } from '@/lib/projectNavigation'
import { ProjectEditor } from './ProjectEditor'
import type { ProjectEditorMode } from './ProjectEditor'
import { ProjectActivityPanel } from './ProjectActivityPanel'
import { ProjectReviews } from './ProjectReviews'
import { AreaSummary } from './AreaSummary'
import { AssignmentDialog } from './AssignmentDialog'
import { MoveAreaDialog, ProjectHistory } from './ProjectManagementActions'
import { NotePickerDialog } from '@/components/NotePickerDialog'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { milestoneSchedule } from './ProjectGantt'
import { button, ErrorMessage, useProjectLabels, useProjectRefresh } from './common'

export interface ProjectObjectTarget { type: 'area' | 'milestone'; id: string; name?: string }
export interface ProjectObjectWorkspaceProps {
  target: ProjectObjectTarget
  range: WorkStatisticsRange
  periodLabel: string
  returnTo: string
  onSelect?: (target: ProjectObjectTarget) => void
  compact?: boolean
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)

/** One selected object, shared by the persistent inspector and expanded view. */
export function ProjectObjectWorkspace({ target, range, periodLabel, returnTo, onSelect, compact = false }: ProjectObjectWorkspaceProps) {
  const { t, locale } = useI18n()
  const { duration, statusLabels, roleLabels, dateLabel } = useProjectLabels()
  const navigate = useNavigate()
  const load = useProjectStore(state => state.load)
  const refresh = useProjectRefresh()
  const scope = JSON.stringify([target.type, target.id, range.start, range.end, range.asOf])
  const [snapshot, setSnapshot] = useState<{ scope: string; data: AreaDetail | MilestoneDetail } | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ProjectEditorMode | null>(null)
  const [creating, setCreating] = useState(false)
  const [moving, setMoving] = useState(false)
  const [notePicker, setNotePicker] = useState(false)
  const [noteRole, setNoteRole] = useState<ProjectReferenceRole>('related')
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [assignmentTasks, setAssignmentTasks] = useState<ProjectTaskSummary[] | null>(null)
  const [completionNotice, setCompletionNotice] = useState(false)
  const reviewsRef = useRef<HTMLDivElement>(null)
  const progressTrigger = useRef<HTMLButtonElement>(null)
  const taskSelectionTrigger = useRef<HTMLButtonElement>(null)
  const context = { returnTo, range, periodLabel }
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    setEditing(null); setCreating(false); setMoving(false); setNotePicker(false); setSelecting(false); setSelectedIds([]); setAssignmentTasks(null); setCompletionNotice(false)
  }, [target.type, target.id])
  useEffect(() => {
    let active = true
    setError('')
    const request = target.type === 'area' ? projectApi.area(target.id, range) : projectApi.milestone(target.id, range)
    request.then(result => { if (active) setSnapshot({ scope, data: result }) }).catch(error => { if (active) setError(projectError(error)) })
    return () => { active = false }
  }, [target.type, target.id, range.start, range.end, range.asOf, refresh, scope])
  // Retain the object and its live editor, but never relabel old statistics as a new period.
  const current = snapshot?.data.id === target.id && (target.type === 'area' ? 'focus' in snapshot.data : 'kind' in snapshot.data) ? snapshot.data : null
  const statisticsReady = snapshot?.scope === scope
  const area = current && 'focus' in current ? current : null
  const milestone = current && 'kind' in current ? current : null
  const openPath = (path: string) => navigate(withProjectNavigation(path, context), { state: projectNavigationState(context) })
  const select = (next: ProjectObjectTarget) => onSelect ? onSelect(next) : openPath(entityPath(next.type, next.id))
  const openTask = (id: string) => { void useTaskStore.getState().setActiveTask(id); openPath(`/?task=${encodeURIComponent(id)}`) }
  const openNote = (id: string) => openPath(`/notes?id=${encodeURIComponent(id)}`)
  const startTask = (milestoneId: string, useNextStep: boolean) => {
    if (!current) return
    if (useTaskStore.getState().draftTask) { setError(t('project.details.existingDraft')); return }
    const text = useNextStep ? current.nextStep.trim() : ''
    useTaskStore.getState().startDraft({
      title: text.split('\n').find(line => line.trim())?.slice(0, 200) || '',
      body: `${text ? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` : ''}<p>${t('project.object.taskSource')}: <a href="${entityPath(target.type, target.id)}">${escapeHtml(current.name)}</a></p>`,
      type: 'TODO', priority: 'MEDIUM', tags: [], dueDate: null, primaryMilestoneId: milestoneId,
      projectReferences: area ? [{ targetType: 'area', targetId: area.id, role: 'related' }] : [],
    })
    void useTaskStore.getState().setActiveTask('__draft__')
    openPath(`/?projectFilter=milestone:${encodeURIComponent(milestoneId)}`)
  }
  const attachNote = async (note: Note) => {
    try {
      const references = await projectApi.references('note', note.id)
      await projectApi.setReferences('note', note.id, references.projectRevision, [...references.references.filter(reference => !(reference.targetType === target.type && reference.targetId === target.id)), { targetType: target.type, targetId: target.id, role: noteRole }])
    } catch (error) { setError(projectError(error)); throw error }
  }
  const finishEditing = () => { setEditing(null); requestAnimationFrame(() => progressTrigger.current?.focus()) }
  if (!current) return <div className="p-5"><ErrorMessage>{error}</ErrorMessage>{!error && <p role="status" className="text-sm text-muted-foreground">{t('project.details.loading')}</p>}</div>
  const time = area ? current.statistics.byArea.find(group => group.id === area.id)?.totalMs || 0 : milestone!.periodMs
  const progressEvent = current.events.find(event => {
    const before = event.before as { latestProgress?: string; nextStep?: string } | null
    const after = event.after as { latestProgress?: string; nextStep?: string } | null
    return after && (after.latestProgress || after.nextStep) && (after.latestProgress !== before?.latestProgress || after.nextStep !== before?.nextStep)
  })
  const progressUpdatedAt = area?.summaryUpdatedAt || progressEvent?.createdAt
  const completed = !!milestone && milestone.kind === 'stage' && ['completed', 'cancelled'].includes(milestone.status)
  const relatedTasks = current.backlinks.tasks.filter(link => !milestone?.tasks.some(task => task.id === link.sourceId))
  const actionClass = 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
  return <article data-testid="project-object-workspace" data-project-object={target.id} className={`min-w-0 space-y-6 ${compact ? 'px-5 py-4' : 'mx-auto w-full max-w-[1600px] px-[30px] py-5'}`}>
    <header className="max-w-3xl space-y-3">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        {milestone ? <button className="truncate hover:text-foreground" onClick={() => select({ type: 'area', id: milestone.areaId, name: milestone.areaName })}>{milestone.areaName} / {t('project.details.milestone')}</button> : <span>{t('project.details.area')}</span>}
        <span className="shrink-0">{statusLabels[current.status]}{current.archived ? ` · ${t('project.relations.archived')}` : ''}</span>
      </div>
      <h1 className="break-words text-xl font-semibold tracking-tight">{current.name}</h1>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{milestone ? milestone.goal || t('project.details.noGoal') : area!.focus || area!.description || t('project.details.noFocus')}</p>
      {milestone && <div className="flex flex-wrap items-center justify-between gap-2">
        <button className={actionClass} aria-label={t('project.object.editor.schedule')} onClick={() => setEditing('schedule')}><CalendarDays className="h-3.5 w-3.5" />{milestoneSchedule(milestone, locale)}</button>
        {milestone.kind === 'stage' && !completed && !milestone.archived && <button className={`${actionClass} text-primary`} onClick={() => setEditing('complete')}><Check className="h-3.5 w-3.5" />{t('project.object.complete')}</button>}
      </div>}
      {milestone?.completionCriteria && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t(milestone.kind === 'stage' ? 'project.editor.criteria' : 'project.editor.observationCriteria')}</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{milestone.completionCriteria}</p></details>}
    </header>
    <ErrorMessage>{error}</ErrorMessage>
    {(completionNotice || milestone?.reviewStatus === 'pending') && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs" role="status"><span>{t(milestone?.status === 'cancelled' ? 'project.object.cancelledReviewPrompt' : 'project.object.completeReviewPrompt')}</span><button className={`${actionClass} text-primary`} onClick={() => { reviewsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); reviewsRef.current?.querySelector<HTMLButtonElement>('[data-project-review-create]')?.focus() }}>{t('project.object.reviewNow')}<ArrowRight className="h-3 w-3" /></button></div>}
    <section className="space-y-3" data-testid="project-object-progress">
      <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">{t('project.object.progressHeading')}</h2>{editing !== 'progress' && <button ref={progressTrigger} className={actionClass} onClick={() => setEditing('progress')}><Edit3 className="h-3 w-3" />{t('project.object.updateProgress')}</button>}</div>
      {editing === 'progress' ? <ProjectEditor key={`${target.id}:progress`} type={target.type} value={current} mode="progress" inline onClose={finishEditing} onSaved={finishEditing} /> : <>
        <div className={`grid gap-4 ${compact ? '' : 'md:grid-cols-2'}`}><div><p className="text-xs text-muted-foreground">{t('project.editor.progress')}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{current.latestProgress || t('project.object.noManualProgress')}</p></div><div><p className="text-xs text-muted-foreground">{t('project.editor.nextStep')}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{current.nextStep || t('project.summary.noNextStep')}</p></div></div>
        {milestone?.blockers && <p className="whitespace-pre-wrap text-xs leading-relaxed text-amber-700 dark:text-amber-400">{t('project.editor.blockers')}: {milestone.blockers}</p>}
        {progressUpdatedAt && <p className="text-[11px] text-muted-foreground">{t('project.object.progressUpdated', { date: dateLabel(progressUpdatedAt) })}</p>}
        {current.nextStep.trim() && !current.archived && <div className="flex flex-wrap items-center gap-2">
          {milestone ? <button className={`${actionClass} bg-primary/5 text-primary`} onClick={() => startTask(milestone.id, true)}><Plus className="h-3 w-3" />{t('project.object.planNext')}</button> : <ProjectSelect compact label={t('project.object.planInMilestone')} value="" onChange={id => startTask(id, true)} options={area!.milestones.filter(milestone => !milestone.archived).map(milestone => ({ value: milestone.id, label: milestone.name }))} />}
          {milestone && !!milestone.tasks.length && <ProjectSelect compact label={t('project.object.openExistingTask')} value="" onChange={openTask} options={milestone.tasks.map(task => ({ value: task.id, label: task.title, description: statusLabels[task.status] }))} />}
        </div>}
      </>}
      {area && <AreaSummary area={area} compact actionsOnly navigationContext={context} />}
    </section>
    <div className={compact ? 'space-y-6' : 'grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]'}>
    <div className="min-w-0 space-y-6">
    <section className="space-y-3 border-t border-border/60 pt-5" data-testid="project-object-effort" aria-busy={!statisticsReady}>
      <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-medium">{t('project.object.effortHeading', { period: periodLabel })}</h2><span className="text-lg font-semibold tabular-nums">{statisticsReady ? duration(time) : '—'}</span></div>
      {statisticsReady ? <ProjectActivityPanel targetType={target.type} targetId={target.id} statistics={current.statistics} range={range} onOpenTask={openTask} onOpenNote={openNote} /> : <p role="status" className="text-xs text-muted-foreground">{t('project.details.loading')}</p>}
    </section>
    {area && <section className="space-y-3 border-t border-border/60 pt-5"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">{t('project.details.milestonesHeading')} <span className="ml-1 text-xs font-normal text-muted-foreground">{area.milestones.length}</span></h2><button className={actionClass} disabled={area.archived} onClick={() => setCreating(true)}><Plus className="h-3 w-3" />{t('project.details.newMilestone')}</button></div><div className="divide-y divide-border/50">{area.milestones.map(milestone => <button key={milestone.id} className="flex w-full items-center gap-3 rounded-md py-2.5 text-left hover:bg-muted/40" onClick={() => select({ type: 'milestone', id: milestone.id, name: milestone.name })}><span className="min-w-0 flex-1"><span className="block truncate text-sm">{milestone.name}</span><span className="mt-1 block text-xs text-muted-foreground">{statusLabels[milestone.status]}</span></span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{statisticsReady ? duration(milestone.periodMs) : '—'}</span><ChevronRight className="h-3 w-3 text-muted-foreground" /></button>)}</div></section>}
    {milestone && <section className="space-y-3 border-t border-border/60 pt-5" data-testid="project-object-tasks" onKeyDown={event => { if (selecting && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setSelecting(false); setSelectedIds([]); requestAnimationFrame(() => taskSelectionTrigger.current?.focus()) } }}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{t('project.details.primaryTasks')} <span className="ml-1 font-normal text-muted-foreground">{milestone.tasks.length}</span></h2><div className="flex gap-1"><button ref={taskSelectionTrigger} className={actionClass} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelectedIds([]) }}>{t(selecting ? 'project.object.doneSelecting' : 'project.bulk.select')}</button><button className={actionClass} disabled={milestone.archived} onClick={() => startTask(milestone.id, false)}><Plus className="h-3 w-3" />{t('project.details.newTask')}</button></div></div>
      {selecting && <div role="toolbar" className="flex flex-wrap items-center gap-2 rounded bg-muted/50 p-2 text-xs"><span>{t('project.bulk.selected', { count: String(selectedIds.length) })}</span><button className="text-muted-foreground" onClick={() => setSelectedIds(milestone.tasks.map(task => task.id))}>{t('project.bulk.all')}</button><button className="text-muted-foreground" onClick={() => setSelectedIds([])}>{t('project.bulk.clear')}</button><button className="ml-auto text-primary disabled:opacity-40" disabled={!selectedIds.length} onClick={() => setAssignmentTasks(milestone.tasks.filter(task => selectedIds.includes(task.id)))}>{t('project.bulk.assign')}</button></div>}
      <div className="divide-y divide-border/50">{milestone.tasks.map(task => <button key={task.id} type="button" role={selecting ? 'checkbox' : undefined} aria-checked={selecting ? selectedIds.includes(task.id) : undefined} aria-label={selecting ? t('project.bulk.selectTask', { name: task.title }) : undefined} className="flex w-full items-center gap-2 rounded-md py-2.5 text-left hover:bg-muted/40" onClick={() => selecting ? setSelectedIds(ids => ids.includes(task.id) ? ids.filter(id => id !== task.id) : [...ids, task.id]) : openTask(task.id)}>{selecting && <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selectedIds.includes(task.id) ? 'bg-primary text-primary-foreground' : 'border-border'}`}>{selectedIds.includes(task.id) && <Check className="h-3 w-3" />}</span>}<span className="min-w-0 flex-1 truncate text-sm">{task.title}</span><span className="shrink-0 text-xs text-muted-foreground">{statusLabels[task.status]}</span></button>)}</div>
      {!milestone.tasks.length && <p className="text-xs text-muted-foreground">{t('project.details.noTasks')}</p>}
      <button className={actionClass} onClick={() => openPath(`/?projectFilter=milestone:${encodeURIComponent(milestone.id)}`)}>{t('project.details.filterBoard')}<ArrowRight className="h-3 w-3" /></button>
    </section>}
    </div>
    <div className="min-w-0 space-y-6">
    <section className="space-y-3 border-t border-border/60 pt-5" data-testid="project-object-notes"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{t('project.details.linkedNotes')} <span className="ml-1 font-normal text-muted-foreground">{current.backlinks.notes.length}</span></h2><div className="flex items-center gap-1"><ProjectSelect compact label={t('project.details.noteRole')} value={noteRole} onChange={value => setNoteRole(value as ProjectReferenceRole)} options={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))} /><button className={actionClass} onClick={() => setNotePicker(true)}><Plus className="h-3 w-3" />{t('project.details.linkNote')}</button></div></div>
      <div className="divide-y divide-border/50">{current.backlinks.notes.map(note => <button className="flex w-full items-start gap-2 rounded py-2.5 text-left hover:bg-muted/40" key={note.sourceId} onClick={() => openNote(note.sourceId)}><FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{note.title || t('project.details.untitledNote')}</span><span className="mt-1 block text-xs text-muted-foreground">{note.roles.map(role => roleLabels[role]).join(' · ')}</span></span><ArrowRight className="mt-1 h-3 w-3 text-muted-foreground" /></button>)}</div>
      {!current.backlinks.notes.length && <p className="text-xs text-muted-foreground">{t('project.object.noNotes')}</p>}
      <button className={actionClass} onClick={() => openPath(`/notes?projectFilter=${encodeURIComponent(`${target.type}:${target.id}`)}`)}>{t('project.details.viewNotes')}<ArrowRight className="h-3 w-3" /></button>
    </section>
    <div ref={reviewsRef} data-project-review-section><ProjectReviews targetType={target.type} targetId={target.id} targetName={current.name} completed={completed} periodStart={range.start} periodEnd={range.end} returnTo={returnTo} periodLabel={periodLabel} /></div>
    <details className="border-t border-border/60 pt-4"><summary className="cursor-pointer text-xs text-muted-foreground">{t('project.object.propertiesHistory')}</summary><div className="mt-4 space-y-4"><div className="flex flex-wrap gap-2"><button className={button} onClick={() => setEditing('properties')}>{t('project.object.editProperties')}</button>{milestone && <button className={button} onClick={() => setMoving(true)}>{t('project.details.moveArea')}</button>}</div>{!!relatedTasks.length && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('project.details.referencedTasks')}</summary>{relatedTasks.map(task => <button key={task.sourceId} className="mt-2 block text-left text-sm hover:text-primary" onClick={() => openTask(task.sourceId)}>{task.title}</button>)}</details>}<ProjectHistory events={current.events} /></div></details>
    </div>
    </div>
    {editing && editing !== 'progress' && <ProjectEditor key={`${target.id}:${editing}`} mode={editing} type={target.type} value={current} onClose={() => setEditing(null)} onSaved={() => { if (editing === 'complete') setCompletionNotice(true); setEditing(null) }} />}
    {creating && area && <ProjectEditor type="milestone" areaId={area.id} onClose={() => setCreating(false)} onSaved={id => { setCreating(false); select({ type: 'milestone', id }) }} />}
    {moving && milestone && <MoveAreaDialog milestone={milestone} onClose={() => setMoving(false)} />}
    {assignmentTasks && <AssignmentDialog tasks={assignmentTasks} onClose={() => setAssignmentTasks(null)} />}
    <NotePickerDialog open={notePicker} onOpenChange={setNotePicker} defaultTitle={`${current.name} · ${roleLabels[noteRole]}`} onPick={attachNote} />
  </article>
}
