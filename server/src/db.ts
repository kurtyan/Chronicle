import Database from 'better-sqlite3'
import { getDbPath, ensureDataDir } from './config'
import { getLogger } from './logging'

let db: Database.Database | null = null

export function initDb() {
  ensureDataDir()
  const dbPath = getDbPath()

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 100')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      tags TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      due_date INTEGER
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_entries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'log',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `)

  let ftsSchemaChanged = false
  const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks_fts'").get()
  if (ftsExists) {
    const columns = db.prepare("PRAGMA table_info('tasks_fts')").all() as Array<{ name: string }>
    if (!columns.some((col) => col.name === 'entry_id')) {
      db.exec('DROP TABLE tasks_fts')
      ftsSchemaChanged = true
    }
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      task_id,
      entry_id,
      source,
      content,
      tokenize = 'unicode61'
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS afk_events (
      id TEXT PRIMARY KEY,
      triggered_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      user_note TEXT,
      submitted_at INTEGER
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_extra_info (
      task_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (task_id, key)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_item_details (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL UNIQUE,
      plan_date TEXT NOT NULL,
      estimated_minutes INTEGER NOT NULL,
      estimated_start TEXT,
      estimated_end TEXT,
      actual_started_at INTEGER,
      actual_completed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'PLANNED',
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (entry_id) REFERENCES task_entries(id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_call_logs (
      id TEXT PRIMARY KEY,
      feature TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      model TEXT,
      base_url TEXT,
      request_input TEXT NOT NULL,
      request_messages TEXT NOT NULL,
      raw_response TEXT,
      parsed_output TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      linked_task_id TEXT,
      linked_entry_id TEXT
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  if (ftsSchemaChanged) {
    db.prepare('DELETE FROM _meta WHERE key = ?').run('fts_tokenizer_version')
  }

  cleanupOrphans()
  db.pragma('foreign_keys = ON')

  getLogger().info(`Database initialized: ${dbPath}`)
}

function cleanupOrphans(): void {
  getDb().exec(`
    DELETE FROM plan_item_details
    WHERE entry_id NOT IN (SELECT id FROM task_entries);

    DELETE FROM work_sessions
    WHERE task_id NOT IN (SELECT id FROM tasks);

    DELETE FROM task_extra_info
    WHERE task_id NOT IN (SELECT id FROM tasks);
  `)
}

export function getMetaValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM _meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMetaValue(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO _meta(key, value) VALUES (?, ?)').run(key, value)
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function getDbFilePath(): string {
  return getDbPath()
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
