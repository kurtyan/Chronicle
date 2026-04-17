import fs from 'fs'
import path from 'path'
import { getDbFilePath } from '../db'

const BACKUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const MAX_BACKUPS = 24

let lastBackupAt: number | null = null

function getBackupDir(): string {
  return path.join(path.dirname(getDbFilePath()), 'backups')
}

function backupNow(): void {
  const dbPath = getDbFilePath()
  if (!fs.existsSync(dbPath)) return

  const backupDir = getBackupDir()
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `tasks-${timestamp}.db`)

  fs.copyFileSync(dbPath, backupPath)
  lastBackupAt = Date.now()
  console.log(`Backup created: ${backupPath}`)

  // Cleanup old backups
  cleanupBackups()
}

function cleanupBackups(): void {
  const backupDir = getBackupDir()
  if (!fs.existsSync(backupDir)) return

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('tasks-') && f.endsWith('.db'))
    .sort()

  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift()!
    fs.unlinkSync(path.join(backupDir, oldest))
  }
}

export function startBackupService(): void {
  // Run initial backup
  backupNow()

  // Schedule hourly backups
  setInterval(backupNow, BACKUP_INTERVAL_MS)
}

export function getLastBackupAt(): number | null {
  return lastBackupAt
}
