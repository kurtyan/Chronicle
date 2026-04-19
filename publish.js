#!/usr/bin/env node

/**
 * Publish script for Chronicle
 *
 * Usage:
 *   node publish.js          # dry run
 *   node publish.js --publish # actually publish to npm
 *
 * Builds web + server, creates a publishable package, and optionally publishes.
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT_DIR = __dirname
const PUBLISH_DIR = path.join(ROOT_DIR, 'dist', 'chronicle-npm')

function run(cmd, cwd) {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

console.log('=== Publishing Chronicle ===\n')

// Step 1: Build web frontend
console.log('[1/4] Building web frontend...')
run('npm install', path.join(ROOT_DIR, 'web'))
run('npm run build', path.join(ROOT_DIR, 'web'))
// Vite outputs to web/dist/, copy to server/public/
copyDir(path.join(ROOT_DIR, 'web', 'dist'), path.join(ROOT_DIR, 'server', 'public'))

// Step 2: Build server
console.log('\n[2/4] Building server...')
run('npm install', path.join(ROOT_DIR, 'server'))
run('npm run build', path.join(ROOT_DIR, 'server'))

// Step 3: Create publishable package
console.log('\n[3/4] Creating publishable package...')
if (fs.existsSync(PUBLISH_DIR)) {
  fs.rmSync(PUBLISH_DIR, { recursive: true })
}
fs.mkdirSync(PUBLISH_DIR, { recursive: true })

// Copy server dist + public
copyDir(path.join(ROOT_DIR, 'server', 'dist'), path.join(PUBLISH_DIR, 'dist'))
copyDir(path.join(ROOT_DIR, 'server', 'public'), path.join(PUBLISH_DIR, 'public'))

// Create package.json for publishing
const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'server', 'package.json'), 'utf-8'))
const publishPkg = {
  name: serverPkg.name,
  version: serverPkg.version,
  description: serverPkg.description,
  bin: serverPkg.bin,
  scripts: {
    start: 'node dist/cli.js start',
    postinstall: serverPkg.scripts.postinstall,
  },
  dependencies: serverPkg.dependencies,
  engines: {
    node: '>=18',
  },
}

fs.writeFileSync(
  path.join(PUBLISH_DIR, 'package.json'),
  JSON.stringify(publishPkg, null, 2)
)

// Copy README
if (fs.existsSync(path.join(ROOT_DIR, 'README.md'))) {
  fs.copyFileSync(path.join(ROOT_DIR, 'README.md'), path.join(PUBLISH_DIR, 'README.md'))
}

// Install production dependencies
console.log('\n[4/4] Installing production dependencies...')
run('npm install --production', PUBLISH_DIR)

console.log(`\n=== Build Complete ===`)
console.log(`Publishable package: ${PUBLISH_DIR}`)
console.log(`\nTo publish:`)
console.log(`  cd ${PUBLISH_DIR}`)
console.log(`  npm publish`)
console.log(`\nOr run with --publish flag:`)
console.log(`  node publish.js --publish`)

// Auto-publish if flag passed
if (process.argv.includes('--publish')) {
  console.log('\n=== Publishing to npm ===')
  run('npm publish', PUBLISH_DIR)
  console.log('Published successfully!')
}
