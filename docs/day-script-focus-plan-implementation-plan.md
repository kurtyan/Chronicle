# Day Script / Focus Plan Implementation

## Summary

Replace the current Today timeline with a text-first Day Script while preserving the legacy planner at `/today/plan`.

Today will contain:

1. A cached LLM context panel for all `PENDING` and `DOING` tasks.
2. A Day Script editor with timed subtask lines and inline `@Task Title` links.
3. Current-block highlighting and countdown.
4. `Cmd+S` persistence and idempotent progress synchronization to referenced task logs.
5. The existing task-detail workspace, opened by clicking task links.

Example:

```text
09:30-09:50 @Search API abnormality ✅
Reproduced the timeout in /query.
Retry logic resets the request deadline.
Next: test retry with an independent timeout.

09:50-10:10 @Report timeline overlap
Investigating incorrect AFK rendering.
```

A line beginning with a valid `HH:mm-HH:mm` range starts a subtask block. Every line after it belongs to that block until the next timed subtask line.

## Implementation Changes

### Day Script Storage and Parsing

Add server-owned persistence:

- `day_scripts`: one TipTap JSON document per date, revision, and timestamps.
- `day_script_blocks`: stable block ID, script ID, start/end time, order, completion state.
- `day_script_block_tasks`: resolved task IDs referenced by each block.
- `day_script_progress_syncs`: progress already synchronized per block/task and the created task-entry ID.

Create a deterministic parser that:

- Recognizes only lines beginning with a valid time range.
- Validates hour/minute values and requires end after start.
- Treats all content until the next timed line as progress for the current block.
- Extracts structured task-mention nodes rather than matching titles from text.
- Treats `✅` on the timed line as block completion.
- Allows blocks without task references; those blocks never create task logs.
- Assigns and preserves stable block IDs when times or text are edited.

Store the source TipTap document and derived block records in one transaction. Use optimistic revision checks to prevent one window from overwriting another.

### Editor and Task Links

Build a dedicated lightweight TipTap Day Script editor instead of modifying task-log editor behavior.

Add an inline atomic task-mention node:

```ts
{
  type: "taskMention",
  attrs: {
    taskId: "T0000000123",
    label: "Search API abnormality"
  }
}
```

Behavior:

- Typing `@` opens autocomplete over `PENDING` and `DOING` tasks.
- Search matches task title or ID, but inserts only `@Task Title`.
- The task ID is never displayed in the normal editor.
- Mentions render as underlined inline links.
- Clicking a mention navigates to `/today?task={taskId}`, calls `setActiveTask(taskId)`, and opens the existing task-detail workspace.
- Editing around a mention does not trigger navigation.
- Task titles are resolved from current task data, so renamed tasks display the latest title; the stored label is only an offline fallback.
- The URL query supports browser back/forward and restores the selected task after reload.

The active timed block is highlighted from the current time, with a countdown to its end. Completed blocks remain visually distinct. Provide actions to mark done, skip, and shift remaining blocks without requiring the legacy drag-heavy planner.

### Save and Progress Synchronization

`Cmd+S` sends the complete document, expected revision, and parsed block state to one server endpoint. The server reparses and validates instead of trusting client-derived blocks.

For each block containing `✅`:

- If no progress was previously synchronized, create a task log containing the complete progress.
- If existing synchronized progress is an exact prefix, create a log containing only the appended lines.
- If nothing changed, create no log.
- If previous progress was edited or removed, save the Day Script but return a synchronization conflict; show a preview and require explicit confirmation before creating another log.
- Removing `✅` changes the block state but never deletes historical task logs.
- Adding progress later to an already completed block synchronizes only the appended content.
- Adding a new task reference to a completed block synchronizes the full current progress to that newly referenced task.
- Multiple referenced tasks receive independent copies and independent synchronization snapshots.

Generated logs include source context:

```text
Day Script progress · 2026-06-09 · 09:30-09:50

Retry logic resets the request deadline.
Next: test retry with an independent timeout.
```

Log creation, search indexing, synchronization snapshots, and script revision updates occur transactionally. Created logs emit normal entry events so open task details refresh.

### Pending Task Context

At the top of Today, list all `PENDING` and `DOING` tasks. Each item shows:

- Linked task title.
- LLM-generated latest progress.
- LLM-generated next step or unresolved issue.
- Deterministic total work-session duration.
- Deterministic latest activity timestamp.
- Summary freshness and refresh/error state.

Add a cached summary record per task, keyed by a fingerprint of its body, logs, and relevant work sessions.

Loading behavior:

1. Return tasks, time metrics, and existing cached summaries immediately.
2. Identify stale or missing summaries.
3. Refresh stale summaries in bounded batches through the configured local LLM.
4. Update cards as results arrive without blocking the Day Script editor.
5. Preserve the last successful summary when the LLM is unavailable and expose a manual retry action.

The LLM receives task title/body and chronological logs, chunking long histories before producing a consolidated summary. It never changes tasks, logs, status, or Day Script content.

## APIs and Types

Add:

- `GET /api/day-scripts/:date`
- `PUT /api/day-scripts/:date`
- `POST /api/day-scripts/:date/confirm-progress-sync`
- `GET /api/task-context?status=PENDING,DOING`
- `POST /api/task-context/summarize`

Core response types include:

- `DayScriptDocument`
- `DayScriptBlock`
- `TaskMention`
- `ProgressSyncResult`
- `ProgressSyncConflict`
- `TaskProgressContext`
- `TaskProgressSummary`

`PUT /api/day-scripts/:date` returns the new revision, normalized blocks, created log IDs, validation errors, and any progress conflicts.

The obsolete embedded `sql.js` provider does not need feature support because the application always uses the local HTTP server.

## Test Plan

- Parser recognizes timed headers and assigns every intervening line to the preceding block.
- Blank, unindented, formatted, and multi-paragraph progress remains attached correctly.
- Invalid times produce visible validation errors and no partial save.
- `@` autocomplete inserts a title link backed by the correct task ID.
- Duplicate task titles resolve correctly through selected IDs.
- Clicking a mention opens task details and updates/restores the URL.
- Renaming a task updates mention display without breaking linkage.
- First completed save creates one log per referenced task.
- Repeated `Cmd+S` creates no duplicate logs.
- Appended progress creates only an appended-progress log.
- Edited historical progress produces a confirmation conflict.
- Multiple references and newly added references synchronize independently.
- Blocks without `@task` save normally and create no logs.
- Concurrent revision conflicts do not overwrite newer content.
- Current-block highlighting and countdown handle the configured workday boundary.
- Summary cache invalidates after log/session changes and survives LLM failure.
- Existing task entry, search indexing, Today navigation, and legacy planner tests remain passing.
- Run server build, web TypeScript/Vite build, and focused Playwright API/UI scenarios.

## Assumptions

- Day Script becomes the primary Today interface; the existing planner remains available but is not synchronized bidirectionally in this first version.
- `PENDING` and `DOING` are considered pending work; `DONE`, `DROPPED`, and `ON_HOLD` are excluded from the top panel and mention autocomplete.
- A timed header may omit `@task`.
- `✅` completes only the Day Script block, never the referenced task.
- Progress synchronization is append-only by default; historical task logs are never rewritten automatically.
- All parsing and mutation decisions are rule-based. LLM use is limited to task-context summaries.
