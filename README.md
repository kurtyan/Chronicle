# Chronicle

Chronicle is a local-first work journal for managing tasks, daily plans, notes, and work history. It runs as a local Hono + SQLite server with a React UI, a Tauri desktop shell, and MCP tools for agents.

The current app has five main surfaces:

- Board: task list, task detail, rich task logs, pinned excerpts, linked notes, work sessions, AFK/drop flows, and task summary generation.
- Today: daily planning with time blocks, carry-over blocks, progress sync, work overview signals, and daily summary generation.
- Notes: rich HTML notes with autosave, archive/unarchive, pinned notes, body search, linked tasks, and task-entry append flows.
- Report: daily and range reporting over tasks, entries, sessions, and AFK events.
- Settings: data import/export, launchd controls, LLM provider settings, prompt testing, call logs, workday start offset, diagnostics, and version info.

## Architecture

```text
React + Vite UI
  web/                 Browser build served by the local server
  tauri/               Tauri desktop shell using the same UI source

Hono server
  server/src/index.ts  HTTP API, SSE stream, static UI serving, MCP endpoint
  server/src/db.ts     SQLite schema and migrations
  server/src/services  Task, note, search, day-script, LLM, backup services

Local data
  SQLite               better-sqlite3, WAL mode
  FTS5                 Task, task-entry, and note search indexes
  nodejieba            Chinese tokenization for search input
```

Installed data defaults to `~/.chronicle`. The development launcher uses `.dev-data` inside the repo so dev sessions do not touch the installed database.

## Prerequisites

- Node.js 20 or newer for local development. Use `./scripts/with-node.sh` in this repo; it selects a suitable Node version when the shell default is too old.
- npm.
- Rust and Cargo for Tauri desktop builds.
- macOS Xcode Command Line Tools for Tauri and launchd integration.

Install dependencies when working from a fresh checkout:

```bash
./scripts/with-node.sh npm install
(cd server && ../scripts/with-node.sh npm install)
(cd web && ../scripts/with-node.sh npm install)
(cd tauri && ../scripts/with-node.sh npm install)
```

## Development

The preferred development entrypoint is:

```bash
./dev.sh
```

`dev.sh` starts the server and Tauri dev shell, allocates ports in the `18xxx` range, generates a per-session dev version, and isolates runtime data under `.dev-data`.

Useful overrides:

```bash
CHRONICLE_SERVER_PORT=18080 PORT=18090 CHRONICLE_MCP_PORT=18081 ./dev.sh
```

Development paths:

- Database: `.dev-data/tasks-dev.db`
- Attachments: `.dev-data/attachments`
- Config: `.dev-data/chronicle-home/config.json`
- Logs: `.dev-data/chronicle-home/logs/server.log`

Standalone server or web commands are still available:

```bash
(cd server && ../scripts/with-node.sh npm run dev -- --port 18080)
(cd web && ../scripts/with-node.sh npm run dev)
(cd tauri && ../scripts/with-node.sh npm run tauri:dev)
```

The web dev server proxies `/api` to `CHRONICLE_SERVER_PORT` and defaults to port `5175`. The Tauri dev Vite server uses `PORT` and defaults to `5180`.

## Build And Release

Build the web UI and server artifact:

```bash
./scripts/with-node.sh npm run build
```

Build individual packages:

```bash
(cd server && ../scripts/with-node.sh npm run build)
(cd web && ../scripts/with-node.sh npm run build)
(cd tauri && ../scripts/with-node.sh npm run tauri:build)
```

Prepare and install the npm package locally:

```bash
./scripts/with-node.sh npm run publish:local
chronicle status
```

Release helper:

```bash
./scripts/with-node.sh npm run release
```

The release script generates `VERSION_BUILD`, builds web and server, installs the npm package locally, builds the Tauri app, and restores Tauri version files after the build. The base product version is stored in `VERSION`; the generated runtime string has the form `v<version>-<yyyyMMddHHmmss>`.

## Installed Runtime

The npm package exposes:

```bash
chronicle start
chronicle stop
chronicle status
chronicle setup
chronicle-server
chronicle-setup
chronicle-mcp
```

On macOS, `chronicle setup` installs `~/Library/LaunchAgents/com.chronicle.server.plist` so the server can start at login and keep running in the background.

Default installed paths:

- Config: `~/.chronicle/config.json`
- Database: `~/.chronicle/data/tasks.db`
- Backups: `~/.chronicle/data/backups`
- Logs: `~/.chronicle/logs`
- Attachments: `~/.chronicle/attachment`

The server creates an initial backup on startup, then hourly backups, keeping the latest 24 backup files. Imports create an additional pre-import backup.

## Configuration

Example `~/.chronicle/config.json`:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 9983,
    "database": "",
    "logPath": ""
  },
  "mcp": {
    "enabled": true,
    "port": 9981
  },
  "lauri": {
    "serverHost": "localhost",
    "serverPort": 9983
  },
  "ui": {
    "language": "auto"
  },
  "llm": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen2.5:7b",
    "apiKey": "",
    "timeoutMs": 30000,
    "meetingExtractionMaxTokens": 4000,
    "taskSummaryMaxTokens": 1200,
    "dailySummaryMaxTokens": 4000,
    "meetingExtractionPrompt": "",
    "taskSummaryPrompt": "",
    "dailySummaryPrompt": ""
  }
}
```

Environment variables override selected fields and are used heavily by `dev.sh`:

| Variable | Purpose |
| --- | --- |
| `CHRONICLE_SERVER_PORT` | Server port override |
| `CHRONICLE_MCP_PORT` | MCP HTTP port override |
| `CHRONICLE_DB_PATH` | SQLite database path override |
| `CHRONICLE_CONFIG_DIR` | Chronicle config/home directory override |
| `CHRONICLE_CONFIG_PATH` | Config JSON path override |
| `CHRONICLE_LOG_DIR` | Log directory override |
| `CHRONICLE_LOG_PATH` | Server log path override |
| `CHRONICLE_ATTACHMENT_DIR` | Attachment/image storage override |
| `CHRONICLE_LAURI_SERVER_PORT` | Tauri server-port override |
| `CHRONICLE_VERSION` | UI/runtime version override |
| `CHRONICLE_LLM_BASE_URL` | LLM API base URL override |
| `CHRONICLE_LLM_MODEL` | LLM model override |
| `CHRONICLE_LLM_API_KEY` | LLM API key override |
| `CHRONICLE_LLM_TIMEOUT_MS` | LLM request timeout override |

## HTTP API

The server serves the built UI and exposes JSON APIs under `/api`.

Core task APIs:

- `GET /api/tasks`, `GET /api/tasks/today`, `GET /api/tasks/next-id`, `GET /api/tasks/:id`
- `POST /api/tasks`, `PUT /api/tasks/:id`, `DELETE /api/tasks/:id`
- `PUT /api/tasks/:id/done`, `POST /api/tasks/:id/drop`, `POST /api/tasks/:id/takeover`, `POST /api/tasks/:id/resume-from-afk`
- `GET /api/tasks/:id/logs`, `POST /api/tasks/:id/logs`, `PUT /api/tasks/:id/logs/:entryId`, `DELETE /api/tasks/:id/logs/:entryId`
- `GET /api/tasks/:id/log-draft`, `PUT /api/tasks/:id/log-draft`, `DELETE /api/tasks/:id/log-draft`
- `GET /api/tasks/:id/pinned`, `POST /api/tasks/:id/pinned/append`, `POST /api/tasks/:id/pinned/unpin`
- `GET /api/tasks/:id/extra-info`, `GET /api/tasks/:id/extra-info/:key`, `PUT /api/tasks/:id/extra-info/:key`, `DELETE /api/tasks/:id/extra-info/:key`

Notes APIs:

- `GET /api/notes`
- `POST /api/notes`
- `GET /api/notes/:id`
- `PUT /api/notes/:id`
- `POST /api/notes/:id/archive`
- `POST /api/notes/:id/unarchive`
- `DELETE /api/notes/:id`
- `POST /api/notes/:id/append`
- `GET /api/notes/:id/tasks`
- `GET /api/tasks/:taskId/notes`
- `POST /api/tasks/:taskId/create-note`
- `POST /api/tasks/:taskId/entries/:entryId/add-to-note`

Search and indexing:

- `GET /api/search?q=<query>&scope=all|tasks|notes&limit=<n>`
- `POST /api/search/rebuild`

Sessions, AFK, reports, and Today:

- `POST /api/afk`, `GET /api/sessions/current`, `GET /api/sessions`
- `POST /api/afk-events`, `PUT /api/afk-events/:id`, `GET /api/afk-events`
- `GET /api/reports/today`, `GET /api/reports/summary`, `GET /api/reports/range-stats`, `GET /api/reports/tasks`
- `GET /api/day-scripts/:date`, `PUT /api/day-scripts/:date`
- `GET /api/day-scripts/:date/carry-over-blocks`
- `GET /api/day-scripts/:date/execution-records`
- `POST /api/day-scripts/:date/confirm-progress-sync`
- `POST /api/day-scripts/:date/submit-progress`
- `POST /api/day-scripts/:date/daily-summary`
- `GET /api/day-scripts/:date/daily-summary-cache`
- `POST /api/day-scripts/:date/daily-summary/background`
- `POST /api/day-scripts/:date/plan-today-draft`

Automation, settings, and diagnostics:

- `POST /api/meetings/extract`, `POST /api/meetings/extract/background`, `POST /api/meetings`
- `GET /api/task-context`, `POST /api/task-context/summarize`, `POST /api/task-context/test-summary`
- `GET /api/background-tasks`, `GET /api/background-tasks/:id`, `POST /api/background-tasks/:id/read`, `POST /api/background-tasks/:id/dismiss`, `POST /api/background-tasks/:id/consume`, `POST /api/background-tasks/cleanup`
- `GET /api/settings/export`, `POST /api/settings/import`, `GET /api/settings/info`
- `GET /api/settings/llm`, `PUT /api/settings/llm`, `POST /api/settings/llm/test-connection`
- `GET /api/llm-call-logs`, `GET /api/llm-call-logs/:id`
- `GET /api/settings/start-of-day-offset`, `PUT /api/settings/start-of-day-offset`
- `GET /api/settings/launchd/status`, `POST /api/settings/launchd/install`, `POST /api/settings/launchd/uninstall`, `GET /api/settings/launchd/plist`
- `GET /api/version`
- `GET /api/events` for server-sent events

## MCP Tools

The server exposes Chronicle tools through the MCP HTTP endpoint and the packaged `chronicle-mcp` bridge.

Available tools:

- `query_tasks`
- `get_task`
- `query_sessions`
- `takeover_task`
- `create_task`
- `update_task_status`
- `add_log`
- `search_tasks`
- `search_notes`
- `get_note`
- `create_note`
- `append_to_note`
- `create_note_from_task`

Task IDs use padded IDs like `T0000000001`. Note IDs use padded IDs like `N0000000001`.

## UI Shortcuts

- `Cmd+Shift+F`: global search from any main route.
- `Esc`: close dialogs/search. On the Notes page, `Esc` also exits the editor and returns focus to the note list.
- `Cmd+S`: flush pending note edits immediately.

## Testing

Common verification commands:

```bash
(cd server && ../scripts/with-node.sh npm run build)
(cd web && ../scripts/with-node.sh npm run build)
./scripts/with-node.sh npx playwright test tests/notes.test.ts
./scripts/with-node.sh npx playwright test tests/pinned-content.test.ts
./scripts/with-node.sh npx playwright test tests/search-done-detail.test.ts
git diff --check
```

Most Playwright tests start their own isolated server/database fixtures. For manual local testing with a running dev server, keep the proxy note in mind: commands that target `localhost` or `127.0.0.1` should bypass any configured HTTP proxy.

## Repository Layout

```text
.
├── dev.sh                    Development launcher
├── scripts/with-node.sh       Node wrapper used by local commands
├── server/                    Hono server, SQLite schema, services, MCP bridge
├── web/                       React/Vite UI source
├── tauri/                     Tauri desktop shell
├── tests/                     Playwright tests
├── build.js                   Web + server artifact builder
├── publish.js                 NPM package builder/publisher
├── VERSION                    Base product version
└── VERSION_BUILD              Generated runtime version
```
