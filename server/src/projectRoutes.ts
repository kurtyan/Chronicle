import { Hono } from 'hono'
import * as projects from './services/projectService'
import { getReferences, setReferences, getBacklinks } from './services/projectReferenceService'
import { getWorkStatistics } from './services/workStatisticsService'
import * as reviews from './services/projectReviewService'
import * as insights from './services/projectInsightService'
import type { ProjectSourceType, ProjectTargetType, WorkStatisticsRange } from '../../shared/projectTypes'
import { broadcastEvent } from './services/eventBus'
import { getBackgroundTask } from './services/backgroundTaskService'
import { projectActivityRoutes } from './projectActivityRoutes'

async function readBody(c: any, optional = false): Promise<any> {
  const raw = await c.req.text()
  if (optional && !raw.trim()) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Expected an object'), { status: 400 })
  return value
}
function found<T>(value: T | null | undefined): T {
  if (value == null) throw Object.assign(new Error('Not found'), { status: 404 })
  return value
}

function target(value: unknown): ProjectTargetType {
  if (value !== 'area' && value !== 'milestone') throw Object.assign(new Error('Invalid targetType'), { status: 400 })
  return value
}
function source(value: unknown): ProjectSourceType {
  if (value !== 'task' && value !== 'note') throw Object.assign(new Error('Invalid sourceType'), { status: 400 })
  return value
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${name} is required`), { status: 400 })
  return value
}
function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!value.trim() || !Number.isFinite(number)) throw Object.assign(new Error('Invalid numeric query'), { status: 400 })
  return number
}
function range(query: Record<string, string>): WorkStatisticsRange {
  return { start: numeric(query.start), end: numeric(query.end), asOf: numeric(query.asOf) }
}
function listOptions(query: Record<string, string>) {
  return { query: query.query, includeArchived: query.includeArchived === 'true', areaId: query.areaId,
    status: query.status, limit: numeric(query.limit), offset: numeric(query.offset) }
}

export const projectRoutes = new Hono()
projectRoutes.route('/', projectActivityRoutes)
projectRoutes.onError((error: any, c) => {
  const status = [400, 404, 409, 422, 503].includes(error.status) ? error.status
    : /CONFLICT|STALE_|immutable|cannot be deleted/i.test(error.message) ? 409
    : /not found/i.test(error.message) ? 404
    : error instanceof SyntaxError || /invalid|required|requires|must|does not|before confirming|does not match|not available/i.test(error.message) ? 400 : 500
  if (status === 500) console.error('Project request failed', error)
  return c.json({ error: status === 500 ? 'Project operation failed' : error.message, code: error.code }, status)
})
projectRoutes.use('/project-reviews/*', async (c, next) => {
  await next()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.res.status < 300) broadcastEvent('projects_changed', { kind: 'review' })
})
insights.setProjectInsightEventListener(draft => {
  broadcastEvent('projects_changed', { kind: 'insight', id: draft.id })
  broadcastEvent('project_insight_updated', draft)
  if (draft.backgroundTaskId) {
    const task = getBackgroundTask(draft.backgroundTaskId)
    if (task) broadcastEvent('background_task_updated', task)
  }
})

projectRoutes.get('/areas', c => c.json(projects.listAreas(listOptions(c.req.query()))))
projectRoutes.post('/areas', async c => c.json(projects.createArea(await readBody(c)), 201))
projectRoutes.get('/areas/:id', c => c.json(projects.getAreaDetail(c.req.param('id'), range(c.req.query()))))
projectRoutes.patch('/areas/:id', async c => c.json(projects.updateArea(c.req.param('id'), await readBody(c))))
projectRoutes.put('/areas/:id', async c => c.json(projects.updateArea(c.req.param('id'), await readBody(c))))
projectRoutes.post('/areas/:id/summary-from-insight', async c => c.json(projects.applyAreaInsightSummary(c.req.param('id'), await readBody(c))))
projectRoutes.get('/milestones', c => c.json(projects.listMilestones(listOptions(c.req.query()))))
projectRoutes.post('/milestones', async c => c.json(projects.createMilestone(await readBody(c)), 201))
projectRoutes.get('/milestones/:id', c => c.json(projects.getMilestoneDetail(c.req.param('id'), range(c.req.query()))))
projectRoutes.patch('/milestones/:id', async c => c.json(projects.updateMilestone(c.req.param('id'), await readBody(c))))
projectRoutes.put('/milestones/:id', async c => c.json(projects.updateMilestone(c.req.param('id'), await readBody(c))))
projectRoutes.get('/projects/catalog', c => c.json({
  areas: projects.listAreas({ ...listOptions(c.req.query()), limit: 1000 }),
  milestones: projects.listMilestones({ ...listOptions(c.req.query()), limit: 1000 }),
}))
projectRoutes.get('/projects/overview', c => c.json(projects.getProjectOverview(range(c.req.query()), listOptions(c.req.query()))))
projectRoutes.get('/projects/statistics', c => c.json(getWorkStatistics(range(c.req.query()))))
projectRoutes.post('/projects/assignments/preview', async c => c.json(projects.previewAssignment(await readBody(c))))
projectRoutes.post('/projects/assignments/apply', async c => {
  const body = await readBody(c)
  return c.json(projects.applyAssignment(required(body.token, 'token')))
})
projectRoutes.post('/projects/assignments/undo', async c => {
  const body = await readBody(c)
  return c.json(projects.undoAssignment(required(body.eventId, 'eventId')))
})
projectRoutes.get('/project-references', c => c.json(getReferences(source(c.req.query('sourceType')), required(c.req.query('sourceId'), 'sourceId'))))
projectRoutes.put('/project-references', async c => {
  const body = await readBody(c)
  return c.json(setReferences(source(body.sourceType), required(body.sourceId, 'sourceId'), body.references, body.expectedRevision))
})
projectRoutes.get('/project-references/backlinks', c => c.json(getBacklinks(target(c.req.query('targetType')), required(c.req.query('targetId'), 'targetId'))))

projectRoutes.get('/project-reviews', c => c.json(reviews.listProjectReviews(target(c.req.query('targetType')), required(c.req.query('targetId'), 'targetId'))))
projectRoutes.post('/project-reviews', async c => c.json(reviews.createProjectReview(await readBody(c)), 201))
projectRoutes.get('/project-reviews/:id', c => c.json(found(reviews.getProjectReview(c.req.param('id')))))
projectRoutes.patch('/project-reviews/:id', async c => c.json(found(reviews.updateProjectReview(c.req.param('id'), await readBody(c)))))
projectRoutes.post('/project-reviews/:id/confirm', async c => c.json(found(reviews.confirmProjectReview(c.req.param('id'), await readBody(c)))))
projectRoutes.delete('/project-reviews/:id', c => { if (!reviews.deleteProjectReview(c.req.param('id'))) found(null); return c.body(null, 204) })
projectRoutes.get('/project-insights', c => c.json(insights.listProjectInsights(target(c.req.query('targetType')), required(c.req.query('targetId'), 'targetId'))))
projectRoutes.post('/project-insights', async c => c.json(await insights.createProjectInsight(await readBody(c)), 202))
projectRoutes.get('/project-insights/:id', c => c.json(found(insights.getProjectInsight(c.req.param('id')))))
projectRoutes.post('/project-insights/:id/cancel', c => c.json(found(insights.cancelProjectInsight(c.req.param('id')))))
projectRoutes.post('/project-insights/:id/retry', async c => c.json(found(await insights.retryProjectInsight(c.req.param('id'), await readBody(c, true))), 202))
projectRoutes.post('/project-insights/:id/accept', async c => c.json(found(insights.acceptProjectInsight(c.req.param('id'), await readBody(c)))))
