/**
 * Post-install script for `npm install -g chronicle`
 * Installs launchd service on macOS so the server starts at login.
 */
import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'

const SCRIPT_DIR = path.dirname(process.argv[1])
const plistName = 'com.chronicle.server.plist'
const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
const plistPath = path.join(plistDir, plistName)

function main() {
  if (process.platform !== 'darwin') {
    console.log('[chronicle] Skipping launchd setup (macOS only)')
    process.exit(0)
  }

  if (fs.existsSync(plistPath)) {
    console.log('[chronicle] launchd service already installed')
    process.exit(0)
  }

  const nodePath = execSync('which node').toString().trim()
  const serverIndex = path.join(SCRIPT_DIR, 'dist', 'index.js')
  const home = os.homedir()
  const logPath = path.join(home, '.chronicle', 'logs', 'server.log')
  const errorLogPath = path.join(home, '.chronicle', 'logs', 'server-error.log')

  // Ensure log directory exists
  fs.mkdirSync(path.dirname(logPath), { recursive: true })

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chronicle.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverIndex}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${errorLogPath}</string>
</dict>
</plist>`

  fs.mkdirSync(plistDir, { recursive: true })
  fs.writeFileSync(plistPath, plist)

  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' })
    console.log('[chronicle] launchd service installed successfully')
    console.log(`[chronicle] Server starts at login, logs: ${logPath}`)
  } catch (err) {
    console.error('[chronicle] Failed to load launchd service:', err)
    console.log('[chronicle] Plist created at:', plistPath)
    console.log('[chronicle] Run manually: launchctl load', plistPath)
    // Don't exit non-zero — service can be loaded later
  }
}

main()
