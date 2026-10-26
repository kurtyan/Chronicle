import type Database from 'better-sqlite3'

/** Additive, repeatable migration. It never opens a database or starts a worker. */
export function initTaskDailySummarySchema(db: Database.Database): void {
  db.transaction(() => {
    const columns = new Set((db.prepare('PRAGMA table_info(task_entries)').all() as Array<{ name: string }>).map(column => column.name))
    const additions: Record<string, string> = {
      updated_at: 'INTEGER NOT NULL DEFAULT 0',
      revision: 'INTEGER NOT NULL DEFAULT 1',
      work_date: 'TEXT',
      work_date_source: "TEXT NOT NULL DEFAULT 'recorded'",
      source_kind: "TEXT NOT NULL DEFAULT 'manual'",
      source_id: 'TEXT',
      source_started_at: 'INTEGER',
      source_ended_at: 'INTEGER',
    }
    for (const [name, definition] of Object.entries(additions)) if (!columns.has(name)) db.exec(`ALTER TABLE task_entries ADD COLUMN ${name} ${definition}`)
    db.exec(`
      UPDATE task_entries SET updated_at=created_at WHERE updated_at=0;
      CREATE INDEX IF NOT EXISTS idx_task_daily_entries_date ON task_entries(task_id,work_date,created_at,id);
      CREATE INDEX IF NOT EXISTS idx_task_daily_entries_recorded ON task_entries(task_id,created_at,id);
      CREATE INDEX IF NOT EXISTS idx_task_daily_sessions ON work_sessions(task_id,started_at);

      CREATE TABLE IF NOT EXISTS task_daily_summaries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        work_date TEXT NOT NULL,
        calendar_policy_id TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        summary_text TEXT NOT NULL,
        content_kind TEXT NOT NULL CHECK(content_kind IN ('llm','time_only','empty')),
        input_fingerprint TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        source_entry_ids_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        prompt_version TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        generated_at INTEGER NOT NULL,
        llm_call_log_id TEXT,
        UNIQUE(task_id,work_date,calendar_policy_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_daily_summary_calendar ON task_daily_summaries(calendar_policy_id,task_id,work_date);

      CREATE TABLE IF NOT EXISTS task_daily_summary_jobs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        work_date TEXT NOT NULL,
        calendar_policy_id TEXT NOT NULL,
        requested_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','idle','failed','waiting_config','waiting_budget')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE(task_id,work_date,calendar_policy_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_daily_job_due ON task_daily_summary_jobs(state,next_attempt_at,lease_expires_at);

      CREATE TABLE IF NOT EXISTS task_daily_summary_budget (
        calendar_policy_id TEXT NOT NULL,
        work_date TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(calendar_policy_id,work_date)
      );

      CREATE TABLE IF NOT EXISTS task_daily_summary_chunks (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        work_date TEXT NOT NULL,
        calendar_policy_id TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        stage TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        source_entry_ids_json TEXT NOT NULL,
        llm_call_log_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id,work_date,calendar_policy_id,input_fingerprint,chunk_hash)
      );

      CREATE TRIGGER IF NOT EXISTS task_daily_entry_insert_metadata AFTER INSERT ON task_entries
      WHEN NEW.updated_at=0
      BEGIN
        UPDATE task_entries SET updated_at=NEW.created_at WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS task_daily_entry_revision AFTER UPDATE OF content,type,created_at,work_date,work_date_source,source_kind,source_id,source_started_at,source_ended_at ON task_entries
      WHEN OLD.content IS NOT NEW.content OR OLD.type IS NOT NEW.type OR OLD.created_at IS NOT NEW.created_at
        OR OLD.work_date IS NOT NEW.work_date OR OLD.work_date_source IS NOT NEW.work_date_source
        OR OLD.source_kind IS NOT NEW.source_kind OR OLD.source_id IS NOT NEW.source_id
        OR OLD.source_started_at IS NOT NEW.source_started_at OR OLD.source_ended_at IS NOT NEW.source_ended_at
      BEGIN
        UPDATE task_entries SET revision=OLD.revision+1,
          updated_at=MAX(OLD.updated_at+1,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) WHERE id=NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS task_daily_focus_sync_insert AFTER INSERT ON day_script_progress_syncs
      WHEN NEW.last_entry_id IS NOT NULL
      BEGIN
        UPDATE task_entries SET work_date=(SELECT script_date FROM day_script_blocks WHERE id=NEW.block_id),
          work_date_source='focus',source_kind='focus',source_id=NEW.block_id
        WHERE id=NEW.last_entry_id AND work_date_source!='explicit';
      END;
      CREATE TRIGGER IF NOT EXISTS task_daily_focus_sync_update AFTER UPDATE OF last_entry_id ON day_script_progress_syncs
      WHEN NEW.last_entry_id IS NOT NULL
      BEGIN
        UPDATE task_entries SET work_date=(SELECT script_date FROM day_script_blocks WHERE id=NEW.block_id),
          work_date_source='focus',source_kind='focus',source_id=NEW.block_id
        WHERE id=NEW.last_entry_id AND work_date_source!='explicit';
      END;
      CREATE TRIGGER IF NOT EXISTS task_daily_focus_execution_insert AFTER INSERT ON day_script_execution_records
      BEGIN
        UPDATE task_entries SET work_date=NEW.script_date,work_date_source='focus',source_kind='focus',source_id=NEW.block_id
        WHERE id=NEW.progress_entry_id AND work_date_source!='explicit';
      END;
      CREATE TRIGGER IF NOT EXISTS task_daily_meeting_source_insert AFTER INSERT ON task_extra_info
      WHEN NEW.key='meeting_source' AND NEW.value='manual_record'
      BEGIN
        UPDATE task_entries SET source_kind='meeting',source_id=NEW.task_id,
          source_started_at=(SELECT started_at FROM tasks WHERE id=NEW.task_id),
          source_ended_at=(SELECT completed_at FROM tasks WHERE id=NEW.task_id)
        WHERE task_id=NEW.task_id AND type='body';
      END;
    `)

    // Only structured source links can repair dates. Never infer a date from prose.
    db.exec(`
      UPDATE task_entries SET work_date=(SELECT r.script_date FROM day_script_execution_records r WHERE r.progress_entry_id=task_entries.id LIMIT 1),
        work_date_source='focus',source_kind='focus',source_id=(SELECT r.block_id FROM day_script_execution_records r WHERE r.progress_entry_id=task_entries.id LIMIT 1)
      WHERE work_date_source='recorded' AND EXISTS(SELECT 1 FROM day_script_execution_records r WHERE r.progress_entry_id=task_entries.id);
      UPDATE task_entries SET work_date=(SELECT b.script_date FROM day_script_progress_syncs s JOIN day_script_blocks b ON b.id=s.block_id WHERE s.last_entry_id=task_entries.id LIMIT 1),
        work_date_source='focus',source_kind='focus',source_id=(SELECT s.block_id FROM day_script_progress_syncs s WHERE s.last_entry_id=task_entries.id LIMIT 1)
      WHERE work_date_source='recorded' AND EXISTS(SELECT 1 FROM day_script_progress_syncs s WHERE s.last_entry_id=task_entries.id);
      UPDATE task_entries SET source_kind='meeting',source_id=task_id,
        source_started_at=(SELECT started_at FROM tasks WHERE id=task_entries.task_id),
        source_ended_at=(SELECT completed_at FROM tasks WHERE id=task_entries.task_id)
      WHERE type='body' AND source_kind='manual' AND EXISTS(SELECT 1 FROM task_extra_info x WHERE x.task_id=task_entries.task_id AND x.key='meeting_source' AND x.value='manual_record');
    `)
  })()
}
