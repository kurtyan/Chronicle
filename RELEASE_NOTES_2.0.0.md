# Chronicle v2.0.0 Release Notes

## Summary

v2.0.0 is a reliability and workflow release centered on AI background work. It adds persistent Background Tasks for Daily Summary, Task Summary, and Meeting Extraction; improves Daily Summary rendering and cache behavior; fixes cross-workday reporting/session accounting; and hardens LLM timeout, configuration, and task state handling.

---

## Background Tasks

- Added a persistent Background Tasks system backed by the local database.
- Added sidebar access, panel filtering, completion/error notifications, read/dismiss state, and task-specific click routing.
- Daily Summary, Task Summary, and Meeting Extraction now surface long-running AI work through the same background task model.
- Background tasks survive page refresh and expose completion history for recent tasks.
- Hardened background task state transitions so timed-out or failed tasks cannot be overwritten by late async completions.
- Server startup now marks interrupted persisted running tasks as failed, avoiding fake running tasks after restart.
- Meeting Extraction background tasks protect raw meeting notes: list, SSE, and toast payloads expose only safe metadata, while full content is loaded only from task detail.

---

## Daily Summary

- Added background Daily Summary generation with cached-result viewing while regeneration runs.
- Markdown summaries now render as Markdown, with a Show Source toggle for the raw text.
- Stale Daily Summary cache detection now triggers regeneration instead of indefinitely showing obsolete content.
- Failed background summaries now show the task error instead of an empty dialog.
- Daily Summary task routing now opens the correct Today date even when already on the Today page.
- Daily Summary session input now clips work sessions to the selected workday range.

---

## Meeting Extraction

- Meeting extraction now uses the background task pipeline for long-running extraction.
- Foreground Extract and Run in Background now refer to the same background task, avoiding duplicate LLM calls.
- Clicking a successful meeting extraction background task opens the confirm view directly.
- Confirmed meeting extraction tasks record their target task/meeting and later route to the created or updated task.
- Running and failed meeting extraction tasks restore the input state with progress or error feedback.

---

## Reporting, Sessions, and Focus

- Reporting now accounts for work sessions that overlap a selected workday instead of only sessions that start inside it.
- Work session display and totals are clipped to the current reporting range for consistent cross-workday accounting.
- Daily Summary and Reporting now use compatible range semantics for long sessions crossing the workday boundary.
- Focus Area code blocks now use Day Script-specific height behavior: natural growth up to 10 lines, then internal scrolling.
- Task content, task logs, meeting editor, display task logs, and inline code are kept outside the Day Script code-block height cap.

---

## LLM, Settings, and Diagnostics

- LLM timeout settings are applied consistently to Daily Summary, Task Summary, and Meeting Extraction.
- Timeout and abort errors now include the actual timeout value used.
- Frontend HTTP calls no longer impose a shorter timeout than the backend LLM timeout.
- Server config saving now preserves unknown top-level fields, including Tauri-managed `auto_afk`.
- Added regression coverage for Auto-AFK config preservation and long timeout persistence.

---

## Upgrade Notes

- Existing task and meeting data remain compatible.
- A new `background_tasks` table is created automatically on startup.
- Background task history is local and persisted, but sensitive meeting content is only returned from task detail APIs.
- Existing Daily Summary cache may be marked stale and regenerated after the upgrade.
