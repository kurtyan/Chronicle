import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.ts',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8083',
  },
})
