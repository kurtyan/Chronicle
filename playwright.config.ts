import { defineConfig } from '@playwright/test'

process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',')
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[key]
}

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.ts',
  timeout: 30000,
  webServer: {
    command: 'mkdir -p /private/tmp/chronicle-playwright-data && rm -f /private/tmp/chronicle-playwright-data/tasks.db /private/tmp/chronicle-playwright-data/tasks.db-shm /private/tmp/chronicle-playwright-data/tasks.db-wal && cd server && PATH=$HOME/.nvm/versions/node/v25.5.0/bin:$PATH npm run build && PATH=$HOME/.nvm/versions/node/v25.5.0/bin:$PATH CHRONICLE_SERVER_PORT=18182 CHRONICLE_MCP_PORT=18183 CHRONICLE_DB_PATH=/private/tmp/chronicle-playwright-data/tasks.db CHRONICLE_ATTACHMENT_DIR=/private/tmp/chronicle-playwright-data/attachments node dist/index.js --port 18182',
    url: 'http://127.0.0.1:18182',
    reuseExistingServer: false,
    timeout: 30000,
  },
  use: {
    baseURL: 'http://127.0.0.1:18182',
  },
})
