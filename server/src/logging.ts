import path from 'path'
import os from 'os'
import fs from 'fs'
import pino from 'pino'
import { getConfig } from './config'

let logger: pino.Logger | null = null

export function getLogger(): pino.Logger {
  if (!logger) {
    const config = getConfig()
    const logPath = process.env.CHRONICLE_LOG_PATH
      ?? config.server.logPath
      ?? path.join(process.env.CHRONICLE_CONFIG_DIR ?? path.join(os.homedir(), '.chronicle'), 'logs', 'server.log')
    const logDir = path.dirname(logPath)
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

    logger = pino(pino.destination(logPath))
  }
  return logger
}
