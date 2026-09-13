import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { useI18n } from '@/i18n/context'
import { projectError, projectRequest } from '@/services/projectApi'
import type { ProjectSession, ProjectTargetType, WorkStatistics, WorkStatisticsRange } from '../../../../shared/projectTypes'
import type { ProjectActivityItem, ProjectActivityQuery, ProjectActivityResult } from '../../../../shared/projectActivityTypes'
import { button, ErrorMessage, useProjectLabels, useProjectRefresh } from './common'

export interface ProjectActivityPanelProps {
  targetType: ProjectTargetType
  targetId: string
  statistics: WorkStatistics
  range: WorkStatisticsRange
  onOpenTask: (id: string) => void
  onOpenNote: (id: string) => void
}

function validateActivity(value: unknown, query: ProjectActivityQuery, message: string): ProjectActivityResult {
  const data = value as ProjectActivityResult | null
  const invalid = () => { throw new Error(message) }
  if (!data || data.targetType !== query.targetType || data.targetId !== query.targetId || !data.window ||
    data.window.start !== query.start || data.window.end !== query.end || data.window.asOf !== query.asOf ||
    !Number.isSafeInteger(data.total) || data.total < 0 || data.limit !== query.limit || data.offset !== query.offset ||
    typeof data.hasMore !== 'boolean' || !Array.isArray(data.items) || data.items.length !== Math.min(data.limit, Math.max(0, data.total - data.offset)) ||
    data.hasMore !== (data.offset + data.limit < data.total) ||
    data.nextOffset !== (data.hasMore ? data.offset + data.limit : null)) return invalid()
  const ids = new Set<string>()
  for (const item of data.items) {
    if (!item || !['task_log', 'note'].includes(item.kind) || typeof item.sourceId !== 'string' || !item.sourceId ||
      item.id !== `${item.kind === 'note' ? 'note' : 'entry'}:${item.sourceId}` || ids.has(item.id) ||
      (item.kind === 'task_log' ? typeof item.taskId !== 'string' || !item.taskId : item.taskId !== null) ||
      !['title', 'excerpt', 'contentHtml'].every(key => typeof item[key as keyof ProjectActivityItem] === 'string') ||
      !Number.isSafeInteger(item.occurredAt) || item.occurredAt < data.window.start || item.occurredAt >= Math.min(data.window.end, data.window.asOf) ||
      !['recorded', 'note_updated', 'note_linked'].includes(item.timeMeaning) ||
      !['primary', 'reference', 'task_context'].includes(item.relationship) ||
      !Array.isArray(item.roles) || !item.roles.every(role => ['related', 'outcome', 'review', 'growth'].includes(role)) ||
      !Array.isArray(item.viaTaskIds) || !item.viaTaskIds.every(id => typeof id === 'string') ||
      typeof item.archived !== 'boolean' || typeof item.contentTruncated !== 'boolean') return invalid()
    ids.add(item.id)
  }
  return data
}

export function ProjectActivityPanel({ targetType, targetId, statistics, range, onOpenTask, onOpenNote }: ProjectActivityPanelProps) {
  const { t } = useI18n()
  const { duration, dateLabel, roleLabels } = useProjectLabels()
  const refresh = useProjectRefresh()
  const [retry, setRetry] = useState(0)
  const [showAllTasks, setShowAllTasks] = useState(false)
  const [state, setState] = useState<{ scope: string; data: ProjectActivityResult | null; error: string; loading: boolean } | null>(null)
  const generation = useRef(0)
  const pendingMore = useRef(false)
  // Statistics owns the cutoff for the whole workspace. Pagination always reuses it.
  const start = range.start ?? statistics.start, end = range.end ?? statistics.end, asOf = statistics.asOf
  const query = useMemo(() => ({ targetType, targetId, start, end, asOf, limit: 20, offset: 0 }), [targetType, targetId, start, end, asOf])
  const scope = JSON.stringify(query)
  const current = state?.scope === scope ? state : null
  const load = useCallback(async (request: ProjectActivityQuery) => validateActivity(
    await projectRequest<unknown>('get', '/api/projects/activity', request), request, t('project.activity.invalidResponse')
  ), [t])

  useEffect(() => {
    const requestGeneration = ++generation.current
    pendingMore.current = false
    setState(previous => ({ scope, data: previous?.scope === scope ? previous.data : null, error: '', loading: true }))
    void load(query).then(data => {
      if (generation.current === requestGeneration) setState({ scope, data, error: '', loading: false })
    }).catch(error => {
      if (generation.current === requestGeneration) setState(previous => ({ scope, data: previous?.scope === scope ? previous.data : null, error: projectError(error), loading: false }))
    })
    return () => { ++generation.current }
  }, [load, query, refresh, retry, scope])
  useEffect(() => { setShowAllTasks(false) }, [scope])

  const loadMore = async () => {
    if (pendingMore.current || current?.loading || current?.data?.nextOffset == null) return
    pendingMore.current = true
    const requestGeneration = generation.current
    const offset = current.data.nextOffset
    setState(previous => previous ? { ...previous, loading: true, error: '' } : previous)
    try {
      const page = await load({ ...query, offset })
      if (generation.current !== requestGeneration) return
      setState(previous => {
        if (previous?.scope !== scope || !previous.data) return previous
        // Offset pages can overlap when a source is edited between requests.
        // Only identical source IDs collapse; distinct logs with the same text remain.
        const items = new Map(previous.data.items.map(item => [item.id, item]))
        for (const item of page.items) items.set(item.id, item)
        return { scope, data: { ...page, items: [...items.values()] }, error: '', loading: false }
      })
    } catch (error) {
      if (generation.current === requestGeneration) setState(previous => previous ? { ...previous, error: projectError(error), loading: false } : previous)
    } finally {
      if (generation.current === requestGeneration) pendingMore.current = false
    }
  }

  const contributions = useMemo(() => {
    const names = new Map(statistics.byTask.map(task => [task.id, task.name]))
    const tasks = new Map<string, { id: string; title: string; totalMs: number; sessions: ProjectSession[] }>()
    for (const session of statistics.sessions) {
      if ((targetType === 'area' ? session.areaId : session.milestoneId) !== targetId) continue
      const task = tasks.get(session.taskId) ?? { id: session.taskId, title: names.get(session.taskId) ?? session.taskId, totalMs: 0, sessions: [] }
      task.totalMs += session.durationMs
      task.sessions.push(session)
      tasks.set(task.id, task)
    }
    return [...tasks.values()].sort((a, b) => b.totalMs - a.totalMs || a.id.localeCompare(b.id))
  }, [statistics, targetType, targetId])
  const items = current?.data?.items ?? []

  return <div data-testid="project-activity-panel" className="space-y-5">
    <details open className="border-t pt-4">
      <summary className="cursor-pointer text-sm font-medium">{t('project.activity.effort')}
        <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('project.activity.total', { duration: duration(contributions.reduce((sum, task) => sum + task.totalMs, 0)), count: String(contributions.length) })}</span>
      </summary>
      {!contributions.length && <p className="pt-3 text-sm text-muted-foreground">{t('project.activity.noEffort')}</p>}
      <div className="mt-2 divide-y">
        {(showAllTasks ? contributions : contributions.slice(0, 6)).map(task => <div key={task.id} className="py-3" data-testid="project-activity-contribution">
          <div className="flex items-baseline justify-between gap-3">
            <button type="button" className="min-w-0 break-words text-left text-sm font-medium hover:underline" onClick={() => onOpenTask(task.id)}>{task.title}</button>
            <span className="shrink-0 text-sm tabular-nums">{duration(task.totalMs)}</span>
          </div>
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t('project.activity.sessions', { count: String(task.sessions.length) })}</summary>
            <ol className="mt-2 space-y-2 border-l pl-3">
              {task.sessions.map(session => <li key={session.id} className="space-y-0.5">
                <p>{dateLabel(session.startedAt)} → {session.endedAt == null ? t('project.activity.running') : dateLabel(session.endedAt)}</p>
                <p className="tabular-nums">{duration(session.durationMs)}{(session.clippedStart !== session.startedAt || session.clippedEnd !== session.endedAt) && <> · {t('project.activity.clipped')} ({dateLabel(session.clippedStart)} → {dateLabel(session.clippedEnd)})</>}</p>
                <p className="break-all font-mono text-[10px]">{session.id}</p>
              </li>)}
            </ol>
          </details>
        </div>)}
      </div>
      {contributions.length > 6 && <button type="button" className="mt-2 text-xs text-primary hover:underline" onClick={() => setShowAllTasks(value => !value)}>{t(showAllTasks ? 'project.activity.lessTasks' : 'project.activity.moreTasks', { count: String(contributions.length - 6) })}</button>}
    </details>

    <details open className="border-t pt-4" aria-label={t('project.activity.records')}>
      <summary className="cursor-pointer text-sm font-medium">{t('project.activity.records')}</summary>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('project.activity.meaning')}</p>
      <div className="mt-3 space-y-2">
        <ErrorMessage>{current?.error}</ErrorMessage>
        {current?.error && <button type="button" className={button} disabled={current.loading} onClick={() => setRetry(value => value + 1)}>{t('project.activity.retry')}</button>}
        {(!current || current.loading) && <p role="status" className="text-xs text-muted-foreground">{t('project.activity.loading')}</p>}
        {current?.data && !items.length && !current.loading && <p className="text-sm text-muted-foreground">{t('project.activity.empty')}</p>}
      </div>
      <div className="divide-y">
        {items.map(item => <article key={item.id} data-testid="project-activity-record" className="min-w-0 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t(`project.activity.${item.timeMeaning}`)}</span><time dateTime={new Date(item.occurredAt).toISOString()}>{dateLabel(item.occurredAt)}</time>
            {item.relationship !== 'primary' && <span>{t(`project.activity.${item.relationship}`)}</span>}
            {item.roles.filter(role => role !== 'related').map(role => <span key={role}>{roleLabels[role]}</span>)}
            {item.archived && <span>{t('project.activity.archived')}</span>}
          </div>
          <button type="button" className="mt-1 break-words text-left text-sm font-medium hover:underline" onClick={() => item.kind === 'note' ? onOpenNote(item.sourceId) : onOpenTask(item.taskId!)}>{item.title}</button>
          {item.excerpt && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{item.excerpt}</p>}
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t('project.activity.preview')}</summary>
            <div className="prose-mirror-display mt-2 max-h-80 overflow-auto break-words rounded-md bg-muted/40 p-3 text-sm"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(item.contentHtml, {
                // A readable excerpt has no live media, forms, CSS, or navigation.
                // Open-source buttons above/below preserve the workspace context.
                ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'a', 'figcaption'],
                ALLOWED_ATTR: ['colspan', 'rowspan', 'start'],
              }) }} />
            {item.contentTruncated && <p className="mt-1 text-muted-foreground">{t('project.activity.truncated')}</p>}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="break-all font-mono text-[10px] text-muted-foreground">{item.sourceId}</span>
              <button type="button" className="text-primary hover:underline" onClick={() => item.kind === 'note' ? onOpenNote(item.sourceId) : onOpenTask(item.taskId!)}>{t(item.kind === 'note' ? 'project.activity.openNote' : 'project.activity.openTask')}</button>
            </div>
          </details>
        </article>)}
      </div>
      {current?.data && items.length > 0 && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('project.activity.loaded', { shown: String(items.length), total: String(current.data.total) })}</span>
        {current.data.hasMore && <button type="button" className={button} disabled={current.loading} onClick={() => void loadMore()}>{t('project.activity.more')}</button>}
      </div>}
    </details>
  </div>
}
