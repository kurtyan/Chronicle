#!/usr/bin/env node
/**
 * Generate Chronicle version string: v{base}-{yyyyMMddHHmmss}
 *
 * Usage:
 *   node generate-version.js          # output to stdout (dev mode)
 *   node generate-version.js --write  # write to VERSION_BUILD file (build mode)
 */

const fs = require('fs')
const path = require('path')

const root = __dirname === '/Users/yanke/IdeaProjects/Chronicle/scripts'
  ? '/Users/yanke/IdeaProjects/Chronicle'
  : path.resolve(__dirname, '..')

const base = fs.readFileSync(path.join(root, 'VERSION'), 'utf-8').trim()
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const version = `v${base}-${ts}`

if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(root, 'VERSION_BUILD'), version)
} else {
  console.log(version)
}
