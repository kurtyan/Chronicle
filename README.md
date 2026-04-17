# Task Manager

A local-first task management app with a Tauri desktop shell and a local Hono + SQLite server.

## Architecture

```
┌─────────────────────┐
│  Tauri Desktop App  │  ← Native window (macOS .app / Linux binary)
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
cd tauri && npm install && npm run dev
```

### Tauri desktop (native window, hot reload)

```bash
cd tauri && npm run tauri:dev
```

---

## Build

### Server artifact (standalone)

```bash
node build.js            # outputs to ./dist/task-manager/
```

Bundles the minified server, web assets, and installs only production dependencies. Run with `./start.sh`.

### Tauri desktop app

```bash
cd tauri && npm run tauri:build
```

Outputs:
- **macOS**: `tauri/src-tauri/target/release/bundle/macos/Task Manager.app`
- **macOS DMG**: `tauri/src-tauri/target/release/bundle/dmg/Task Manager_*.dmg`
- **Linux**: `.deb` + AppImage in `tauri/src-tauri/target/release/bundle/`

---

## Deployment

### On the working machine

1. **Clone**

   ```bash
   git clone git@github.com:kurtyan/Chronicle.git task-manager
   cd task-manager
   ```

2. **Build**

   ```bash
   node build.js          # server artifact
   cd tauri && npm run tauri:build   # desktop app (requires Rust)
   ```

3. **Config** — create `~/.chronicle/config.json`:

   ```json
   {
     "server": { "host": "127.0.0.1", "port": 8080, "database": "" },
     "lauri": { "serverHost": "localhost", "serverPort": 8080 }
   }
   ```

   | Field | Description |
   |---|---|
   | `server.host` / `server.port` | Server bind address |
   | `server.database` | SQLite path (empty = auto `./data/tasks.db`) |
   | `lauri.*` | Tauri app connection target |

4. **Start the server**

   ```bash
   cd dist/task-manager && ./start.sh
   ```

   The server initializes the DB (WAL mode), starts hourly backups, and serves the web UI at `http://127.0.0.1:8080/`.

5. **Verify**

   ```bash
   curl http://localhost:8080/api/reports/summary
   ```

6. **Open the Tauri app**

   ```bash
   open tauri/src-tauri/target/release/bundle/macos/Task\ Manager.app
   ```

   The app enforces single-instance — launching a second time focuses the existing window.

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
| `POST` | `/api/tasks/:id/logs` | Submit task entry (`body` or `log`) |
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

### Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/settings/export` | Download database file |
| `POST` | `/api/settings/import` | Import database (validates SQLite magic, auto-backs up current DB) |
| `GET`  | `/api/settings/info` | DB path, size, last backup time |

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

### Localization

- English (en) and Simplified Chinese (zh-CN) via `@/i18n/context`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Zustand, Tailwind CSS, TipTap, dnd-kit, Radix UI, axios, date-fns |
| Build | Vite (web), Tauri CLI (native) |
| Backend | Hono (Node.js), better-sqlite3 |
| Bundling | tsup (server, single-file minified) |
| Desktop | Tauri v2 (single-instance plugin) |
| Database | SQLite (WAL mode) |
