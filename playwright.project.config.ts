import { defineConfig } from '@playwright/test'
import path from 'node:path'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
const port = Number(process.env.CHRONICLE_TEST_PORT)
if (!directory || !Number.isInteger(port) || port < 1024) throw new Error('Run through ./scripts/with-node.sh node scripts/test-project-management.mjs')
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',')
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete process.env[key]

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  workers: 1,
  outputDir: path.join(directory, 'results'),
  reporter: 'list',
  webServer: {
    command: `cd server && ${quote(process.execPath)} dist/index.js --port ${port}`,
    url: `http://127.0.0.1:${port}/api/version`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      CHRONICLE_SERVER_PORT: String(port),
      CHRONICLE_MCP_PORT: process.env.CHRONICLE_TEST_MCP_PORT || '0',
      CHRONICLE_ENABLE_LEGACY_MCP: '1',
      CHRONICLE_CONFIG_DIR: path.join(directory, 'config'),
      CHRONICLE_CONFIG_PATH: path.join(directory, 'config/config.json'),
      CHRONICLE_LOG_DIR: path.join(directory, 'logs'),
      CHRONICLE_LOG_PATH: path.join(directory, 'logs/server.log'),
      CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'),
      CHRONICLE_ATTACHMENT_DIR: path.join(directory, 'attachments'),
    },
  },
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'webkit' },
})
