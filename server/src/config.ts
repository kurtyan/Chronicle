import path from 'path'
import os from 'os'
import fs from 'fs'

export interface ChronicleConfig {
  server: {
    host: string
    port: number
    database: string
    logPath?: string
  }
  mcp: {
    enabled: boolean
    port: number
  }
  lauri: {
    serverHost: string
    serverPort: number
  }
  ui: {
    language: string
  }
}

const defaultConfig: ChronicleConfig = {
  server: {
    host: '127.0.0.1',
    port: 9983,
    database: '',
  },
  mcp: {
    enabled: true,
    port: 9981,
  },
  lauri: {
    serverHost: 'localhost',
    serverPort: 9983,
  },
  ui: {
    language: 'auto',
  },
}

const configDir = path.join(os.homedir(), '.chronicle')
const configPath = path.join(configDir, 'config.json')

export function getConfig(): ChronicleConfig {
  // Environment variables override config file (for dev isolation)
  const envPort = process.env.CHRONICLE_SERVER_PORT
  const envMcpPort = process.env.CHRONICLE_MCP_PORT

  const fileConfig: Partial<ChronicleConfig> = (() => {
    try {
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      }
    } catch { /* Use defaults */ }
    return {}
  })()

  const serverPort = envPort ? parseInt(envPort, 10) : (fileConfig.server?.port ?? defaultConfig.server.port)
  const mcpPort = envMcpPort ? parseInt(envMcpPort, 10) : (fileConfig.mcp?.port ?? defaultConfig.mcp.port)
  const lauriServerPort = fileConfig.lauri?.serverPort ?? defaultConfig.lauri.serverPort

  return {
    server: {
      host: fileConfig.server?.host ?? defaultConfig.server.host,
      port: serverPort,
      database: fileConfig.server?.database ?? defaultConfig.server.database,
    },
    mcp: {
      enabled: fileConfig.mcp?.enabled ?? defaultConfig.mcp.enabled,
      port: mcpPort,
    },
    lauri: {
      serverHost: fileConfig.lauri?.serverHost ?? defaultConfig.lauri.serverHost,
      serverPort: lauriServerPort,
    },
    ui: {
      language: fileConfig.ui?.language ?? defaultConfig.ui.language,
    },
  }
}

export function getDbPath(): string {
  // Environment variable overrides config (for dev isolation)
  if (process.env.CHRONICLE_DB_PATH) return process.env.CHRONICLE_DB_PATH
  const config = getConfig()
  if (config.server.database) return config.server.database
  return path.join(process.cwd(), 'data', 'tasks.db')
}

export function ensureDataDir() {
  const dbPath = getDbPath()
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
