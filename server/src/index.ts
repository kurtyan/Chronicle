import { serve } from '@hono/node-server'
import { createServer } from 'http'
import { app, service, initializeDatabaseState } from './app'
import { getConfig } from './config'
import { closeDb } from './db'
import { startBackupService } from './services/backupService'
import { getLogger } from './logging'
import { getVersion } from './version'
import { handleMcpRequest } from './mcp/start'

const config = getConfig()
const index = process.argv.indexOf('--port')
const port = index >= 0 ? Number(process.argv[index + 1]) : config.server.port
const host = config.server.host
initializeDatabaseState()
startBackupService()

function shutdown(signal: string) {
  getLogger().info(`Received ${signal}, shutting down...`)
  closeDb()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
serve({ fetch: app.fetch, port, hostname: host })
getLogger().info(`Chronicle ${getVersion()} — Server running at http://${host}:${port}`)

if (config.mcp.enabled) {
  const mcpHttpServer = createServer((req, res) => handleMcpRequest(req, res, service))
  mcpHttpServer.listen(config.mcp.port, '127.0.0.1', () => {
    getLogger().warn('Chronicle MCP is deprecated and enabled only for this run. It will be removed in the next release.')
    getLogger().info(`Chronicle ${getVersion()} — MCP server running at http://127.0.0.1:${config.mcp.port}`)
  })
  mcpHttpServer.on('error', err => getLogger().error({ err }, 'MCP HTTP server error'))
}
