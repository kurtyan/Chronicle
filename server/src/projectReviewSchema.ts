import type Database from 'better-sqlite3'

export function initProjectReviewSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_reviews (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK(target_type IN ('area', 'milestone')),
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('completion', 'periodic')),
      note_id TEXT NOT NULL,
      period_start INTEGER,
      period_end INTEGER,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'confirmed')),
      completion_event_id TEXT,
      insight_draft_id TEXT,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_reviews_target ON project_reviews(target_type, target_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS project_review_versions (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      note_id TEXT NOT NULL,
      note_revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      content_html TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      completion_event_id TEXT,
      confirmed_at INTEGER NOT NULL,
      UNIQUE(review_id, version)
    );
    CREATE TABLE IF NOT EXISTS project_insight_drafts (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK(target_type IN ('area', 'milestone')),
      target_id TEXT NOT NULL,
      period_start INTEGER,
      period_end INTEGER,
      request_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'cancelled')),
      evidence_json TEXT NOT NULL,
      content_json TEXT,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      background_task_id TEXT,
      error_message TEXT,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      previous_draft_id TEXT,
      accepted_note_id TEXT,
      accepted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_project_insights_target ON project_insight_drafts(target_type, target_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_insights_running_request ON project_insight_drafts(request_key) WHERE status = 'running';
  `)
  // Execution ownership cannot survive a process restart. Keep durable evidence/results.
  const now = Date.now()
  db.prepare(`UPDATE project_insight_drafts SET status = 'error', error_message = 'Generation interrupted by server restart; retry to create a new draft', updated_at = ?, completed_at = ? WHERE status = 'running'`).run(now, now)
}
