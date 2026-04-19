/**
 * Chronicle CLI — start / stop / status / setup
 *
 * Usage:
 *   chronicle          — show help
 *   chronicle start    — start the server in foreground
 *   chronicle setup    — (re-)install launchd background service
 */

const { execSync, exec, spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

const SCRIPT_DIR = path.dirname(fs.realpathSync(process.argv[1]))
const SERVER_INDEX = path.join(SCRIPT_DIR, 'index.js')
const CONFIG_PATH = path.join(os.homedir(), '.chronicle', 'config.json')
const PID_FILE = path.join(os.homedir(), '.chronicle', 'chronicle.pid')

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function getServerPort() {
  return readConfig()?.server?.port ?? 8080
}

function getServerHost() {
  return readConfig()?.server?.host ?? '127.0.0.1'
}

function findServerPID(port) {
  port = port || getServerPort()
  try {
    // Check PID file first
    if (fs.existsSync(PID_FILE)) {
      const pid = fs.readFileSync(PID_FILE, 'utf-8').trim()
      try {
        execSync(`kill -0 ${pid}`, { stdio: 'pipe' })
        return pid
      } catch {
        fs.unlinkSync(PID_FILE)
      }
    }
    // Fallback: lsof
    const output = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf-8' })
    return output.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

// --- Commands ---

function cmdStart() {
  const host = getServerHost()
  const port = getServerPort()

  // Check if already running
  const pid = findServerPID(port)
  if (pid) {
    console.log(`[chronicle] Server already running (PID ${pid}) at http://${host}:${port}`)
    return
  }

  console.log(`[chronicle] Starting server at http://${host}:${port}...`)

  const child = spawn('node', [SERVER_INDEX], {
    stdio: 'inherit',
    cwd: SCRIPT_DIR,
  })

  // Write PID file
  fs.writeFileSync(PID_FILE, String(child.pid))

  child.on('exit', (code) => {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE)
    if (code !== 0 && code !== null) {
      process.exit(code)
    }
  })

  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
}

function cmdStop() {
  const port = getServerPort()
  const pid = findServerPID(port)

  if (!pid) {
    console.log('[chronicle] Server is not running')
    // Also try to unload launchd service
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.chronicle.server.plist')
    if (fs.existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' })
        console.log('[chronicle] Launchd service unloaded')
      } catch {
        // Already unloaded
      }
    }
    return
  }

  try {
    execSync(`kill ${pid}`, { stdio: 'pipe' })
    console.log(`[chronicle] Server stopped (PID ${pid})`)
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE)
  } catch {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'pipe' })
      console.log(`[chronicle] Server force-stopped (PID ${pid})`)
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE)
    } catch (err) {
      console.error('[chronicle] Failed to stop server:', err.message)
    }
  }
}

function cmdStatus() {
  const host = getServerHost()
  const port = getServerPort()
  const pid = findServerPID(port)

  console.log('Chronicle Server Status')
  console.log('─'.repeat(30))

  if (pid) {
    console.log(`  Process:   running (PID ${pid})`)
    console.log(`  Address:   http://${host}:${port}`)
  } else {
    console.log(`  Process:   not running`)
    console.log(`  Address:   http://${host}:${port} (configured)`)
  }

  // Launchd service
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.chronicle.server.plist')
  const launchdInstalled = fs.existsSync(plistPath)

  if (process.platform === 'darwin') {
    console.log(`  Launchd:   ${launchdInstalled ? 'installed' : 'not installed'}`)
    if (launchdInstalled) {
      try {
        const list = execSync(`launchctl list | grep chronicle 2>/dev/null || true`, { encoding: 'utf-8' }).trim()
        console.log(`             ${list || '(not loaded)'}`)
      } catch {
        console.log('             (unknown)')
      }
    }
  }

  // Data directory
  const dataDir = path.join(SCRIPT_DIR, 'data')
  if (fs.existsSync(dataDir)) {
    const dbPath = path.join(dataDir, 'tasks.db')
    if (fs.existsSync(dbPath)) {
      const size = fs.statSync(dbPath).size
      console.log(`  Database:  ${dbPath} (${(size / 1024).toFixed(1)} KB)`)
    }
  }
}

function cmdHelp() {
  console.log(`Chronicle — local-first task management

Usage:
  chronicle start    Start the server in foreground
  chronicle stop     Stop the running server
  chronicle status   Show server and launchd status
  chronicle setup    Install/reinstall launchd background service
  chronicle          Show this help

Config: ~/.chronicle/config.json
`)
}

// --- Main ---

const command = process.argv[2]

switch (command) {
  case 'start':
    cmdStart()
    break
  case 'stop':
    cmdStop()
    break
  case 'status':
    cmdStatus()
    break
  case 'setup':
    // Delegate to setup.js
    try {
      execSync(`node "${path.join(SCRIPT_DIR, 'setup.js')}"`, { stdio: 'inherit' })
    } catch (err) {
      process.exit(1)
    }
    break
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    cmdHelp()
    break
  default:
    console.error(`Unknown command: ${command}`)
    cmdHelp()
    process.exit(1)
}
