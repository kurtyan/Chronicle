import path from 'path'
import os from 'os'
import fs from 'fs'

export interface ChronicleConfig {
  server: {
    host: string
    port: number
    database: string
  }
  lauri: {
    serverHost: string
    serverPort: number
  }
}

const defaultConfig: ChronicleConfig = {
  server: {
    host: '127.0.0.1',
    port: 8080,
    database: '',
  },
  lauri: {
    serverHost: 'localhost',
    serverPort: 8080,
  },
}

const configDir = path.join(os.homedir(), '.chronicle')
const configPath = path.join(configDir, 'config.json')

export function getConfig(): ChronicleConfig {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ChronicleConfig>
      return {
        server: { ...defaultConfig.server, ...parsed.server },
        lauri: { ...defaultConfig.lauri, ...parsed.lauri },
      }
    }
  } catch {
    // Use defaults
  }
  return defaultConfig
}

export function getDbPath(): string {
  const config = getConfig()
  if (config.server.database) return config.server.database
  return path.join(process.cwd(), 'data', 'tasks.db')
}

export function ensureDataDir() {
  const dbPath = getDbPath()
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
