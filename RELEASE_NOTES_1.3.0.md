# Chronicle v1.3.0 Release Notes

## Daily Plan

The headline feature of 1.3.0 is the **Daily Plan** system — a full planning workflow integrated into the Chronicle task management loop.

### Plan Creation Wizard
- **Step 1 — Edit Plan**: Type `@` to pick tasks from your board, then add sub tasks with estimated durations. Supports drag-drop task selection from the left panel. Sub tasks are clickable for re-editing.
- **Step 2 — Schedule**: A proportional timeline where you can drag items to insert breaks and resize durations by pulling bottom edges. Saves with one click.

### Plan Timeline (Today Page)
- Left panel shows a proportional timeline with time-on-left display, status badges, and break indicators
- **Real-time progress bar** on the left edge: elapsed time in primary color, remaining in faint gray, with a bright current-time marker. Updates every 5 seconds. Day-boundary aware — handles late-night hours correctly with the start-of-day offset.
- Keyboard navigation: `j`/`k` or arrow keys to move through plan items, auto-scrolling into view
- Select a plan item to view its task detail in the shared workspace on the right

### Plan Item Lifecycle
- Statuses: PLANNED → DOING (auto-starts on edit) → DONE / SKIPPED
- Plan items sync bidirectionally between the timeline list and task detail entries
- Status changes and content edits reflect immediately in the plan view

---

## Editor & UI Improvements

- **Cmd+S silent save**: Persists draft without exiting edit mode. Works in both quick log and entry editor. Auto-saves every 30 seconds.
- **Rich editor**: Extended heading support to H4. Added list indent/outdent. Fixed Tab focus behavior.
- **Plan status badge**: Stays visible next to the timestamp during entry editing — no more visual discontinuity.
- **Sub task indentation**: Edit rows are indented to match committed sub task rows, clarifying the task/sub task hierarchy.

---

## Keyboard Shortcuts

| Shortcut | Scope | Action |
|---|---|---|
| `Cmd+Q` | App | AFK session |
| `Cmd+W` | App | Prevent window close (blurs editor) |
| `Cmd+R` | App | Refresh tasks + plan items |
| `Cmd+1-4` | App | Navigate Board / Today / Report / Settings |
| `Cmd+S` | Editor | Save draft silently |
| `j` / `k` or `↓` / `↑` | Plan timeline | Navigate plan items |
| `Cmd+Shift+T` | Task detail | Take over task |
| `Cmd+Shift+S` | Task detail | Start task |
| `Cmd+Shift+D` | Task detail | Mark done |

---

## Report Page

- AFK/gap timeline visualization alongside work sessions
- Clickable stat sections for filtering

---

## Infrastructure & Fixes

- **WAL backup data loss** resolved — persistent DB path with `.backup()` API and graceful shutdown
- `conversationId` exposed as MCP tool parameter across all mutation tools
- Tauri invoke validation hardened against malformed payloads
- Link XSS guard for external link handling
- Server startup log now includes version string

---

## Upgrade Notes

- **DB path**: The database is now stored at a persistent location (`~/.chronicle/`) instead of a temp directory. Existing data from previous versions will be migrated automatically on first launch.
- **Start-of-day offset**: Default is 5:00 AM. Configurable via Settings. Plan dates respect this offset — times before the offset belong to the previous day.
