import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { AppService } from './services/appService'
import { initDb } from './db'
import { getConfig } from './config'
import { startBackupService } from './services/backupService'
import { exportDatabase, importDatabase, getSettingsInfo } from './services/settingsService'
import fs from 'fs'

const app = new Hono()
const service = new AppService()

app.use('/*', cors())

// --- Task API ---
app.get('/api/tasks', async (c) => {
  const type = c.req.query('type')
  const statusParam = c.req.query('status')
  return c.json(await service.fetchTodos(type, statusParam))
})

app.get('/api/tasks/today', async (c) => {
  return c.json(await service.fetchTodayTasks())
})

app.post('/api/tasks', async (c) => {
  const body = await c.req.json()
  return c.json(await service.createTask(body), 201)
})

app.get('/api/tasks/:id', async (c) => {
  const task = await service.getTaskById(c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)
  return c.json(task)
})

app.put('/api/tasks/:id', async (c) => {
  const body = await c.req.json()
  const task = await service.updateTask(c.req.param('id'), body)
  if (!task) return c.json({ error: 'Not found' }, 404)
  return c.json(task)
})

app.delete('/api/tasks/:id', async (c) => {
  try {
    await service.deleteTask(c.req.param('id'))
    return c.body(null, 204)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

// --- Task Entry API ---
app.get('/api/tasks/:id/logs', async (c) => {
  return c.json(await service.fetchTaskEntries(c.req.param('id')))
})

app.post('/api/tasks/:id/logs', async (c) => {
  const body = await c.req.json()
  return c.json(await service.submitTaskEntry(c.req.param('id'), body.content, body.type ?? 'log'), 201)
})

app.put('/api/tasks/:id/logs/:entryId', async (c) => {
  const body = await c.req.json()
  const entry = await service.updateTaskEntry(c.req.param('id'), c.req.param('entryId'), body.content)
  if (!entry) return c.json({ error: 'Not found' }, 404)
  return c.json(entry)
})

app.put('/api/tasks/:id/done', async (c) => {
  const task = await service.markTaskDone(c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)
  return c.json(task)
})

// --- Work Session API ---
app.post('/api/tasks/:id/takeover', async (c) => {
  return c.json(await service.takeOverTask(c.req.param('id')), 201)
})

app.post('/api/afk', async (c) => {
  await service.doAfk()
  return c.json({ ok: true })
})

app.get('/api/sessions/current', async (c) => {
  return c.json(await service.getCurrentSession())
})

app.get('/api/sessions', async (c) => {
  const start = parseInt(c.req.query('start') || '0')
  const end = parseInt(c.req.query('end') || String(Date.now()))
  return c.json(await service.fetchSessions(start, end))
})

app.post('/api/tasks/:id/drop', async (c) => {
  const body = await c.req.json()
  const task = await service.dropTask(c.req.param('id'), body.reason ?? '')
  if (!task) return c.json({ error: 'Not found' }, 404)
  return c.json(task)
})

// --- Report API ---
app.get('/api/reports/today', async (c) => {
  return c.json(await service.fetchTodayReport())
})

app.get('/api/reports/summary', async (c) => {
  return c.json(await service.fetchSummary())
})

// --- Settings API ---
app.get('/api/settings/export', async (c) => {
  const { data, path: dbPath } = exportDatabase()
  const fileName = dbPath.split('/').pop() ?? 'tasks.db'
  c.header('Content-Disposition', `attachment; filename="${fileName}"`)
  c.header('Content-Type', 'application/octet-stream')
  return c.body(new Uint8Array(data))
})

app.post('/api/settings/import', async (c) => {
  try {
    const formData = await c.req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return c.json({ error: 'No file uploaded' }, 400)
    }

    // Handle both File and Blob types
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const result = await importDatabase(buffer)
    return c.json(result)
  } catch (err: any) {
    return c.json({ error: err.message || 'Import failed' }, 400)
  }
})

app.get('/api/settings/info', async (c) => {
  return c.json(getSettingsInfo())
})

// --- Static files with SPA fallback ---
app.use('/assets/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))
app.get('*', (c) => {
  return c.html(fs.readFileSync('./public/index.html', 'utf-8'))
})

// --- Start ---
const config = getConfig()
const port = config.server.port
const host = config.server.host

initDb()
startBackupService()

serve({ fetch: app.fetch, port, hostname: host })
console.log(`Server running at http://${host}:${port}`)
