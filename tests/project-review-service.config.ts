import { defineConfig } from '@playwright/test'

/** In-process service verification: no listener, browser, or production configuration. */
export default defineConfig({
  testDir: '.', testMatch: 'project-review-service.test.ts', timeout: 15000, workers: 1,
  reporter: 'line', outputDir: '../test-results/project-review-service',
})
