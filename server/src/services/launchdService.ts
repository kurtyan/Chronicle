import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'
import { getConfig } from '../config'
import { getLogger } from '../logging'

const plistName = 'com.chronicle.server.plist'
const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
const plistPath = path.join(plistDir, plistName)

export function generatePlist(): string {
  const config = getConfig()
  const home = os.homedir()
  const nodePath = execSync('which node').toString().trim()

  // Determine the server directory (parent of the current working directory for dist)
  const serverDir = process.cwd()

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chronicle.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverDir}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${serverDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${config.server.logPath ?? path.join(home, '.chronicle', 'logs', 'server.log')}</string>
    <key>StandardErrorPath</key>
    <string>${config.server.logPath ?? path.join(home, '.chronicle', 'logs', 'server-error.log')}</string>
</dict>
</plist>`
}

export function installLaunchd(): boolean {
  if (process.platform !== 'darwin') return false

  const plist = generatePlist()
  if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true })
  fs.writeFileSync(plistPath, plist)
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' })
    getLogger().info('launchd service installed and loaded')
    return true
  } catch (err) {
    getLogger().error(`Failed to load launchd service: ${err}`)
    return false
  }
}

export function uninstallLaunchd(): boolean {
  if (process.platform !== 'darwin') return false
  if (!fs.existsSync(plistPath)) return true

  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' })
    fs.unlinkSync(plistPath)
    getLogger().info('launchd service uninstalled')
    return true
  } catch (err) {
    getLogger().error(`Failed to unload launchd service: ${err}`)
    return false
  }
}

export function isInstalled(): boolean {
  return fs.existsSync(plistPath)
}
