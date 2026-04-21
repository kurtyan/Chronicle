import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { AppService } from './services/appService'
import { initDb } from './db'
import { getConfig } from './config'
import { startBackupService } from './services/backupService'
import { exportDatabase, importDatabase, getSettingsInfo } from './services/settingsService'
import { generatePlist, installLaunchd, uninstallLaunchd, isInstalled } from './services/launchdService'
import { getLogger } from './logging'
import { createSSEStream, broadcastEvent } from './services/eventBus'
import fs from 'fs'
import path from 'path'

function findPublicDir(): string {
  // When running from npm global install: cwd is dist/, public is at ../public
  // When running from source: cwd may be server/, public is at ./public
  const candidates = ['./public', '../public']
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) return p
  }
  return './public'
}
const publicDir = findPublicDir()

const app = new Hono()
const service = new AppService()

app.use('/*', cors())

// Extract client ID from header for SSE source tracking
app.use('/*', async (c, next) => {
  c.set('clientId', c.req.header('X-Client-Id') ?? '')
  await next()
})

// --- SSE Events ---
function emitTaskChange(c: any, task: any) {
  if (task) broadcastEvent('task_updated', { id: task.id, status: task.status, title: task.title }, c.get('clientId'))
}

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
  const task = await service.createTask(body)
  broadcastEvent('task_created', { id: task.id }, c.get('clientId'))
  return c.json(task, 201)
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
  emitTaskChange(c, task)
  return c.json(task)
})

app.delete('/api/tasks/:id', async (c) => {
  try {
    await service.deleteTask(c.req.param('id'))
    broadcastEvent('task_deleted', { id: c.req.param('id') }, c.get('clientId'))
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
  const entry = await service.submitTaskEntry(c.req.param('id'), body.content, body.type ?? 'log')
  broadcastEvent('entry_created', { taskId: c.req.param('id'), entryId: entry.id, type: entry.type }, c.get('clientId'))
  return c.json(entry, 201)
})

app.put('/api/tasks/:id/logs/:entryId', async (c) => {
  const body = await c.req.json()
  const entry = await service.updateTaskEntry(c.req.param('id'), c.req.param('entryId'), body.content)
  if (!entry) return c.json({ error: 'Not found' }, 404)
  broadcastEvent('entry_updated', { taskId: c.req.param('id'), entryId: entry.id }, c.get('clientId'))
  return c.json(entry)
})

app.put('/api/tasks/:id/done', async (c) => {
  const task = await service.markTaskDone(c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)
  emitTaskChange(c, task)
  return c.json(task)
})

// --- Work Session API ---
app.post('/api/tasks/:id/takeover', async (c) => {
  const { session, task: changedTask } = await service.takeOverTask(c.req.param('id'))
  if (changedTask) emitTaskChange(c, changedTask)
  broadcastEvent('session_started', { taskId: c.req.param('id'), startedAt: session.startedAt }, c.get('clientId'))
  return c.json(session, 201)
})

app.post('/api/afk', async (c) => {
  await service.doAfk()
  broadcastEvent('session_ended', {}, c.get('clientId'))
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
  emitTaskChange(c, task)
  return c.json(task)
})

// --- Task Extra Info API ---
app.get('/api/tasks/:id/extra-info', async (c) => {
  return c.json(await service.getTaskExtraInfo(c.req.param('id')))
})

app.get('/api/tasks/:id/extra-info/:key', async (c) => {
  const value = await service.getTaskExtraInfoValue(c.req.param('id'), c.req.param('key'))
  return c.json({ value })
})

app.put('/api/tasks/:id/extra-info/:key', async (c) => {
  const body = await c.req.json()
  return c.json(await service.setTaskExtraInfo(c.req.param('id'), c.req.param('key'), body.value ?? ''))
})

app.delete('/api/tasks/:id/extra-info/:key', async (c) => {
  const ok = await service.deleteTaskExtraInfo(c.req.param('id'), c.req.param('key'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// --- AFK Events API ---
app.post('/api/afk-events', async (c) => {
  const body = await c.req.json()
  try {
    const event = await service.createAfkEvent(body.reason, body.triggeredAt ?? Date.now())
    return c.json(event, 201)
  } catch (e: any) {
    return c.json({ error: e.message }, 409)
  }
})

app.put('/api/afk-events/:id', async (c) => {
  const body = await c.req.json()
  const event = await service.updateAfkEvent(c.req.param('id'), body.userNote ?? '')
  if (!event) return c.json({ error: 'Not found' }, 404)
  return c.json(event)
})

app.get('/api/afk-events', async (c) => {
  const start = c.req.query('start') ? parseInt(c.req.query('start')!) : undefined
  const end = c.req.query('end') ? parseInt(c.req.query('end')!) : undefined
  return c.json(await service.getAfkEvents(start, end))
})

// --- Report API ---
app.get('/api/reports/today', async (c) => {
  return c.json(await service.fetchTodayReport())
})

app.get('/api/reports/summary', async (c) => {
  return c.json(await service.fetchSummary())
})

app.get('/api/reports/range-stats', async (c) => {
  const start = parseInt(c.req.query('start') || '0')
  const end = parseInt(c.req.query('end') || String(Date.now()))
  return c.json(await service.fetchRangeStats(start, end))
})

// --- Search API ---
import { searchTasks, rebuildFtsIndex } from './services/searchService'

app.get('/api/search', async (c) => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'q parameter required' }, 400)
  const limit = parseInt(c.req.query('limit') || '50')
  const { results, tokens } = searchTasks(q, Math.min(limit, 200))
  return c.json({ results, tokens, total: results.length })
})

app.post('/api/search/rebuild', async (c) => {
  rebuildFtsIndex()
  return c.json({ ok: true })
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

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const result = await importDatabase(buffer)
    broadcastEvent('db_imported', {}, c.get('clientId'))
    return c.json(result)
  } catch (err: any) {
    return c.json({ error: err.message || 'Import failed' }, 400)
  }
})

app.get('/api/settings/info', async (c) => {
  return c.json(getSettingsInfo())
})

// --- Launchd Management ---
app.get('/api/settings/launchd/status', async (c) => {
  return c.json({ installed: isInstalled() })
})

app.post('/api/settings/launchd/install', async (c) => {
  const ok = installLaunchd()
  return c.json({ ok })
})

app.post('/api/settings/launchd/uninstall', async (c) => {
  const ok = uninstallLaunchd()
  return c.json({ ok })
})

app.get('/api/settings/launchd/plist', async (c) => {
  return c.json({ plist: generatePlist() })
})

// --- SSE Endpoint ---
app.get('/api/events', async (c) => {
  // Explicit CORS headers for SSE (streaming response bypasses global cors() middleware)
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  const stream = createSSEStream(c.req.query('clientId') ?? '')
  return c.newResponse(stream as any)
})

// --- Static files with SPA fallback ---
app.use('/assets/*', async (c, next) => {
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  await next()
}, serveStatic({ root: publicDir }))
app.use('/favicon.ico', serveStatic({ path: path.join(publicDir, 'favicon.ico') }))
app.get('*', (c) => {
  const indexHtml = path.join(publicDir, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    return c.json({ message: 'Chronicle server is running. Build the web frontend with `npm run publish:prepare` or `npm run build` to access the UI.' })
  }
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  return c.html(fs.readFileSync(indexHtml, 'utf-8'))
})

// --- Start ---
const config = getConfig()
const cliPort = (() => {
  const idx = process.argv.indexOf('--port')
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : undefined
})()
const port = cliPort ?? config.server.port
const host = config.server.host

initDb()
import { getMetaValue, setMetaValue } from './db'

// Auto-rebuild FTS index when tokenizer version changes
const FTS_INDEX_VERSION_KEY = 'fts_tokenizer_version'
const CURRENT_TOKENIZER_VERSION = '2' // v1: old (single-letter English), v2: new (full English words + jieba)
const storedVersion = getMetaValue(FTS_INDEX_VERSION_KEY)
if (storedVersion !== CURRENT_TOKENIZER_VERSION) {
  const log = getLogger()
  log.info(`FTS index version mismatch (stored: ${storedVersion}, current: ${CURRENT_TOKENIZER_VERSION}). Rebuilding...`)
  rebuildFtsIndex()
  setMetaValue(FTS_INDEX_VERSION_KEY, CURRENT_TOKENIZER_VERSION)
  log.info('FTS index rebuilt successfully')
}

startBackupService()

serve({ fetch: app.fetch, port, hostname: host })
getLogger().info(`Server running at http://${host}:${port}`)

import { createServer } from 'http'
import { handleMcpRequest } from './mcp/start'

// --- MCP Server ---
if (config.mcp.enabled) {
  const mcpHttpServer = createServer((req, res) => {
    handleMcpRequest(req, res, service)
  })
  mcpHttpServer.listen(config.mcp.port, () => {
    getLogger().info(`MCP server running at http://localhost:${config.mcp.port}`)
  })
  mcpHttpServer.on('error', (err) => {
    getLogger().error('MCP HTTP server error:', err)
  })
}
