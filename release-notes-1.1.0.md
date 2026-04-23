# Chronicle v1.1.0 Release Notes

## Summary

v1.1.0 adds desktop-native integrations (Auto-AFK, MCP bridge), real-time sync via SSE, a unified release pipeline, and significant UI improvements.

---

## New Features

### Auto-AFK Detection (Desktop)

Automatically ends work sessions when you're away:
- **Screen lock detection** — AFK triggers when Mac locks (CoreGraphics native)
- **Input idle detection** — AFK after configurable keyboard/mouse inactivity (1–60 min)
- Configurable in Settings page with master toggle and sub-controls
- Debounced to prevent duplicate triggers

### MCP (Model Context Protocol) Bridge

Chronicle now exposes 8 MCP tools for AI clients:
- `query_tasks`, `get_task`, `search_tasks` — read and search tasks
- `create_task`, `update_task_status`, `add_log` — write operations
- `takeover_task` — read history, mark DOING, start session
- `query_sessions` — work session queries by time range

Available via stdio (`chronicle-mcp` CLI) — usable by Claude Code and other MCP-compatible clients.

### Real-time Sync (SSE)

- Server-Sent Events broadcast live changes: task CRUD, log entries, sessions, DB import
- Connection status dot in sidebar (green = connected, yellow = connecting, red = disconnected)
- Auto-reconnect with backoff

### Pinned Tasks

- Pin/unpin tasks for quick access at the top of the board
- API: `POST /api/tasks/:id/pin`, `GET /api/tasks/pinned`

### Task Extra Info

- Arbitrary key-value metadata per task
- Used internally for Claude conversation ID tracking
- API: `GET/PUT/DELETE /api/tasks/:id/extra-info/:key`

### Version System

- Single `VERSION` file as source of truth
- Builds generate `VERSION_BUILD` with timestamp: `v1.1.0-20260423120000`
- Server exposes version at `GET /api/version`
- Dev mode: amber "DEV" badge in page corner showing UI + API versions
- Production: version info card in Settings page
- Unified `npm run release` command: version → server build → local install → Tauri build, all with one timestamp

---

## Improvements

### Settings Page

- Added **Version Info** card showing UI and Server versions
- Added **Client Log** viewer for debugging
- Added **Language** selector (auto / Chinese / English)
- Added **Auto-AFK** configuration panel
- Import confirmation dialog with warning message

### Desktop App (Tauri)

- Added "About Chronicle" menu item with version info
- Dev mode window title shows "Chronicle DEV — {version}"
- Zoom controls: Cmd+/-, Cmd+0
- Single-instance enforcement (re-focuses existing window)
- Cmd+W / Cmd+Q confirmation to prevent accidental close

### Search

- Full-text search via FTS5 + nodejieba (Chinese + English)
- Inline search overlay with highlighting (title / body / log matches)
- Keyboard shortcut `Cmd+Shift+F`
- Index auto-rebuilds when tokenizer version changes

### Localization

- Added ~200 translation keys across all UI surfaces
- Language switching applies immediately without reload

---

## Build & Infrastructure

- **Unified release command**: `npm run release` — one command for full pipeline
- **Version script**: `scripts/generate-version.js` reads base `VERSION`, appends timestamp
- **Tauri version sync**: `tauri/scripts/update-version.js` updates Cargo.toml + tauri.conf.json
- **`publish.js`** now supports `--local-publish` flag for pack + global install
- **`dev.sh`** sets session-unique `CHRONICLE_VERSION` env var for dev builds
- **`build.js`** includes version generation as step 0
- **`VERSION_BUILD`** added to `.gitignore`

---

## API Changes

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/version` | Server version |
| `GET`  | `/api/events` | SSE event stream |
| `POST` | `/api/afk-events` | Create AFK event |
| `PUT`  | `/api/afk-events/:id` | Update AFK event |
| `GET`  | `/api/afk-events` | Query AFK events |
| `POST` | `/api/tasks/:id/pin` | Pin/unpin task |
| `GET`  | `/api/tasks/pinned` | Get pinned task IDs |

---

## Tech Stack Updates

- **MCP**: `@modelcontextprotocol/sdk` with `zod/v4` schemas
- **Auto-AFK**: `core-graphics` + `system-idle-time` (macOS native via Tauri)
- **Server startup log** now includes version string

---

## Migration

No database migration required. Existing `tasks.db` is fully compatible.
