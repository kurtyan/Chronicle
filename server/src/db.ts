import initSqlJs, { type Database } from 'sql.js'
import path from 'path'
import fs from 'fs'

const dbDir = path.join(process.cwd(), 'data')
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

const dbPath = path.join(dbDir, 'tasks.db')

let db: Database

export async function initDb() {
  const SQL = await initSqlJs()

  if (fs.existsSync(dbPath)) {
    // Migrate: add updated_at column if missing
    db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
    try {
      db.run('ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')
      db.run('UPDATE tasks SET updated_at = created_at WHERE updated_at = 0')
      saveDb()
      console.log('Migration: added updated_at column')
    } catch {
      // Column already exists or no tasks table yet
    }
    return
  }

  db = new SQL.Database()

  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS task_entries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'log',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `)

  saveDb()
  console.log('Database initialized:', dbPath)
}

export function saveDb() {
  const data = db.export()
  const buffer = Buffer.from(data)
  fs.writeFileSync(dbPath, buffer)
}

export function getDb() {
  return db
}
