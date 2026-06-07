import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.ts',
  timeout: 30000,
  webServer: {
    command: 'mkdir -p /private/tmp/chronicle-playwright-data && rm -f /private/tmp/chronicle-playwright-data/tasks.db /private/tmp/chronicle-playwright-data/tasks.db-shm /private/tmp/chronicle-playwright-data/tasks.db-wal && cd server && PATH=$HOME/.nvm/versions/node/v25.5.0/bin:$PATH CHRONICLE_SERVER_PORT=18082 CHRONICLE_DB_PATH=/private/tmp/chronicle-playwright-data/tasks.db CHRONICLE_ATTACHMENT_DIR=/private/tmp/chronicle-playwright-data/attachments npm run dev -- --port 18082',
    url: 'http://localhost:18082',
    reuseExistingServer: false,
    timeout: 30000,
  },
  use: {
    baseURL: 'http://localhost:18082',
  },
})
