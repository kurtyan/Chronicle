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
    CREATE TABLE IF NOT EXISTS task_log_drafts (
      task_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
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
      raw_provider_response TEXT,
      raw_response TEXT,
      finish_reason TEXT,
      parsed_output TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      linked_task_id TEXT,
      linked_entry_id TEXT
    )
  `)
  const llmCallLogColumns = db.prepare("PRAGMA table_info('llm_call_logs')").all() as Array<{ name: string }>
  if (!llmCallLogColumns.some((column) => column.name === 'raw_provider_response')) {
    db.exec('ALTER TABLE llm_call_logs ADD COLUMN raw_provider_response TEXT')
  }
  if (!llmCallLogColumns.some((column) => column.name === 'finish_reason')) {
    db.exec('ALTER TABLE llm_call_logs ADD COLUMN finish_reason TEXT')
  }

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
      last_entry_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (block_id, task_id),
      FOREIGN KEY (block_id) REFERENCES day_script_blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (last_entry_id) REFERENCES task_entries(id) ON DELETE SET NULL
    )
  `)
  const progressSyncColumns = db.prepare("PRAGMA table_info('day_script_progress_syncs')").all() as Array<{ name: string }>
  if (!progressSyncColumns.some((column) => column.name === 'synced_progress_html')) {
    db.exec("ALTER TABLE day_script_progress_syncs ADD COLUMN synced_progress_html TEXT NOT NULL DEFAULT ''")
  }
  migrateDayScriptProgressSyncs()

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
      recommended_next_step TEXT NOT NULL DEFAULT '',
      summary_updated_at INTEGER NOT NULL,
      error_message TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `)
  const taskProgressSummaryColumns = db.prepare("PRAGMA table_info('task_progress_summaries')").all() as Array<{ name: string }>
  if (!taskProgressSummaryColumns.some((column) => column.name === 'recommended_next_step')) {
    db.exec("ALTER TABLE task_progress_summaries ADD COLUMN recommended_next_step TEXT NOT NULL DEFAULT ''")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS day_script_daily_summaries (
      script_date TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      llm_call_log_id TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (llm_call_log_id) REFERENCES llm_call_logs(id) ON DELETE SET NULL
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

    DELETE FROM task_log_drafts
    WHERE task_id NOT IN (SELECT id FROM tasks);

    DELETE FROM work_sessions
    WHERE task_id NOT IN (SELECT id FROM tasks);

    DELETE FROM task_extra_info
    WHERE task_id NOT IN (SELECT id FROM tasks);

    DELETE FROM day_script_block_tasks
    WHERE block_id NOT IN (SELECT id FROM day_script_blocks)
       OR task_id NOT IN (SELECT id FROM tasks);

    UPDATE day_script_progress_syncs
    SET last_entry_id = NULL
    WHERE last_entry_id IS NOT NULL
      AND last_entry_id NOT IN (SELECT id FROM task_entries);

    DELETE FROM day_script_progress_syncs
    WHERE block_id NOT IN (SELECT id FROM day_script_blocks)
       OR task_id NOT IN (SELECT id FROM tasks);

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

function migrateDayScriptProgressSyncs(): void {
  const db = getDb()
  const columns = db.prepare("PRAGMA table_info('day_script_progress_syncs')").all() as Array<{ name: string; notnull: number }>
  const lastEntryColumn = columns.find((column) => column.name === 'last_entry_id')
  const foreignKeys = db.prepare("PRAGMA foreign_key_list('day_script_progress_syncs')").all() as Array<{ from: string; on_delete: string }>
  const lastEntryForeignKey = foreignKeys.find((key) => key.from === 'last_entry_id')
  if (lastEntryColumn?.notnull === 0 && lastEntryForeignKey?.on_delete?.toUpperCase() === 'SET NULL') return

  db.exec(`
    PRAGMA foreign_keys = OFF;

    DROP TABLE IF EXISTS day_script_progress_syncs_next;

    CREATE TABLE IF NOT EXISTS day_script_progress_syncs_next (
      block_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      synced_progress TEXT NOT NULL,
      synced_progress_html TEXT NOT NULL DEFAULT '',
      last_entry_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (block_id, task_id),
      FOREIGN KEY (block_id) REFERENCES day_script_blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (last_entry_id) REFERENCES task_entries(id) ON DELETE SET NULL
    );

    INSERT OR REPLACE INTO day_script_progress_syncs_next (
      block_id, task_id, synced_progress, synced_progress_html, last_entry_id, updated_at
    )
    SELECT
      block_id,
      task_id,
      synced_progress,
      COALESCE(synced_progress_html, ''),
      CASE WHEN last_entry_id IN (SELECT id FROM task_entries) THEN last_entry_id ELSE NULL END,
      updated_at
    FROM day_script_progress_syncs
    WHERE block_id IN (SELECT id FROM day_script_blocks)
      AND task_id IN (SELECT id FROM tasks);

    DROP TABLE day_script_progress_syncs;
    ALTER TABLE day_script_progress_syncs_next RENAME TO day_script_progress_syncs;

    PRAGMA foreign_keys = ON;
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
