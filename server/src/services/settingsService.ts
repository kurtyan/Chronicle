import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { getDbFilePath, getDb, closeDb, initDb } from '../db'
import { getLastBackupAt } from './backupService'
import { createStoredZip, readStoredZip, type ZipEntry } from './backupBundle'

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0')
const BACKUP_FORMAT = 'chronicle-backup'
const BACKUP_VERSION = 1

function getAttachmentDir(): string {
  return process.env.CHRONICLE_ATTACHMENT_DIR ?? path.join(path.dirname(getDbFilePath()), 'attachment')
}

function collectAttachmentEntries(directory: string, relative = ''): ZipEntry[] {
  if (!fs.existsSync(directory)) return []
  const entries: ZipEntry[] = []
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const nextRelative = relative ? `${relative}/${item.name}` : item.name
    const nextPath = path.join(directory, item.name)
    if (item.isDirectory()) {
      entries.push(...collectAttachmentEntries(nextPath, nextRelative))
    } else if (item.isFile()) {
      entries.push({ name: `attachments/${nextRelative}`, data: fs.readFileSync(nextPath) })
    }
    // Do not follow symlinks into arbitrary user files.
  }
  return entries
}

function isSqliteDatabase(fileBuffer: Buffer): boolean {
  return fileBuffer.length >= SQLITE_MAGIC.length && fileBuffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function rewriteAttachmentPaths(databasePath: string, sourceAttachmentDir: string | undefined, targetAttachmentDir: string): void {
  if (!sourceAttachmentDir || path.resolve(sourceAttachmentDir) === path.resolve(targetAttachmentDir)) return
  const database = new Database(databasePath)
  try {
    const columns: Array<[string, string]> = [
      ['task_entries', 'content'],
      ['task_log_drafts', 'content'],
      ['notes', 'content_html'],
      ['day_scripts', 'document_json'],
    ]
    for (const [table, column] of columns) {
      if (!tableExists(database, table)) continue
      database.prepare(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE INSTR(${column}, ?) > 0`)
        .run(sourceAttachmentDir, targetAttachmentDir, sourceAttachmentDir)
    }
  } finally {
    database.close()
  }
}

interface ImportedBackup {
  database: Buffer
  attachmentStagePath: string | null
  sourceAttachmentDir?: string
}

function prepareBundleImport(fileBuffer: Buffer, targetAttachmentDir: string): ImportedBackup {
  const entries = readStoredZip(fileBuffer)
  const manifestEntry = entries.get('manifest.json')
  const database = entries.get('database/tasks.db')
  if (!manifestEntry || !database) throw new Error('Invalid Chronicle backup bundle')
  let manifest: { format?: string; version?: number; attachmentDir?: string }
  try {
    manifest = JSON.parse(manifestEntry.toString('utf8'))
  } catch {
    throw new Error('Invalid Chronicle backup manifest')
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION || !isSqliteDatabase(database)) {
    throw new Error('Unsupported Chronicle backup bundle')
  }
  if (manifest.attachmentDir !== undefined && typeof manifest.attachmentDir !== 'string') {
    throw new Error('Invalid Chronicle backup manifest')
  }

  const parent = path.dirname(targetAttachmentDir)
  fs.mkdirSync(parent, { recursive: true })
  const stagePath = fs.mkdtempSync(path.join(parent, '.attachments-import-'))
  try {
    for (const [name, data] of entries) {
      if (!name.startsWith('attachments/')) continue
      const relative = name.slice('attachments/'.length)
      if (!relative) continue
      const outputPath = path.join(stagePath, ...relative.split('/'))
      if (!outputPath.startsWith(`${stagePath}${path.sep}`)) throw new Error('Unsafe backup attachment path')
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, data, { flag: 'wx' })
    }
    return { database, attachmentStagePath: stagePath, sourceAttachmentDir: manifest.attachmentDir }
  } catch (error) {
    fs.rmSync(stagePath, { recursive: true, force: true })
    throw error
  }
}

export async function exportDatabase(): Promise<{ fileName: string; data: Buffer }> {
  const dbPath = getDbFilePath()
  const snapshotDir = fs.mkdtempSync(path.join(path.dirname(dbPath), '.export-'))
  const snapshotPath = path.join(snapshotDir, path.basename(dbPath))
  try {
    // The live database is in WAL mode. Copying only the main db file silently
    // loses transactions that have not yet been checkpointed, so always ask
    // SQLite to create a consistent snapshot first.
    await getDb().backup(snapshotPath)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const attachmentDir = getAttachmentDir()
    const manifest = Buffer.from(JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      attachmentDir,
    }, null, 2))
    const data = createStoredZip([
      { name: 'manifest.json', data: manifest },
      { name: 'database/tasks.db', data: fs.readFileSync(snapshotPath) },
      ...collectAttachmentEntries(attachmentDir),
    ])
    return { fileName: `chronicle-backup-${timestamp}.zip`, data }
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true })
  }
}

export async function importDatabase(fileBuffer: Buffer): Promise<{ success: string }> {
  const dbPath = getDbFilePath()
  const dbDir = path.dirname(dbPath)
  const attachmentDir = getAttachmentDir()
  const imported = isSqliteDatabase(fileBuffer)
    ? { database: fileBuffer, attachmentStagePath: null }
    : prepareBundleImport(fileBuffer, attachmentDir)
  const stagedPath = path.join(dbDir, `.import-${crypto.randomUUID()}.db`)
  const backupDir = path.join(path.dirname(dbPath), 'backups')
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })

  try {
    fs.writeFileSync(stagedPath, imported.database)
    const staged = new Database(stagedPath, { readonly: true })
    try {
      const integrity = staged.pragma('integrity_check', { simple: true })
      if (integrity !== 'ok') throw new Error(`Invalid SQLite database integrity: ${integrity}`)
    } finally {
      staged.close()
    }
  } catch (error) {
    fs.rmSync(stagedPath, { force: true })
    if (imported.attachmentStagePath) fs.rmSync(imported.attachmentStagePath, { recursive: true, force: true })
    throw error
  }

  rewriteAttachmentPaths(stagedPath, imported.sourceAttachmentDir, attachmentDir)

  // Pre-import backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `tasks-pre-import-${timestamp}.db`)
  await getDb().backup(backupPath)

  // Replace only a pre-validated staged file. Keep the former live file until
  // initDb succeeds so a malformed-but-SQLite-looking import is recoverable.
  const previousPath = path.join(backupDir, `tasks-live-pre-import-${timestamp}.db`)
  const previousAttachmentPath = `${attachmentDir}.live-pre-import-${timestamp}`
  let attachmentReplaced = false
  closeDb()
  try {
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, previousPath)
    fs.rmSync(`${dbPath}-wal`, { force: true })
    fs.rmSync(`${dbPath}-shm`, { force: true })
    fs.renameSync(stagedPath, dbPath)
    if (imported.attachmentStagePath) {
      if (fs.existsSync(attachmentDir)) fs.renameSync(attachmentDir, previousAttachmentPath)
      fs.renameSync(imported.attachmentStagePath, attachmentDir)
      attachmentReplaced = true
    }
    initDb()
    fs.rmSync(previousPath, { force: true })
  } catch (error) {
    closeDb()
    fs.rmSync(dbPath, { force: true })
    if (fs.existsSync(previousPath)) fs.renameSync(previousPath, dbPath)
    if (attachmentReplaced) fs.rmSync(attachmentDir, { recursive: true, force: true })
    if (fs.existsSync(previousAttachmentPath)) fs.renameSync(previousAttachmentPath, attachmentDir)
    initDb()
    throw error
  } finally {
    fs.rmSync(stagedPath, { force: true })
    if (imported.attachmentStagePath) fs.rmSync(imported.attachmentStagePath, { recursive: true, force: true })
  }
  // The new database and attachment directory are live. Removing the old
  // attachment tree is best-effort; a failure here must not roll back a valid
  // completed import.
  fs.rmSync(previousAttachmentPath, { recursive: true, force: true })

  return { success: imported.attachmentStagePath ? 'Backup bundle imported successfully' : 'Database imported successfully' }
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
