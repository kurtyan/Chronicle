import { defineConfig } from '@playwright/test'

process.env.CHRONICLE_TEST_IN_PROCESS = '1'
export default defineConfig({
  testDir: './tests', testMatch: ['project-management.test.ts', 'project-ui.test.ts'], workers: 1, timeout: 30_000,
  reporter: 'list', outputDir: './test-results/project-inprocess',
  use: { baseURL: 'http://127.0.0.1:18182', browserName: 'webkit' },
})
