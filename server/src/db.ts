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
    CREATE TABLE IF NOT EXISTS day_scripts (
      script_date TEXT PRIMARY KEY,
      document_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS day_script_blocks (
      id TEXT PRIMARY KEY,
      script_date TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      header_text TEXT NOT NULL,
      progress_text TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (script_date) REFERENCES day_scripts(script_date) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS day_script_block_tasks (
      block_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      PRIMARY KEY (block_id, task_id),
      FOREIGN KEY (block_id) REFERENCES day_script_blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS day_script_progress_syncs (
      block_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      synced_progress TEXT NOT NULL,
      synced_progress_html TEXT NOT NULL DEFAULT '',
      last_entry_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (block_id, task_id),
      FOREIGN KEY (block_id) REFERENCES day_script_blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (last_entry_id) REFERENCES task_entries(id) ON DELETE CASCADE
    )
  `)
  const progressSyncColumns = db.prepare("PRAGMA table_info('day_script_progress_syncs')").all() as Array<{ name: string }>
  if (!progressSyncColumns.some((column) => column.name === 'synced_progress_html')) {
    db.exec("ALTER TABLE day_script_progress_syncs ADD COLUMN synced_progress_html TEXT NOT NULL DEFAULT ''")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS day_script_execution_records (
      id TEXT PRIMARY KEY,
      script_date TEXT NOT NULL,
      block_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      progress_entry_id TEXT NOT NULL,
      work_session_id TEXT,
      planned_start_at INTEGER NOT NULL,
      planned_end_at INTEGER NOT NULL,
      actual_started_at INTEGER NOT NULL,
      actual_completed_at INTEGER NOT NULL,
      planned_minutes INTEGER NOT NULL,
      actual_minutes INTEGER NOT NULL,
      start_delay_minutes INTEGER NOT NULL,
      overrun_minutes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (block_id) REFERENCES day_script_blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (progress_entry_id) REFERENCES task_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (work_session_id) REFERENCES work_sessions(id) ON DELETE SET NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_progress_summaries (
      task_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      latest_progress TEXT NOT NULL,
      next_step TEXT NOT NULL,
      summary_updated_at INTEGER NOT NULL,
      error_message TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
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

    DELETE FROM day_script_block_tasks
    WHERE block_id NOT IN (SELECT id FROM day_script_blocks)
       OR task_id NOT IN (SELECT id FROM tasks);

    DELETE FROM day_script_progress_syncs
    WHERE block_id NOT IN (SELECT id FROM day_script_blocks)
       OR task_id NOT IN (SELECT id FROM tasks)
       OR last_entry_id NOT IN (SELECT id FROM task_entries);

    UPDATE day_script_execution_records
    SET work_session_id = NULL
    WHERE work_session_id IS NOT NULL
      AND work_session_id NOT IN (SELECT id FROM work_sessions);

    DELETE FROM day_script_execution_records
    WHERE block_id NOT IN (SELECT id FROM day_script_blocks)
       OR task_id NOT IN (SELECT id FROM tasks)
       OR progress_entry_id NOT IN (SELECT id FROM task_entries);

    DELETE FROM day_script_blocks
    WHERE script_date NOT IN (SELECT script_date FROM day_scripts);

    DELETE FROM day_script_execution_records
    WHERE block_id NOT IN (SELECT id FROM day_script_blocks)
       OR task_id NOT IN (SELECT id FROM tasks)
       OR progress_entry_id NOT IN (SELECT id FROM task_entries);

    DELETE FROM task_progress_summaries
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
