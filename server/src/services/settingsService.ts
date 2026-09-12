import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { getDbFilePath, getDb, closeDb, initDb } from '../db'
import { getLastBackupAt } from './backupService'
import { createStoredZip, readStoredZip, type ZipEntry } from './backupBundle'
import { evidenceFingerprint, refreshReviewEvidenceFingerprint } from './reviewEvidenceService'
import { htmlToPlainText } from './searchText'
import type { ReviewEvidence } from '../../../shared/projectReviewTypes'

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
  // Replace decoded values, never serialized JSON: destination quotes/backslashes
  // must be escaped by JSON.stringify rather than injected into its syntax.
  const replacements = new Map<string, string>([
    [sourceAttachmentDir, targetAttachmentDir],
    [encodeURI(sourceAttachmentDir), encodeURI(targetAttachmentDir)],
    [encodeURIComponent(sourceAttachmentDir), encodeURIComponent(targetAttachmentDir)],
  ])
  // Identical encodings of a simple source path should retain the raw destination
  // for plain text; quoted HTML attributes are escaped separately below.
  replacements.set(sourceAttachmentDir, targetAttachmentDir)
  const escaped = [...replacements.keys()].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?:${escaped.join('|')})(?=$|[/\\\\\\s"'<>?#&]|%2[fF]|%5[cC])`, 'g')
  const rewriteText = (value: string, fileUrl = false) => value.replace(pattern, match => fileUrl && (match === sourceAttachmentDir || match === encodeURI(sourceAttachmentDir)) ? encodeURI(targetAttachmentDir) : replacements.get(match)!)
  const decodeHtml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' } as Record<string, string>)[entity.toLowerCase()] ?? match
  })
  const escapeHtml = (value: string, quote?: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(quote === "'" ? /'/g : /"/g, quote === "'" ? '&#39;' : '&quot;')
  const rewriteHtmlText = (value: string, quote?: string, fileUrl = false) => {
    const decoded = decodeHtml(value), rewritten = rewriteText(decoded, fileUrl)
    return decoded === rewritten ? value : escapeHtml(rewritten, quote)
  }
  const rewriteHtml = (value: string) => value.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/g).map(part => part.startsWith('<')
    ? part.replace(/(\s[\w:-]+\s*=\s*)(["'])([\s\S]*?)\2/g, (_match, prefix: string, quote: string, content: string) => `${prefix}${quote}${rewriteHtmlText(content, quote, /^\s*(?:href|src)\s*=/i.test(prefix) && /^(?:file|chronicle-attachment):\/\//i.test(content))}${quote}`)
    : rewriteHtmlText(part)).join('')
  const mapJson = (value: any, key = ''): any => {
    if (Array.isArray(value)) return value.map(item => mapJson(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapJson(item, name)]))
    if (typeof value !== 'string') return value
    // Evidence event/task content can itself contain serialized JSON (including
    // before_json/after_json). Decode each layer so escaped source paths also move.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value), mapped = mapJson(parsed)
        return JSON.stringify(mapped) === JSON.stringify(parsed) ? value : JSON.stringify(mapped)
      } catch { /* Ordinary text that starts with a bracket is not structured JSON. */ }
    }
    return ['contentHtml', 'content_html'].includes(key) || /^\s*<(?:p|div|a|img|h[1-6]|ul|ol|pre|blockquote)\b/i.test(value)
      ? rewriteHtml(value) : rewriteText(value, ['href', 'src'].includes(key) && /^(?:file|chronicle-attachment):\/\//i.test(value))
  }
  const mapEvidence = (original: ReviewEvidence): ReviewEvidence => {
    const evidence = mapJson(original) as ReviewEvidence
    for (const source of evidence.sources) {
      if ((source.kind === 'task_entry' || source.kind === 'note') && source.contentHtml !== undefined) source.content = htmlToPlainText(source.contentHtml)
    }
    // Preserve frozen source versions, scope, metrics, coverage and model output;
    // only physical attachment locations and hashes derived from them change.
    return refreshReviewEvidenceFingerprint(evidence)
  }
  const database = new Database(databasePath)
  try {
    const htmlColumns: Array<[string, string]> = [
      ['task_entries', 'content'],
      ['task_log_drafts', 'content'],
      ['notes', 'content_html'],
      ['project_review_versions', 'content_html'],
    ]
    const jsonColumns: Array<[string, string]> = [
      ['day_scripts', 'document_json'],
      ['project_events', 'before_json'],
      ['project_events', 'after_json'],
      ['project_review_versions', 'evidence_json'],
      ['project_insight_drafts', 'evidence_json'],
      ['project_insight_drafts', 'content_json'],
    ]
    const textColumns: Array<[string, string]> = [
      ['tasks', 'title'], ['notes', 'title'], ['project_review_versions', 'title'],
      ['areas', 'name'], ['areas', 'description'], ['areas', 'focus'],
      ['milestones', 'name'], ['milestones', 'goal'], ['milestones', 'completion_criteria'],
      ['milestones', 'latest_progress'], ['milestones', 'next_step'], ['milestones', 'blockers'],
    ]
    database.transaction(() => {
      for (const [table, column] of textColumns) {
        if (!tableExists(database, table)) continue
        const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`)
        for (const row of database.prepare(`SELECT rowid AS row_id,${column} AS content FROM ${table} WHERE ${column} IS NOT NULL`).all() as any[]) {
          const rewritten = rewriteText(row.content)
          if (rewritten !== row.content) update.run(rewritten, row.row_id)
        }
      }
      for (const [table, column] of htmlColumns) {
        if (!tableExists(database, table)) continue
        const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`)
        for (const row of database.prepare(`SELECT rowid AS row_id,${column} AS content FROM ${table} WHERE ${column} IS NOT NULL`).all() as any[]) {
          const rewritten = rewriteHtml(row.content)
          if (rewritten !== row.content) update.run(rewritten, row.row_id)
        }
      }
      for (const [table, column] of jsonColumns) {
        if (!tableExists(database, table)) continue
        const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`)
        for (const row of database.prepare(`SELECT rowid AS row_id,${column} AS content FROM ${table} WHERE ${column} IS NOT NULL`).all() as any[]) {
          let parsed: any
          try { parsed = JSON.parse(row.content) } catch { throw new Error(`Invalid backup JSON in ${table}.${column}`) }
          const mapped = column === 'evidence_json' ? mapEvidence(parsed) : mapJson(parsed)
          if (JSON.stringify(mapped) !== JSON.stringify(parsed)) update.run(JSON.stringify(mapped), row.row_id)
        }
      }
      if (tableExists(database, 'project_insight_drafts')) {
        const update = database.prepare('UPDATE project_insight_drafts SET request_key=? WHERE id=?')
        for (const row of database.prepare('SELECT id,evidence_json,model,prompt_version,budget_json FROM project_insight_drafts').all() as any[]) {
          const evidence = JSON.parse(row.evidence_json)
          update.run(evidenceFingerprint({ scope: evidence.scope, fingerprint: evidence.fingerprint, model: row.model, budget: JSON.parse(row.budget_json), promptVersion: row.prompt_version }), row.id)
        }
      }
    })()
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
    rewriteAttachmentPaths(stagedPath, imported.sourceAttachmentDir, attachmentDir)
  } catch (error) {
    fs.rmSync(stagedPath, { force: true })
    if (imported.attachmentStagePath) fs.rmSync(imported.attachmentStagePath, { recursive: true, force: true })
    throw error
  }

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
