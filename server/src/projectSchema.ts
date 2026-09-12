import type Database from 'better-sqlite3'
import fs from 'fs'

/** Additive migration; source records and historic work sessions remain untouched. */
export function initProjectSchema(db: Database.Database): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='areas'").get()
  if (!exists && db.name && db.name !== ':memory:' && fs.existsSync(db.name)) {
    const hasData = db.prepare('SELECT 1 FROM tasks LIMIT 1').get() || db.prepare('SELECT 1 FROM notes LIMIT 1').get()
    if (hasData) db.prepare('VACUUM INTO ?').run(`${db.name}.before-projects-${Date.now()}.db`)
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS areas (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', focus TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','ended')),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES areas(id), name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'stage' CHECK(kind IN ('stage','ongoing')),
        goal TEXT NOT NULL DEFAULT '', completion_criteria TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','paused','completed','cancelled','ended')),
        priority TEXT, target_date INTEGER, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1, latest_progress TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '', blockers TEXT NOT NULL DEFAULT '',
        completed_at INTEGER, completion_event_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK((kind='ongoing' AND status NOT IN ('completed','cancelled')) OR (kind='stage' AND status!='ended'))
      );
      CREATE INDEX IF NOT EXISTS idx_milestones_area ON milestones(area_id,archived,updated_at DESC);
    `)
    for (const [table, column, definition] of [
      ['tasks', 'primary_milestone_id', 'TEXT REFERENCES milestones(id)'],
      ['tasks', 'project_revision', 'INTEGER NOT NULL DEFAULT 1'],
      ['notes', 'project_revision', 'INTEGER NOT NULL DEFAULT 1'],
      ['milestones', 'start_date', 'INTEGER'],
      ['areas', 'latest_progress', "TEXT NOT NULL DEFAULT ''"],
      ['areas', 'next_step', "TEXT NOT NULL DEFAULT ''"],
      ['areas', 'summary_updated_at', 'INTEGER'],
      ['areas', 'summary_source', "TEXT CHECK(summary_source IN ('manual','insight'))"],
      ['areas', 'summary_source_note_id', 'TEXT'],
      ['areas', 'summary_source_insight_id', 'TEXT'],
      ['areas', 'summary_source_note_revision', 'INTEGER'],
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_primary_milestone ON tasks(primary_milestone_id);
      CREATE TABLE IF NOT EXISTS project_references (
        id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
        area_id TEXT REFERENCES areas(id), milestone_id TEXT REFERENCES milestones(id),
        role TEXT NOT NULL DEFAULT 'related' CHECK(role IN ('related','outcome','review','growth')),
        origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','mention')), created_at INTEGER NOT NULL,
        CHECK((task_id IS NOT NULL)+(note_id IS NOT NULL)=1),
        CHECK((area_id IS NOT NULL)+(milestone_id IS NOT NULL)=1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_reference_unique ON project_references(
        COALESCE(task_id,''),COALESCE(note_id,''),COALESCE(area_id,''),COALESCE(milestone_id,''),origin
      );
      CREATE INDEX IF NOT EXISTS idx_project_reference_area ON project_references(area_id);
      CREATE INDEX IF NOT EXISTS idx_project_reference_milestone ON project_references(milestone_id);
      CREATE INDEX IF NOT EXISTS idx_project_reference_task ON project_references(task_id);
      CREATE INDEX IF NOT EXISTS idx_project_reference_note ON project_references(note_id);
      CREATE TABLE IF NOT EXISTS project_events (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL,
        before_json TEXT, after_json TEXT, created_at INTEGER NOT NULL, undone_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_project_events_target ON project_events(target_type,target_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS project_assignment_previews (
        token TEXT PRIMARY KEY, input_json TEXT NOT NULL, signature TEXT NOT NULL, preview_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, applied_at INTEGER
      );
    `)
  })()
}
