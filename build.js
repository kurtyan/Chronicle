#!/usr/bin/env node

/**
 * Build script for task-manager
 * Usage: node build.js [output-dir]
 * Default output: ./dist/task-manager
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const OUTPUT_DIR = process.argv[2] || './dist/task-manager'
const ROOT_DIR = __dirname

function run(cmd, cwd) {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

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

console.log('=== Building Task Manager ===\n')

// Step 1: Build web frontend
console.log('[1/4] Building web frontend...')
run('npm install', path.join(ROOT_DIR, 'web'))
run('npm run build', path.join(ROOT_DIR, 'web'))

// Step 2: Build server
console.log('\n[2/4] Building server...')
run('npm install', path.join(ROOT_DIR, 'server'))
run('npm run build', path.join(ROOT_DIR, 'server'))

// Step 3: Create output directory
console.log('\n[3/4] Creating artifact...')
const artifactDir = path.resolve(ROOT_DIR, OUTPUT_DIR)
if (fs.existsSync(artifactDir)) {
  fs.rmSync(artifactDir, { recursive: true })
}
fs.mkdirSync(artifactDir, { recursive: true })

// Copy server files
copyDir(path.join(ROOT_DIR, 'server/dist'), path.join(artifactDir, 'dist'))
copyDir(path.join(ROOT_DIR, 'server/public'), path.join(artifactDir, 'public'))

// Copy package.json and install production dependencies
const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'server/package.json'), 'utf-8'))

// Remove devDependencies for production
const productionPkg = {
  name: serverPkg.name,
  version: serverPkg.version || '1.0.0',
  description: 'Chronicle Task Manager - Local-first task tracking server',
  bin: {
    'chronicle': 'dist/index.js'
  },
  scripts: {
    start: 'node dist/index.js',
  },
  dependencies: serverPkg.dependencies,
}

fs.writeFileSync(
  path.join(artifactDir, 'package.json'),
  JSON.stringify(productionPkg, null, 2)
)

// Create startup script
const startScript = process.platform === 'win32'
  ? 'start.bat'
  : 'start.sh'

const startScriptContent = process.platform === 'win32'
  ? `@echo off
cd "%~dp0"
npm install --production
node dist/index.js
`
  : `#!/bin/bash
cd "$(dirname "$0")"
chmod +x dist/index.js
npm install --production
node dist/index.js
`

fs.writeFileSync(path.join(artifactDir, startScript), startScriptContent)
if (process.platform !== 'win32') {
  fs.chmodSync(path.join(artifactDir, startScript), 0o755)
}

// Step 4: Install production dependencies in artifact
console.log('\n[4/4] Installing production dependencies...')
run('npm install --production', artifactDir)

// Create a README
fs.writeFileSync(
  path.join(artifactDir, 'README.md'),
  `# Task Manager

## Start
\`\`\`bash
./start.sh    # Linux/Mac
./start.bat   # Windows
\`\`\`

Or:
\`\`\`bash
npm start
\`\`\`

## Data
Data is stored in ./data/ directory.
`
)

console.log(`\n=== Build Complete ===`)
console.log(`Artifact location: ${artifactDir}`)
console.log(`\nTo run:`)
console.log(`  cd ${path.relative(process.cwd(), artifactDir)}`)
console.log(`  ./start.sh`)
