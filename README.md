# Chronicle

A local-first task management app with a Tauri desktop shell and a local Hono + SQLite server.

## Architecture

```
┌─────────────────────┐
│  Tauri Desktop App  │  ← Native window (macOS .app / Linux .deb)
│  React + Vite UI    │  ← Connects to localhost:8080
└────────┬────────────┘
         │ HTTP localhost:8080
┌────────▼────────────┐
│  Hono Server        │  ← Single-file bundled Node.js (tsup, ~12 KB)
│  better-sqlite3     │  ← On-disk SQLite, WAL mode
└────────┬────────────┘
         │
┌────────▼────────────┐
│  ~/.chronicle/      │  ← Config + hourly backups (last 24 kept)
│  data/tasks.db      │  ← SQLite database
└─────────────────────┘
```

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Rust** + `cargo` (for Tauri builds only)
- **macOS**: Xcode Command Line Tools
- **Linux**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (see [Tauri prerequisites](https://tauri.app/start/prerequisites/))

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

### Full build (frontend + server artifact)

```bash
npm run build            # outputs to ./dist/chronicle/
npm run build:out        # same, explicit path
```

The build script (`build.js`) performs four steps:

1. Installs deps and builds the web frontend (`web/`) → outputs to `server/public/`
2. Installs deps and bundles the server (`server/`) → single minified `server/dist/index.js` via `tsup`
3. Creates the artifact directory with server bundle, web assets, a trimmed `package.json`, and a platform-specific startup script
4. Installs production-only dependencies in the artifact

### Server-only rebuild

```bash
cd server && npm run build   # bundles to server/dist/index.js
```

### Tauri desktop app

```bash
cd tauri && npm run tauri:build
```

Outputs:
- **macOS**: `tauri/src-tauri/target/release/bundle/macos/Chronicle.app`

---

## Deployment

### Option 1: npm install (recommended)

Install the server globally and auto-register as a macOS background service:

```bash
npm install -g chronicle
```

This installs the `chronicle` CLI and automatically sets up launchd so the server starts at login.

**CLI commands:**

```bash
chronicle start          # start server in foreground
chronicle stop           # stop the running server
chronicle status         # show server and launchd status
chronicle setup          # install/reinstall launchd background service
chronicle                # show help
```

**Service management:**

```bash
chronicle setup          # re-run service installation
chronicle status         # check server + launchd status
tail -f ~/.chronicle/logs/server.log   # view logs
```

### Option 2: Build from source

1. **Clone**

   ```bash
   git clone git@github.com:kurtyan/Chronicle.git chronicle
   cd chronicle
   ```

2. **Build**

   ```bash
   npm run publish:prepare        # builds web + server, creates publishable package
   cd dist/chronicle-npm && npm publish   # publish to npm (optional)
   ```

   Or for a local artifact:

   ```bash
   npm run build              # full build: frontend + server artifact
   cd tauri && npm run tauri:build   # desktop app (requires Rust)
   ```

3. **Config** — create `~/.chronicle/config.json`:

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

4. **Start the server**

   ```bash
   cd dist/chronicle && ./start.sh
   ```

   The server initializes the DB (WAL mode), starts hourly backups, and serves the web UI at `http://127.0.0.1:8080/`.

   Alternatively, use the npm script:

   ```bash
   cd dist/chronicle && npm start
   ```

5. **Verify**

   ```bash
   curl http://localhost:8080/api/reports/summary
   ```

6. **Open the Tauri app**

   ```bash
   open tauri/src-tauri/target/release/bundle/macos/Chronicle.app
   ```

   The app enforces single-instance — launching a second time focuses the existing window.

---

## macOS Background Service (launchd)

The server can run as a macOS background service managed by `launchd`, so it starts automatically at login and stays running in the background.

### Via Settings UI

Open the Settings page in the Tauri app — there are controls to install, check status, and uninstall the launchd service.

### Via API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/settings/launchd/status` | Check if service is installed |
| `POST` | `/api/settings/launchd/install` | Install and load launchd service |
| `POST` | `/api/settings/launchd/uninstall` | Uninstall launchd service |
| `GET`  | `/api/settings/launchd/plist` | Preview generated plist content |

Example:

```bash
# Check status
curl http://localhost:8080/api/settings/launchd/status

# Install service (starts at login, auto-restarts)
curl -X POST http://localhost:8080/api/settings/launchd/install

# Uninstall service
curl -X POST http://localhost:8080/api/settings/launchd/uninstall
```

### What gets installed

A plist file at `~/Library/LaunchAgents/com.chronicle.server.plist` that:

- Runs the bundled server (`dist/index.js`) with the system Node.js
- Starts at login (`RunAtLoad`) and keeps alive (`KeepAlive`)
- Logs stdout to `~/.chronicle/logs/server.log`
- Logs stderr to `~/.chronicle/logs/server-error.log`

### Manual management

```bash
# Check if loaded
launchctl list | grep chronicle

# View logs
tail -f ~/.chronicle/logs/server.log
tail -f ~/.chronicle/logs/server-error.log

# Manual unload / reload
launchctl unload ~/Library/LaunchAgents/com.chronicle.server.plist
launchctl load ~/Library/LaunchAgents/com.chronicle.server.plist
```

---

## Data Management

### Database

- Default: `./data/tasks.db` relative to the server artifact directory.
- WAL mode enabled for concurrent-read safety.

### Backups

- **Automatic**: hourly to `~/.chronicle/backups/tasks-{timestamp}.db`
- **Retention**: last 24 backups
- **On startup**: creates an initial backup

### Export / Import (Settings page)

- **Export**: native save-file dialog (Tauri) with browser-download fallback. Lets you pick the destination.
- **Import**: file picker → confirmation dialog warning that all current data will be replaced. A pre-import backup is created automatically before overwriting.

---

## API Endpoints

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/tasks` | List tasks (`?type=`, `?status=` query params) |
| `GET`    | `/api/tasks/today` | Today view: high-priority pending/doing + 1 earliest daily improve + 1 earliest to-read |
| `GET`    | `/api/tasks/:id` | Get task by ID |
| `POST`   | `/api/tasks` | Create task |
| `PUT`    | `/api/tasks/:id` | Update task |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `PUT`    | `/api/tasks/:id/done` | Mark task as done |
| `POST`   | `/api/tasks/:id/drop` | Drop task with reason |

### Logs / Entries

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/tasks/:id/logs` | Get task entries |
| `POST` | `/api/tasks/:id/logs` | Submit task entry (`content`, `type` — `log` or `body`) |
| `PUT`  | `/api/tasks/:id/logs/:entryId` | Update task entry |

### Work Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks/:id/takeover` | Start work session (PENDING → DOING) |
| `POST` | `/api/afk` | Go AFK (stop session timer, does not change task status) |
| `GET`  | `/api/sessions/current` | Get current session |
| `GET`  | `/api/sessions` | List sessions (`?start=`, `?end=` timestamps) |

### Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reports/today` | Today's report (totals + tasks) |
| `GET` | `/api/reports/summary` | Summary by type and priority |
| `GET` | `/api/reports/range-stats` | Stats for a date range (`?start=`, `?end=` unix timestamps) |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/settings/export` | Download database file |
| `POST` | `/api/settings/import` | Import database (validates SQLite magic, auto-backs up current DB) |
| `GET`  | `/api/settings/info` | DB path, size, last backup time |
| `GET`  | `/api/settings/launchd/status` | Check launchd service status |
| `POST` | `/api/settings/launchd/install` | Install launchd service (macOS only) |
| `POST` | `/api/settings/launchd/uninstall` | Uninstall launchd service |
| `GET`  | `/api/settings/launchd/plist` | Get generated plist content |

### Real-time Events

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/events` | SSE stream (`?clientId=` for source filtering) |

Events: `task_created`, `task_updated`, `task_deleted`, `entry_created`, `entry_updated`, `session_started`, `session_ended`, `db_imported`.

---

## Features

### Task Board

- **Multi-type filter** (OR logic): select any combination of Task, To Read, Daily Improve. None selected = all non-done/dropped tasks.
- **Today view**: shows high-priority incomplete tasks + earliest daily improve + earliest to-read. Mutually exclusive with type filters.
- **Status filters**: New / Done / Dropped in an animated expand/collapse panel. Auto-collapses after 3s when no status filter is active.
- **Rich text editor** (TipTap): bold, italic, strikethrough, headings, lists, blockquotes, code blocks, links, and images (paste from clipboard, drag & drop with resize).
- **Created time**: shown on each task in the list (relative within 7 days, absolute otherwise).

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + R` | Refresh current page (task list or report) |
| `Cmd/Ctrl + T` | Toggle Today view |
| `Cmd/Ctrl + W` | Blur editor / clear Done or Dropped filter |
| `Cmd/Ctrl + S` | Save / submit draft or log entry |
| `Cmd/Ctrl + Enter` | Save / submit draft or log entry |
| `Cmd/Ctrl + Q` | Go AFK (stop session timer) |
| `n` | Create new task |
| `↑ / ↓` | Navigate between tasks |
| `→` | Focus log editor for selected task |
| `Esc` | Close dialogs / cancel draft |

### Desktop Shell

- Tauri v2, single-instance (re-focuses existing window on second launch)
- Default window: 1200×800, resizable, min 800×600
- Prevents accidental close via Cmd+W / Cmd+Q — use the app's exit mechanism

### Localization

- English (en) and Simplified Chinese (zh-CN) via `@/i18n/context`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Zustand, Tailwind CSS, TipTap, dnd-kit, Radix UI, axios, date-fns |
| Build | Vite (web), Tauri CLI (native), tsup (server) |
| Backend | Hono (Node.js), better-sqlite3 |
| Desktop | Tauri v2 (single-instance plugin) |
| Database | SQLite (WAL mode) |
| macOS Service | launchd (LaunchAgents) |
