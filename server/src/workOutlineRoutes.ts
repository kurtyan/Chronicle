import { Hono } from 'hono'
import { OutlineError, getWorkOutline, saveWorkOutline, createTaskInOutline } from './services/workOutlineService'
import { broadcastEvent } from './services/eventBus'

export const workOutlineRoutes = new Hono()
workOutlineRoutes.onError((error, c) => {
  if (error instanceof OutlineError) return c.json({ error: error.message, code: error.code }, error.status as 400)
  if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON', code: 'INVALID_REQUEST' }, 400)
  console.error('Work outline request failed', error)
  return c.json({ error: 'Work outline request failed' }, 500)
})
workOutlineRoutes.get('/work-outlines/default', c => c.json(getWorkOutline()))
workOutlineRoutes.put('/work-outlines/:id', async c => {
  const result = saveWorkOutline(c.req.param('id'), await c.req.json())
  broadcastEvent('outline_updated', { id: result.id, epoch: result.epoch, revision: result.revision }, c.req.header('X-Client-Id'))
  return c.json(result)
})
workOutlineRoutes.post('/work-outlines/:id/rows/:rowId/task', async c => {
  const result = createTaskInOutline(c.req.param('id'), c.req.param('rowId'), await c.req.json())
  broadcastEvent('outline_updated', { id: c.req.param('id'), epoch: result.epoch, revision: result.outlineRevision }, c.req.header('X-Client-Id'))
  broadcastEvent('task_created', result.task, c.req.header('X-Client-Id'))
  return c.json(result, 201)
})
