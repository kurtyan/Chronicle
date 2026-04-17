# Task Manager

A local-first task management app built with React + Hono + SQLite. Runs as a standalone native window (Tauri) backed by a local server process.

## Architecture

```
┌─────────────────────┐
│  Tauri Native App   │  ← Single-instance window (macOS .app / Linux binary)
│  (React + Vite)     │  ← Connects to localhost:8080 via HTTP
└────────┬────────────┘
         │ HTTP localhost:8080
┌────────▼────────────┐
│  Hono Server        │  ← Bundled single-file Node.js (tsup, ~12 KB)
│  (better-sqlite3)   │  ← On-disk SQLite with WAL mode
└────────┬────────────┘
         │
┌────────▼────────────┐
│  ~/.chronicle/      │  ← Config file + hourly backups
│  data/tasks.db      │  ← SQLite database (WAL mode)
└─────────────────────┘
```

## Prerequisites

- **Node.js** >= 18 (for both server and web builds)
- **npm** >= 9
- **Rust** >= 1.70 + `cargo` (for Tauri builds only)
- **macOS**: Xcode Command Line Tools; **Linux**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (see [Tauri Linux setup](https://tauri.app/start/prerequisites/))

---

## Development

### Server (hot reload)

```bash
cd server && npm install && npm run dev
```

Server starts at `http://127.0.0.1:8080`.

### Web UI (hot reload, proxied to server)

```bash
cd tauri && npm install && npm run dev
```

Vite dev server at `http://localhost:5173`, proxies `/api` to `localhost:8080`.

### Tauri dev (native window)

```bash
cd tauri && npm run tauri:dev
```

Requires Rust toolchain. Opens a native app window with hot-reload.

---

## Build

### 1. Build server artifact (standalone)

```bash
node build.js          # outputs to ./dist/task-manager/
```

This bundles:
- `dist/index.js` — minified server code (single file)
- `public/` — web frontend assets (index.html + assets)
- `start.sh` — startup script
- `node_modules/` — production-only dependencies

The artifact can run standalone with just `./start.sh`.

### 2. Build Tauri native app

```bash
cd tauri && npm run tauri:build
```

Outputs:
- **macOS**: `tauri/src-tauri/target/release/bundle/macos/Task Manager.app`
- **macOS DMG**: `tauri/src-tauri/target/release/bundle/dmg/Task Manager_*.dmg`
- **Linux**: `tauri/src-tauri/target/release/bundle/deb/*.deb` + AppImage

The Tauri app is a native window that connects to the local server at `localhost:8080`.

### 3. Full build (server artifact + Tauri)

```bash
# Step 1: clone + build server artifact
git clone git@github.com:kurtyan/Chronicle.git task-manager
cd task-manager
node build.js

# Step 2: build Tauri (requires Rust)
cd tauri && npm install && npm run tauri:build
```

---

## Deployment

### On the working machine

1. **Clone the repo**

   ```bash
   git clone git@github.com:kurtyan/Chronicle.git task-manager
   cd task-manager
   ```

2. **Build the server artifact**

   ```bash
   node build.js
   ```

   Artifact is at `./dist/task-manager/`.

3. **Create the config file**

   ```bash
   mkdir -p ~/.chronicle
   cat > ~/.chronicle/config.json << 'EOF'
   {
     "server": {
       "host": "127.0.0.1",
       "port": 8080,
       "database": ""
     },
     "lauri": {
       "serverHost": "localhost",
       "serverPort": 8080
     }
   }
   EOF
   ```

   | Field | Description |
   |-------|-------------|
   | `server.host` | Host the server binds to |
   | `server.port` | Port the server listens on |
   | `server.database` | Absolute path to the SQLite .db file. Empty = auto at `./data/tasks.db` |
   | `lauri.serverHost/Port` | Tauri app connection target |

4. **Start the server**

   ```bash
   cd dist/task-manager
   ./start.sh
   ```

   The server will:
   - Initialize the SQLite database at `./data/tasks.db` (WAL mode)
   - Create an initial backup at `~/.chronicle/backups/`
   - Set up hourly automatic backups (retains last 24)
   - Serve the web UI at `http://127.0.0.1:8080/`
   - Expose the REST API at `http://127.0.0.1:8080/api/`

5. **Verify the server**

   ```bash
   curl http://localhost:8080/api/reports/summary
   # Expected: {"byType":{},"byPriority":{},"totalTasks":0}
   ```

6. **Open the Tauri app**

   If you built the Tauri `.app`, double-click it or run:

   ```bash
   open tauri/src-tauri/target/release/bundle/macos/Task\ Manager.app
   ```

   The app connects to the running server at `localhost:8080`. It enforces single-instance — launching a second time focuses the existing window.

### Serverless mode (web UI only)

You can also use the web UI directly in a browser without the Tauri app:

```bash
./start.sh
# Then open http://127.0.0.1:8080 in your browser
```

---

## Data Management

### Database location

By default: `./data/tasks.db` relative to the server artifact directory. Override with `server.database` in `~/.chronicle/config.json`.

### Backups

- **Automatic**: Hourly backup to `~/.chronicle/backups/tasks-{timestamp}.db`
- **Retention**: Last 24 backups are kept; older ones are pruned
- **On startup**: A fresh backup is created if none exists in the last hour

### Export / Import

Available via **Settings** page in the UI, or API:

```bash
# Export (download current .db file)
curl -o export.db http://localhost:8080/api/settings/export

# Import (replace current database)
# POST multipart/form-data with "file" field
curl -X POST -F "file=@export.db" http://localhost:8080/api/settings/import
```

Import validates SQLite magic bytes and creates a pre-import backup before replacing.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tasks` | List tasks (query: `type`, `status`) |
| `GET` | `/api/tasks/today` | Today view: high-priority + 1 daily improve + 1 to-read |
| `GET` | `/api/tasks/:id` | Get task by ID |
| `POST` | `/api/tasks` | Create task |
| `PUT` | `/api/tasks/:id` | Update task |
| `PUT` | `/api/tasks/:id/done` | Mark task done |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `POST` | `/api/tasks/:id/takeover` | Start work session on task |
| `POST` | `/api/tasks/:id/drop` | Drop task with reason |
| `GET` | `/api/tasks/:id/logs` | Get task entries (chronicle logs) |
| `POST` | `/api/tasks/:id/logs` | Submit task entry |
| `PUT` | `/api/tasks/:id/logs/:entryId` | Update task entry |
| `POST` | `/api/afk` | Go AFK (stop current session timer) |
| `GET` | `/api/sessions/current` | Get current work session |
| `GET` | `/api/sessions` | List sessions (`start`, `end` params) |
| `GET` | `/api/reports/today` | Today report |
| `GET` | `/api/reports/summary` | Summary by type and priority |
| `GET` | `/api/settings/info` | DB info (path, size, last backup) |
| `GET` | `/api/settings/export` | Download database file |
| `POST` | `/api/settings/import` | Import database file |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | Toggle Today view |
| `Cmd+W` | Close Done/Dropped filter (when active) |
| `Cmd+Enter` | Submit draft task |
| `Cmd+N` | Focus new task input |
| `Esc` | Close editor / cancel draft |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Zustand, Tailwind CSS, TipTap (rich text editor) |
| Build | Vite (web), Tauri CLI (native) |
| Backend | Hono (Node.js), better-sqlite3 |
| Bundling | tsup (server, single-file minified) |
| Desktop | Tauri v2 (single-instance plugin) |
| Database | SQLite (WAL mode) |
