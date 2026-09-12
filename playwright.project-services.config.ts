import { defineConfig } from '@playwright/test'

// Isolated service tests: no web server, browser, or shared development data.
export default defineConfig({
  testDir: './tests',
  testMatch: 'project-*-service.test.ts',
  outputDir: './test-results/project-services',
  workers: 1,
  timeout: 30000,
})
