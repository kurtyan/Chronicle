import { defineConfig } from '@playwright/test'
import path from 'node:path'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
const port = Number(process.env.CHRONICLE_TEST_PORT)
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep) || !Number.isInteger(port) || port < 1024) throw new Error('Use scripts/test-work-outline.mjs: isolated repository data required')
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
export default defineConfig({
  testDir: './tests', testMatch: ['work-outline-*-ui.test.ts', ...(process.env.CHRONICLE_TEST_REGRESSIONS === '1' ? ['cmd-s-draft-entry.test.ts', 'editor-tab-list.test.ts', 'notes.test.ts', 'work-overview-keyboard.test.ts', 'project-shell-style-ui.test.ts'] : [])], workers: 1, timeout: 45_000,
  reporter: 'list', outputDir: path.join(directory, 'results'),
  webServer: { command: `cd server && ${quote(process.execPath)} dist/index.js --port ${port}`, url: `http://127.0.0.1:${port}/api/version`, reuseExistingServer: false, timeout: 60_000, env: {
    CHRONICLE_SERVER_PORT: String(port), CHRONICLE_MCP_PORT: '0', CHRONICLE_ENABLE_LEGACY_MCP: '0',
    CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'), CHRONICLE_CONFIG_DIR: path.join(directory, 'config'),
    CHRONICLE_CONFIG_PATH: path.join(directory, 'config/config.json'), CHRONICLE_LOG_DIR: path.join(directory, 'logs'),
    CHRONICLE_LOG_PATH: path.join(directory, 'logs/server.log'), CHRONICLE_ATTACHMENT_DIR: path.join(directory, 'attachments'),
    CHRONICLE_LLM_BASE_URL: 'http://127.0.0.1:1/v1', CHRONICLE_LLM_API_KEY: '', CHRONICLE_LLM_TIMEOUT_MS: '500',
  } },
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'webkit', locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
})
