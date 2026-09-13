import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { useTaskStore } from '@/stores/taskStore'
import { entityPath } from '@/services/projectApi'
import { fetchStartOfDayOffset } from '@/services/api'
import { getWorkPeriodRange } from '@/lib/workPeriod'
import { readProjectNavigation, withProjectNavigation, projectNavigationState } from '@/lib/projectNavigation'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { ProjectObjectWorkspace } from '@/components/Projects/ProjectObjectWorkspace'

// Reference chips predate the project workspace context. Keep their actual source
// without broadening the shared helper's project-only navigation contract.
function safeReferenceSource(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return null
  try {
    // A fixed parser base also works in the desktop client's custom URL scheme.
    const url = new URL(value, 'https://chronicle.local')
    return url.origin === 'https://chronicle.local' && ['/', '/today', '/notes'].includes(url.pathname) ? url.pathname + url.search + url.hash : null
  } catch { return null }
}

function ProjectDetailPage({ type }: { type: 'area' | 'milestone' }) {
  const { id } = useParams()
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const sourceReturn = safeReferenceSource(new URLSearchParams(location.search).get('projectSourceReturn')) || safeReferenceSource(location.state?.returnTo)
  const candidateTask = new URLSearchParams(location.search).get('projectSourceTask') || location.state?.sourceTaskId
  const sourceTaskId = sourceReturn && ['/', '/today'].includes(sourceReturn.split(/[?#]/)[0]) && typeof candidateTask === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(candidateTask) ? candidateTask : null
  const withReferenceSource = (path: string) => {
    if (!sourceReturn) return path
    const [pathname, search = ''] = path.split('?')
    const params = new URLSearchParams(search)
    params.set('projectSourceReturn', sourceReturn)
    if (sourceTaskId) params.set('projectSourceTask', sourceTaskId)
    return `${pathname}?${params}`
  }
  const [workDayOffset, setWorkDayOffset] = useState(5)
  const [now] = useState(Date.now)
  useEffect(() => { fetchStartOfDayOffset().then(setWorkDayOffset).catch(() => {}) }, [])
  const context = useMemo(() => readProjectNavigation(location.state, location.search) || {
    returnTo: '/projects', range: { ...getWorkPeriodRange('week', new Date(now), workDayOffset), asOf: now }, periodLabel: t('project.details.thisWeek'),
  }, [location.state, location.search, now, workDayOffset, t])
  const changePeriod = (period: string) => {
    const asOf = Date.now()
    const next = { ...context, range: period === 'all' ? { start: 0, end: asOf, asOf } : { ...getWorkPeriodRange(period as 'week' | 'month', new Date(asOf), workDayOffset), asOf }, periodLabel: t(period === 'all' ? 'project.details.allTimeOption' : period === 'month' ? 'project.details.thisMonth' : 'project.details.thisWeek') }
    navigate(withProjectNavigation(withReferenceSource(location.pathname), next), { replace: true, state: projectNavigationState(next) })
  }
  if (!id) return null
  return <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="project-detail-page">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-[30px] py-2.5">
      <button className="flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
        const taskState = useTaskStore.getState()
        if (sourceTaskId && (taskState.activeTaskId !== sourceTaskId || taskState.selectedTask?.id !== sourceTaskId)) void taskState.setActiveTask(sourceTaskId)
        navigate(sourceReturn || context.returnTo)
      }}><ArrowLeft className="h-3.5 w-3.5" />{t('project.details.back')}</button>
      <ProjectSelect compact label={t('project.details.periodInput')} value="current" onChange={changePeriod} options={[{ value: 'current', label: context.periodLabel, disabled: true }, { value: 'week', label: t('project.details.thisWeek') }, { value: 'month', label: t('project.details.thisMonth') }, { value: 'all', label: t('project.details.allTimeOption') }]} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto"><ProjectObjectWorkspace key={`${type}:${id}`} target={{ type, id }} range={context.range} periodLabel={context.periodLabel} returnTo={withProjectNavigation(withReferenceSource(`${location.pathname}${location.search}`), context)} onSelect={target => navigate(withProjectNavigation(withReferenceSource(entityPath(target.type, target.id)), context), { state: projectNavigationState(context) })} /></div>
  </div>
}
export function AreaDetailPage() { return <ProjectDetailPage key="area" type="area" /> }
export function MilestoneDetailPage() { return <ProjectDetailPage key="milestone" type="milestone" /> }
