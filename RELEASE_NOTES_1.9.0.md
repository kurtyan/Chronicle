# Chronicle v1.9.0 Release Notes

## Summary

v1.9.0 collects the major work since the latest release notes in the repo, `RELEASE_NOTES_1.3.0.md`. It expands the Today/Focus workflow, improves rich task logging, and adds LLM-powered task progress summaries with configurable prompts and call-log inspection.

---

## Focus & Day Script

- Added the Day Script focus workflow with structured focus blocks, task mentions, progress sync, and execution records.
- Focus progress now preserves rich formatting, including lists, code blocks, and images when appended back to task logs.
- Added safer progress sync behavior for inserted blocks, stale block/task associations, separators, image-only updates, and repeated confirmations.
- Improved Focus next-step insertion so inserted task mentions are separated from previous task progress and do not get appended to the wrong task.
- Improved Today/Focus panel layout and resizing, including safer panel behavior and code block wrapping.

---

## LLM Task Summaries

- Added async task summary extraction after task log changes, with SSE updates when summaries are ready.
- Added per-task summary queueing so stale running or pending summary requests do not overwrite newer results.
- Added task detail summary widget showing current progress and next step, with expandable long summaries.
- Added Focus next-steps panel based on extracted task summaries.
- Added configurable Task Summary prompt under Settings → AI, alongside Meeting Extraction.
- Added Task Summary prompt testing: select a task, inspect read-only entries, run the prompt, and view summary/next step without updating the official cache.
- Improved task summary prompt and parser:
  - strict JSON shape validation
  - provider raw response and assistant message logging
  - plain-text task entry input instead of JSON payloads
  - latest progress based on all supplied entries
  - next step chosen from the latest submitted entry that explicitly mentions a next step

---

## AI Settings & Diagnostics

- Added LLM call logs to Settings for both Meeting Extraction and Task Summary.
- Call logs now distinguish provider raw response, assistant message content, parsed output, request input, and errors.
- Call-log text areas support normal text selection, including `Cmd+A` within a single log field.
- LLM settings now include shared provider configuration, configurable prompts, restore-default actions, and prompt test flows.

---

## Rich Editor & Task Detail

- Improved rich progress preservation from Focus to task logs.
- Added wrapped code block rendering for better readability in task entries.
- Improved task detail refresh and focus scrolling behavior.
- Hardened task summary display for long progress and next-step text.

---

## Infrastructure & Versioning

- Upgraded Chronicle through the 1.6, 1.7, and 1.8 lines and now to 1.9.0.
- Added fresh-worktree dependency guidance to `AGENTS.md`.
- Improved dev startup behavior and isolated dev ports/data paths.
- Added regression coverage around Day Script, Focus rich logs, progress sync edge cases, and meeting/task mention flows.

---

## Upgrade Notes

- Existing task data remains compatible.
- New task summary behavior uses `task_progress_summaries` and `llm_call_logs`; existing databases will add required columns/tables on startup.
- Task summary extraction now ignores work sessions when deciding whether a cached summary is stale; it is driven by recent task entries instead.
