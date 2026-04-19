#!/usr/bin/env node

/**
 * Clean all build artifacts
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = __dirname

const dirs = [
  'dist',
  'dist/chronicle-npm',
  'dist/task-manager',
  'server/dist',
  'server/public',
  'web/dist',
  'web/data',
]

for (const d of dirs) {
  const full = path.join(ROOT, d)
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true })
    console.log(`[clean] Removed ${d}/`)
  }
}

console.log('[clean] Done')
