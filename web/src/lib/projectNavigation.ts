import type { WorkStatisticsRange } from '../../../shared/projectTypes'

export interface ProjectNavigationContext {
  returnTo: string
  range: WorkStatisticsRange
  periodLabel: string
}

function projectReturn(value: unknown): string | null {
  return typeof value === 'string' && /^\/projects(?:[/?]|$)/.test(value) && !/[\r\n]/.test(value) ? value : null
}
function timestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 8.64e15 ? number : undefined
}

/** The same context survives browser history, reload, and Task/Note detours. */
export function withProjectNavigation(path: string, context: ProjectNavigationContext): string {
  const [pathname, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  const returnTo = projectReturn(context.returnTo)
  if (returnTo) params.set('projectReturn', returnTo)
  params.set('projectPeriod', context.periodLabel)
  for (const key of ['start', 'end', 'asOf'] as const) {
    const value = timestamp(context.range[key])
    if (value !== undefined) params.set(`project${key[0].toUpperCase()}${key.slice(1)}`, String(value))
  }
  return `${pathname}?${params}`
}

export function projectNavigationState(context: ProjectNavigationContext) {
  return { projectContext: context, returnTo: context.returnTo }
}

export function readProjectNavigation(state: unknown, search = ''): ProjectNavigationContext | null {
  const params = new URLSearchParams(search)
  const candidate = state && typeof state === 'object' ? (state as { projectContext?: Partial<ProjectNavigationContext> }).projectContext : null
  const returnTo = projectReturn(params.get('projectReturn')) || projectReturn(candidate?.returnTo)
  if (!returnTo) return null
  const range: WorkStatisticsRange = {}
  for (const key of ['start', 'end', 'asOf'] as const) {
    const value = timestamp(params.get(`project${key[0].toUpperCase()}${key.slice(1)}`) ?? candidate?.range?.[key])
    if (value !== undefined) range[key] = value
  }
  if (range.start !== undefined && range.end !== undefined && range.end <= range.start) return null
  return { returnTo, range, periodLabel: params.get('projectPeriod') || candidate?.periodLabel || '' }
}
