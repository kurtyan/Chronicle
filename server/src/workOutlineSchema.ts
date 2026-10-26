import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export const WORK_OUTLINE_EPOCH_KEY = 'work_outline_epoch'

export function initWorkOutlineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_outlines (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, document_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_outline_requests (
      outline_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (outline_id, request_key)
    );
  `)
  // Reopening the same database preserves this identity. Import explicitly
  // rotates it even when a backup contains an earlier copy of the same value.
  db.prepare('INSERT OR IGNORE INTO _meta(key,value) VALUES(?,?)').run(WORK_OUTLINE_EPOCH_KEY, randomUUID())
}
