import Database from 'better-sqlite3'
import { getDbPath, ensureDataDir } from './config'

let db: Database.Database | null = null

export function initDb() {
  ensureDataDir()
  const dbPath = getDbPath()

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

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

  console.log('Database initialized:', dbPath)
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
