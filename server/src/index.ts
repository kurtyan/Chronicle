import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { AppService } from './services/appService'
import { initDb, closeDb, getMetaValue, setMetaValue } from './db'
import { getConfig } from './config'
import { startBackupService } from './services/backupService'
import { exportDatabase, importDatabase, getSettingsInfo } from './services/settingsService'
import {
  extractMeeting,
  getLlmCallLog,
  getLlmSettings,
  listLlmCallLogs,
  saveLlmSettings,
  testLlmConnection,
} from './services/llmService'
import { createMeeting } from './services/meetingService'
import { generatePlist, installLaunchd, uninstallLaunchd, isInstalled } from './services/launchdService'
import { getLogger } from './logging'
import { getVersion } from './version'
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

import { setTaskExtraInfo } from './services/taskService'

// Extract client ID from header for SSE source tracking
app.use('/*', async (c, next) => {
  c.set('clientId', c.req.header('X-Client-Id') ?? '')
  await next()
})

// Extract claude conversation ID from header for task write operations
function saveConversationId(c: any, taskId: string) {
  const conversationId = c.req.header('X-Claude-Conversation-Id')
  if (conversationId && taskId) {
    setTaskExtraInfo(taskId, 'claude_conversation_id', conversationId)
  }
}

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

app.get('/api/tasks/next-id', async (c) => {
  return c.json({ id: service.getNextTaskId() })
})

app.get('/api/tasks/pinned', async (c) => {
  const ids = await service.getPinnedTaskIds()
  return c.json({ ids: [...ids] })
})

app.post('/api/tasks', async (c) => {
  const body = await c.req.json()
  const task = await service.createTask(body)
  const conversationId = c.req.header('X-Claude-Conversation-Id')
  if (conversationId) {
    setTaskExtraInfo(task.id, 'claude_conversation_id', conversationId)
  }
  broadcastEvent('task_created', { id: task.id }, c.get('clientId'))
  return c.json(task, 201)
})

app.get('/api/tasks/:id', async (c) => {
  const task = await service.getTaskById(c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)
  const claudeConversationId = await service.getTaskExtraInfoValue(c.req.param('id'), 'claude_conversation_id')
  return c.json({ ...task, claude_conversation_id: claudeConversationId ?? null })
})

app.put('/api/tasks/:id', async (c) => {
  const body = await c.req.json()
  const task = await service.updateTask(c.req.param('id'), body)
  if (!task) return c.json({ error: 'Not found' }, 404)
  saveConversationId(c, c.req.param('id'))
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
  saveConversationId(c, c.req.param('id'))
  if (!body.silent) {
    broadcastEvent('entry_created', { taskId: c.req.param('id'), entryId: entry.id, type: entry.type }, c.get('clientId'))
  }
  return c.json(entry, 201)
})

app.post('/api/tasks/logs/batch', async (c) => {
  const body = await c.req.json()
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0) : []
  if (taskIds.length === 0 || typeof body.content !== 'string' || body.content.trim().length === 0) {
    return c.json({ error: 'taskIds and content are required' }, 400)
  }

  try {
    const entries = await service.submitTaskEntries(taskIds, body.content, body.type ?? 'log')
    for (const entry of entries) {
      saveConversationId(c, entry.taskId)
      if (!body.silent) {
        broadcastEvent('entry_created', { taskId: entry.taskId, entryId: entry.id, type: entry.type }, c.get('clientId'))
      }
    }
    return c.json(entries, 201)
  } catch (err: any) {
    const message = err?.message || 'Failed to create entries'
    const status = message.includes('Task not found') ? 404 : 400
    return c.json({ error: message }, status)
  }
})

app.put('/api/tasks/:id/logs/:entryId', async (c) => {
  const body = await c.req.json()
  const entry = await service.updateTaskEntry(c.req.param('id'), c.req.param('entryId'), body.content)
  if (!entry) return c.json({ error: 'Not found' }, 404)
  saveConversationId(c, c.req.param('id'))
  broadcastEvent('entry_updated', { taskId: c.req.param('id'), entryId: entry.id }, c.get('clientId'))
  return c.json(entry)
})

app.delete('/api/tasks/:id/logs/:entryId', async (c) => {
  const ok = await service.deleteTaskEntry(c.req.param('id'), c.req.param('entryId'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  saveConversationId(c, c.req.param('id'))
  broadcastEvent('entry_deleted', { taskId: c.req.param('id'), entryId: c.req.param('entryId') }, c.get('clientId'))
  return c.json({ success: true })
})

app.put('/api/tasks/:id/done', async (c) => {
  const task = await service.markTaskDone(c.req.param('id'))
  if (!task) return c.json({ error: 'Not found' }, 404)
  saveConversationId(c, c.req.param('id'))
  emitTaskChange(c, task)
  return c.json(task)
})

// --- Work Session API ---
app.post('/api/tasks/:id/takeover', async (c) => {
  const { session, task: changedTask } = await service.takeOverTask(c.req.param('id'))
  saveConversationId(c, c.req.param('id'))
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
  saveConversationId(c, c.req.param('id'))
  emitTaskChange(c, task)
  return c.json(task)
})

// --- Meeting API ---
app.post('/api/meetings/extract', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.rawContent || typeof body.rawContent !== 'string') {
      return c.json({ error: 'rawContent is required' }, 400)
    }
    const mode = body.mode === 'test' ? 'test' : 'record'
    return c.json(await extractMeeting(body.rawContent, mode))
  } catch (err: any) {
    return c.json({ error: err.message || 'Meeting extraction failed' }, 400)
  }
})

app.post('/api/meetings', async (c) => {
  try {
    const body = await c.req.json()
    const task = createMeeting(body)
    broadcastEvent('task_created', { id: task.id }, c.get('clientId'))
    return c.json(task, 201)
  } catch (err: any) {
    return c.json({ error: err.message || 'Meeting save failed' }, 400)
  }
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

app.post('/api/tasks/:id/pin', async (c) => {
  const pinned = await service.togglePinned(c.req.param('id'))
  return c.json({ pinned })
})

// --- AFK Events API ---
app.post('/api/afk-events', async (c) => {
  const body = await c.req.json()
  try {
    const event = await service.createAfkEvent(body.reason, body.triggeredAt ?? Date.now(), body.userNote)
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

app.get('/api/reports/tasks', async (c) => {
  const start = parseInt(c.req.query('start') || '0')
  const end = parseInt(c.req.query('end') || String(Date.now()))
  const filter = (c.req.query('filter') as 'NEW' | 'COMPLETED' | 'IN_PROGRESS' | 'ALL') || 'NEW'
  const page = parseInt(c.req.query('page') || '1')
  const pageSize = parseInt(c.req.query('pageSize') || '50')
  return c.json(await service.fetchReportTasks(start, end, filter, page, pageSize))
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

// --- Plan Items API ---

app.get('/api/plan-items/has-plan', async (c) => {
  const date = c.req.query('date')
  if (!date) return c.json({ error: 'date query param required' }, 400)
  const has = await service.hasPlanForDate(date)
  return c.json({ hasPlan: has })
})

app.post('/api/plan-items/batch', async (c) => {
  const body = await c.req.json()
  const { planDate, items } = body
  if (!planDate || !Array.isArray(items)) {
    return c.json({ error: 'planDate and items array required' }, 400)
  }
  const planItems = await service.batchCreatePlanItems(planDate, items)
  broadcastEvent('plan_created', { planDate }, c.get('clientId'))
  return c.json(planItems, 201)
})

app.get('/api/plan-items', async (c) => {
  const date = c.req.query('date')
  if (!date) return c.json({ error: 'date query param required' }, 400)
  const items = await service.getPlanItems(date)
  return c.json(items)
})

app.put('/api/plan-items/:detailId', async (c) => {
  const body = await c.req.json()
  const detail = await service.updatePlanItem(c.req.param('detailId'), body)
  if (!detail) return c.json({ error: 'Not found' }, 404)
  return c.json(detail)
})

app.delete('/api/plan-items/:detailId', async (c) => {
  const ok = await service.deletePlanItem(c.req.param('detailId'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.body(null, 204)
})

app.delete('/api/plan-items', async (c) => {
  const date = c.req.query('date')
  if (!date) return c.json({ error: 'date query param required' }, 400)
  const count = await service.clearPlanForDate(date)
  return c.json({ cleared: count })
})

app.get('/api/plans/unfinished', async (c) => {
  const beforeDate = c.req.query('before') || new Date().toISOString().slice(0, 10)
  const items = await service.fetchUnfinishedPlans(beforeDate)
  return c.json(items)
})

app.post('/api/plans/reparent', async (c) => {
  const body = await c.req.json()
  const { detailIds, newPlanDate } = body
  if (!detailIds || !Array.isArray(detailIds) || !newPlanDate) {
    return c.json({ error: 'detailIds array and newPlanDate required' }, 400)
  }
  await service.reparentPlanItems(detailIds, newPlanDate)
  broadcastEvent('plan_reparented', { newPlanDate }, c.get('clientId'))
  return c.json({ success: true })
})

// --- Day Script API ---
app.get('/api/day-scripts/:date', async (c) => {
  return c.json(await service.getDayScript(c.req.param('date')))
})

app.get('/api/day-scripts/:date/execution-records', async (c) => {
  const taskId = c.req.query('taskId') || undefined
  const startParam = c.req.query('start')
  const endParam = c.req.query('end')
  const start = startParam !== undefined ? Number(startParam) : undefined
  const end = endParam !== undefined ? Number(endParam) : undefined
  return c.json(await service.getDayScriptExecutionRecords(c.req.param('date'), {
    taskId,
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
  }))
})

app.put('/api/day-scripts/:date', async (c) => {
  try {
    const body = await c.req.json()
    const expectedRevision = Number(body.expectedRevision ?? 0)
    const focusActivities = Array.isArray(body.focusActivity) ? body.focusActivity : undefined
    const result = await service.saveDayScript(c.req.param('date'), body.document, expectedRevision, focusActivities)
    for (const task of result.createdTasks) {
      broadcastEvent('task_created', { id: task.id }, c.get('clientId'))
    }
    for (const log of result.createdLogs) {
      broadcastEvent('entry_created', { taskId: log.taskId, entryId: log.entryId, type: 'log' }, c.get('clientId'))
      const changedTask = await service.getTaskById(log.taskId)
      emitTaskChange(c, changedTask)
    }
    return c.json(result)
  } catch (err: any) {
    if (err?.message === 'REVISION_CONFLICT') {
      return c.json({ error: 'Revision conflict' }, 409)
    }
    return c.json({ error: err?.message || 'Save failed' }, 400)
  }
})

app.post('/api/day-scripts/:date/confirm-progress-sync', async (c) => {
  const body = await c.req.json()
  const items = Array.isArray(body.items) ? body.items : []
  const createdLogs = await service.confirmDayScriptProgressSync(c.req.param('date'), items)
  for (const log of createdLogs) {
    broadcastEvent('entry_created', { taskId: log.taskId, entryId: log.entryId, type: 'log' }, c.get('clientId'))
    const changedTask = await service.getTaskById(log.taskId)
    emitTaskChange(c, changedTask)
  }
  return c.json({ createdLogs })
})

// --- Task Context API ---
app.get('/api/task-context', async (c) => {
  const statuses = (c.req.query('status') || 'PENDING,DOING').split(',').map((value) => value.trim()).filter(Boolean)
  return c.json(await service.getTaskContexts(statuses))
})

app.post('/api/task-context/summarize', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((id: unknown) => typeof id === 'string') : undefined
  return c.json(await service.refreshTaskContexts(taskIds))
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

app.get('/api/settings/llm', async (c) => {
  return c.json(getLlmSettings())
})

app.put('/api/settings/llm', async (c) => {
  const body = await c.req.json()
  return c.json(saveLlmSettings(body))
})

app.post('/api/settings/llm/test-connection', async (c) => {
  try {
    return c.json(await testLlmConnection())
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'LLM connection failed' }, 400)
  }
})

app.get('/api/llm-call-logs', async (c) => {
  const feature = c.req.query('feature')
  const limit = parseInt(c.req.query('limit') || '50', 10)
  return c.json(listLlmCallLogs(feature, limit))
})

app.get('/api/llm-call-logs/:id', async (c) => {
  const log = getLlmCallLog(c.req.param('id'))
  if (!log) return c.json({ error: 'Not found' }, 404)
  return c.json(log)
})

// Start of day offset (global shift in hours, e.g. 5 = day starts at 5am)
app.get('/api/settings/start-of-day-offset', async (c) => {
  const v = getMetaValue('start_of_day_offset')
  return c.json({ offset: v ? parseInt(v, 10) : 5 })
})

app.put('/api/settings/start-of-day-offset', async (c) => {
  const { offset } = await c.req.json()
  const val = Math.max(0, Math.min(23, Number(offset) || 0))
  setMetaValue('start_of_day_offset', String(val))
  return c.json({ offset: val })
})

app.get('/api/version', async (c) => {
  return c.json({ version: getVersion() })
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

// Auto-rebuild FTS index when tokenizer version changes
const FTS_INDEX_VERSION_KEY = 'fts_tokenizer_version'
const CURRENT_TOKENIZER_VERSION = '3' // v3: per-entry FTS rows with entry_id
const storedVersion = getMetaValue(FTS_INDEX_VERSION_KEY)
if (storedVersion !== CURRENT_TOKENIZER_VERSION) {
  const log = getLogger()
  log.info(`FTS index version mismatch (stored: ${storedVersion}, current: ${CURRENT_TOKENIZER_VERSION}). Rebuilding...`)
  rebuildFtsIndex()
  setMetaValue(FTS_INDEX_VERSION_KEY, CURRENT_TOKENIZER_VERSION)
  log.info('FTS index rebuilt successfully')
}

startBackupService()

// Graceful shutdown: checkpoint WAL and close database
function shutdown(signal: string) {
  getLogger().info(`Received ${signal}, shutting down...`)
  closeDb()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

serve({ fetch: app.fetch, port, hostname: host })
getLogger().info(`Chronicle ${getVersion()} — Server running at http://${host}:${port}`)

import { createServer } from 'http'
import { handleMcpRequest } from './mcp/start'

// --- MCP Server ---
if (config.mcp.enabled) {
  const mcpHttpServer = createServer((req, res) => {
    handleMcpRequest(req, res, service)
  })
  mcpHttpServer.listen(config.mcp.port, () => {
    getLogger().info(`Chronicle ${getVersion()} — MCP server running at http://localhost:${config.mcp.port}`)
  })
  mcpHttpServer.on('error', (err) => {
    getLogger().error('MCP HTTP server error:', err)
  })
}
