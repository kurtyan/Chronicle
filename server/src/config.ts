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
  llm: {
    baseUrl: string
    model: string
    apiKey: string
    timeoutMs: number
    meetingExtractionPrompt: string
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
  llm: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    apiKey: '',
    timeoutMs: 30000,
    meetingExtractionPrompt: '',
  },
}

const configDir = path.join(os.homedir(), '.chronicle')
const configPath = path.join(configDir, 'config.json')

export function getConfig(): ChronicleConfig {
  // Environment variables override config file (for dev isolation)
  const envPort = process.env.CHRONICLE_SERVER_PORT
  const envMcpPort = process.env.CHRONICLE_MCP_PORT
  const envLlmBaseUrl = process.env.CHRONICLE_LLM_BASE_URL
  const envLlmModel = process.env.CHRONICLE_LLM_MODEL
  const envLlmApiKey = process.env.CHRONICLE_LLM_API_KEY
  const envLlmTimeoutMs = process.env.CHRONICLE_LLM_TIMEOUT_MS

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
      logPath: fileConfig.server?.logPath,
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
    llm: {
      baseUrl: envLlmBaseUrl ?? fileConfig.llm?.baseUrl ?? defaultConfig.llm.baseUrl,
      model: envLlmModel ?? fileConfig.llm?.model ?? defaultConfig.llm.model,
      apiKey: envLlmApiKey ?? fileConfig.llm?.apiKey ?? defaultConfig.llm.apiKey,
      timeoutMs: envLlmTimeoutMs ? parseInt(envLlmTimeoutMs, 10) : (fileConfig.llm?.timeoutMs ?? defaultConfig.llm.timeoutMs),
      meetingExtractionPrompt: fileConfig.llm?.meetingExtractionPrompt ?? defaultConfig.llm.meetingExtractionPrompt,
    },
  }
}

export function updateConfig(patch: Partial<ChronicleConfig>): ChronicleConfig {
  const current = getConfig()
  const next: ChronicleConfig = {
    ...current,
    ...patch,
    server: { ...current.server, ...patch.server },
    mcp: { ...current.mcp, ...patch.mcp },
    lauri: { ...current.lauri, ...patch.lauri },
    ui: { ...current.ui, ...patch.ui },
    llm: { ...current.llm, ...patch.llm },
  }
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2))
  return getConfig()
}

export function getDbPath(): string {
  // Environment variable overrides config (for dev isolation)
  if (process.env.CHRONICLE_DB_PATH) return process.env.CHRONICLE_DB_PATH
  const config = getConfig()
  if (config.server.database) return config.server.database
  return path.join(os.homedir(), '.chronicle', 'data', 'tasks.db')
}

export function ensureDataDir() {
  const dbPath = getDbPath()
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
