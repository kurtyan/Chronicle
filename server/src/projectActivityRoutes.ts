import { Hono } from 'hono'
import { getProjectActivity } from './services/projectActivityService'
import type { ProjectActivityQuery } from '../../shared/projectActivityTypes'

export const projectActivityRoutes = new Hono()
projectActivityRoutes.get('/projects/activity', c => {
  const query = c.req.query()
  const number = (key: string) => query[key] === undefined ? undefined : query[key].trim() ? Number(query[key]) : NaN
  return c.json(getProjectActivity({ targetType: query.targetType as ProjectActivityQuery['targetType'], targetId: query.targetId,
    start: number('start'), end: number('end'), asOf: number('asOf'), limit: number('limit'), offset: number('offset') }))
})
