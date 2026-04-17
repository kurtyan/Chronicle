import fs from 'fs'
import path from 'path'
import { getDbFilePath, getDb, closeDb, initDb } from '../db'
import { getLastBackupAt } from './backupService'

export function exportDatabase(): { path: string; data: Buffer } {
  const dbPath = getDbFilePath()
  const data = fs.readFileSync(dbPath)
  return { path: dbPath, data }
}

export async function importDatabase(fileBuffer: Buffer): Promise<{ success: string }> {
  // Validate SQLite magic bytes: "SQLite format 3\0"
  const magic = fileBuffer.slice(0, 16).toString('utf8')
  if (magic !== 'SQLite format 3\0') {
    throw new Error('Invalid SQLite database file')
  }

  const dbPath = getDbFilePath()
  const backupDir = path.join(path.dirname(dbPath), 'backups')
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })

  // Pre-import backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `tasks-pre-import-${timestamp}.db`)
  fs.copyFileSync(dbPath, backupPath)

  // Close current connection, replace file, re-initialize
  closeDb()
  fs.writeFileSync(dbPath, fileBuffer)
  initDb()

  return { success: 'Database imported successfully' }
}

export function getSettingsInfo() {
  const dbPath = getDbFilePath()
  let size = 0
  try {
    size = fs.statSync(dbPath).size
  } catch {
    // File doesn't exist yet
  }

  return {
    dbPath,
    dbSize: size,
    lastBackupAt: getLastBackupAt(),
  }
}
