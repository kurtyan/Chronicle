import { defineConfig } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

// Configure every persistence surface before test modules can import app/config.
const root = path.resolve('.dev-data/work-outline-services')
fs.mkdirSync(root, { recursive: true })
Object.assign(process.env, {
  CHRONICLE_DB_PATH: path.join(root, 'guard.db'), CHRONICLE_CONFIG_DIR: root,
  CHRONICLE_CONFIG_PATH: path.join(root, 'config.json'), CHRONICLE_LOG_DIR: root,
  CHRONICLE_LOG_PATH: path.join(root, 'test.log'), CHRONICLE_ATTACHMENT_DIR: path.join(root, 'attachments'),
  CHRONICLE_LLM_BASE_URL: 'http://127.0.0.1:1/v1', CHRONICLE_LLM_API_KEY: '', CHRONICLE_LLM_TIMEOUT_MS: '100',
  TMPDIR: root,
})
export default defineConfig({ testDir: './tests', testMatch: ['work-outline-*-service.test.ts', 'project-*-service.test.ts'], workers: 1, timeout: 30_000, reporter: 'list', outputDir: './test-results/work-outline-services' })
