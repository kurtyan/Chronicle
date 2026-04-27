import fs from 'fs'
import path from 'path'
import { getDb, getDbFilePath } from '../db'
import { getLogger } from '../logging'

const BACKUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const MAX_BACKUPS = 24

let lastBackupAt: number | null = null
let backupInProgress = false

function getBackupDir(): string {
  return path.join(path.dirname(getDbFilePath()), 'backups')
}

async function backupNow(): Promise<void> {
  if (backupInProgress) return
  backupInProgress = true

  try {
    const backupDir = getBackupDir()
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = path.join(backupDir, `tasks-${timestamp}.db`)

    await getDb().backup(backupPath)
    lastBackupAt = Date.now()
    getLogger().info(`Backup created: ${backupPath}`)

    cleanupBackups()
  } catch (err) {
    getLogger().error(`Backup failed: ${err}`)
  } finally {
    backupInProgress = false
  }
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
