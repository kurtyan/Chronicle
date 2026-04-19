# Chronicle

A local-first task management app with a Tauri desktop shell and a local Hono + SQLite server.

## Architecture

```
┌─────────────────────┐
│  Tauri Desktop App  │  ← Native macOS .app
│  React + Vite UI    │  ← Connects to localhost server
└────────┬────────────┘
         │ HTTP localhost
┌────────▼────────────┐
│  Hono Server        │  ← Bundled Node.js (tsup, ~22 KB)
│  better-sqlite3     │  ← On-disk SQLite, WAL mode
│  FTS5 + nodejieba   │  ← Full-text Chinese + English
└────────┬────────────┘
         │
┌────────▼────────────┐
│  ~/.chronicle/      │  ← Config + hourly backups (last 24)
│  data/tasks.db      │  ← SQLite database
└─────────────────────┘
```

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Rust** + `cargo` (for Tauri builds only)
- **macOS**: Xcode Command Line Tools

---

## Development

### Server (hot reload)

```bash
cd server && npm install && npm run dev
```

### Web UI (hot reload, proxies `/api` to server)

```bash
cd web && npm install && npm run dev
```

### Tauri desktop (native window, hot reload)

```bash
cd tauri && npm install && npm run tauri:dev
```

---

## Build

### Server + Tauri app (one command)

```bash
npm run build:all
```

Builds web → bundles server → produces `Chronicle.app`.

### Individual builds

```bash
npm run build              # web + server artifact → ./dist/chronicle/
cd tauri && npm run tauri:build   # macOS .app only (no DMG)
```

### Publish to npm

```bash
npm run publish:prepare    # builds everything, creates package in dist/chronicle-npm/
cd dist/chronicle-npm && npm publish   # publish to your npm registry
```

### Clean

```bash
npm run clean              # remove all build artifacts
npm run clean:all          # also remove Tauri target/
```

---

## Release Build & Install

### Build the server npm package

```bash
npm run clean                    # remove old build artifacts
npm run publish:prepare          # builds web + server, creates package in dist/chronicle-npm/
```

### Pack and install from tarball

```bash
cd dist/chronicle-npm
npm pack                         # creates chronicle-1.0.0.tgz
npm install -g chronicle-1.0.0.tgz   # real copy, not symlink
```

### Verify

```bash
chronicle start                  # start server
curl http://127.0.0.1:8083/api/reports/summary   # check API
curl http://127.0.0.1:8083/                       # check web UI
chronicle stop                   # stop server
```

### Publish to remote npm registry (optional)

```bash
cd dist/chronicle-npm
npm publish
```

---

## Deployment

### Server

The server can be installed globally. On macOS it auto-registers as a launchd background service:

```bash
npm install -g chronicle       # from npm registry
npm install -g chronicle-1.0.0.tgz   # from local tarball
```

**CLI commands:**

```bash
chronicle start          # start server in foreground
chronicle stop           # stop the running server
chronicle status         # show server + launchd status
chronicle setup          # install/reinstall launchd background service
chronicle                # show help
```

### Desktop App

Download `Chronicle.app` from [GitHub Releases](https://github.com/kurtyan/Chronicle/releases), or build from source:

```bash
git clone git@github.com:kurtyan/Chronicle.git
cd Chronicle
npm run build:all
open tauri/src-tauri/target/release/bundle/macos/Chronicle.app
```

The app enforces single-instance — launching a second time focuses the existing window.

### Config

Create `~/.chronicle/config.json`:

```json
{
  "server": { "host": "127.0.0.1", "port": 8080, "database": "", "logPath": "" },
  "lauri": { "serverHost": "localhost", "serverPort": 8080 }
}
```

| Field | Description |
|---|---|
| `server.host` / `server.port` | Server bind address |
| `server.database` | SQLite path (empty = auto `./data/tasks.db`) |
| `server.logPath` | Log file path for launchd (empty = auto `~/.chronicle/logs/server.log`) |
| `lauri.*` | Tauri app connection target |

---

## macOS Background Service (launchd)

The server can run as a background service managed by `launchd` — starts at login, auto-restarts.

### Via CLI

```bash
chronicle setup          # install and load launchd service
chronicle status         # check server + launchd status
chronicle stop           # stop server + unload launchd
```

### Via Settings UI

Open the Settings page in the Tauri app — there are controls to install, check status, and uninstall.

### Via API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/settings/launchd/status` | Check if service is installed |
| `POST` | `/api/settings/launchd/install` | Install and load launchd service |
| `POST` | `/api/settings/launchd/uninstall` | Uninstall launchd service |
| `GET`  | `/api/settings/launchd/plist` | Preview generated plist content |

### What gets installed

A plist file at `~/Library/LaunchAgents/com.chronicle.server.plist` that:

- Runs the bundled server with the system Node.js
- Starts at login (`RunAtLoad`) and keeps alive (`KeepAlive`)
- Logs stdout/stderr to `~/.chronicle/logs/`

---

## Data Management

### Database

- Default: `./data/tasks.db` relative to the server directory
- WAL mode enabled for concurrent-read safety

### Backups

- **Automatic**: hourly to `~/.chronicle/backups/tasks-{timestamp}.db`
- **Retention**: last 24 backups
- **On startup**: creates an initial backup

### Export / Import (Settings page)

- **Export**: native save-file dialog (Tauri) with browser-download fallback
- **Import**: file picker → confirmation dialog. Pre-import backup created automatically

---

## API Endpoints

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/tasks` | List tasks (`?type=`, `?status=`) |
| `GET`    | `/api/tasks/today` | Today view |
| `GET`    | `/api/tasks/:id` | Get task by ID |
| `POST`   | `/api/tasks` | Create task |
| `PUT`    | `/api/tasks/:id` | Update task |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `PUT`    | `/api/tasks/:id/done` | Mark done |
| `POST`   | `/api/tasks/:id/drop` | Drop with reason |

### Logs / Entries

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/tasks/:id/logs` | Get task entries |
| `POST` | `/api/tasks/:id/logs` | Submit entry (`content`, `type`: `log` / `body`) |
| `PUT`  | `/api/tasks/:id/logs/:entryId` | Update entry |

### Work Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks/:id/takeover` | Start session (PENDING → DOING) |
| `POST` | `/api/afk` | Go AFK |
| `GET`  | `/api/sessions/current` | Current session |
| `GET`  | `/api/sessions` | List sessions (`?start=`, `?end=` timestamps) |

### Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reports/today` | Today's report |
| `GET` | `/api/reports/summary` | Summary by type/priority |
| `GET` | `/api/reports/range-stats` | Stats for date range |

### Search

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/search` | FTS5 + nodejieba search (`?q=`, `?limit=`) |
| `POST` | `/api/search/rebuild` | Rebuild FTS index |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/settings/export` | Download database |
| `POST` | `/api/settings/import` | Import database |
| `GET`  | `/api/settings/info` | DB info |
| `GET`  | `/api/settings/launchd/status` | launchd status |
| `POST` | `/api/settings/launchd/install` | Install launchd |
| `POST` | `/api/settings/launchd/uninstall` | Uninstall launchd |
| `GET`  | `/api/settings/launchd/plist` | Get plist content |

### Real-time Events

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/events` | SSE stream (`?clientId=` for source filtering) |

Events: `task_created`, `task_updated`, `task_deleted`, `entry_created`, `entry_updated`, `session_started`, `session_ended`, `db_imported`.

---

## Features

### Task Board

- **Multi-type filter** (OR logic): Task, To Read, Daily Improve. None = all non-done/dropped
- **Today view**: high-priority incomplete + earliest daily improve + earliest to-read
- **Status filters**: New / Done / Dropped in animated expand/collapse panel
- **Rich text editor** (TipTap): bold, italic, strikethrough, headings, lists, blockquotes, code, links, images (paste/drag-drop with resize)
- **Created time**: relative within 7 days, absolute otherwise
- **Full-text search**: FTS5 + nodejieba, inline results with title/content highlighting

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + R` | Refresh current page |
| `Cmd/Ctrl + T` | Toggle Today view |
| `Cmd/Ctrl + W` | Blur editor / clear Done or Dropped filter |
| `Cmd/Ctrl + S` | Save / submit draft or log entry |
| `Cmd/Ctrl + Enter` | Save / submit draft or log entry |
| `Cmd/Ctrl + Q` | Go AFK |
| `Cmd/Ctrl + Shift + F` | Inline search mode |
| `n` | Create new task |
| `↑ / ↓` | Navigate between tasks |
| `→` | Focus log editor for selected task |
| `Esc` | Close dialogs / cancel draft / exit search |

### Desktop Shell

- Tauri v2, single-instance (re-focuses existing window on second launch)
- Default window: 1200×800, resizable, min 800×600
- Devtools enabled in release builds: `Cmd+Option+I`
- Prevents accidental close via Cmd+W / Cmd+Q

### Localization

- English (en) and Simplified Chinese (zh-CN) via `@/i18n/context`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Zustand, Tailwind CSS, TipTap, dnd-kit, Radix UI, axios, date-fns |
| Build | Vite (web), Tauri CLI (native), tsup (server) |
| Backend | Hono (Node.js), better-sqlite3 |
| Search | SQLite FTS5 + nodejieba |
| Desktop | Tauri v2 (single-instance plugin) |
| Database | SQLite (WAL mode) |
| macOS Service | launchd (LaunchAgents) |
