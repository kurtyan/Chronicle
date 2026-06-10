#!/usr/bin/env bash
#
# Chronicle dev environment launcher
# Uses configured or automatically allocated ports and isolated DB, then starts server + tauri.
#
# Usage: bash dev.sh
#        CHRONICLE_SERVER_PORT=18080 PORT=18090 CHRONICLE_MCP_PORT=18081 bash dev.sh
#
set -e
cd "$(dirname "$0")"

if [[ "${CHRONICLE_NODE_READY:-0}" != "1" ]]; then
  export CHRONICLE_NODE_READY=1
  exec "$PWD/scripts/with-node.sh" bash "$0" "$@"
fi

# Find an unused port starting from $1
find_port() {
  local port=$1
  while lsof -ti:$port >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo $port
}

validate_port() {
  local name=$1
  local port=$2
  if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
    echo "Invalid $name: $port" >&2
    exit 1
  fi
}

ensure_port_free() {
  local name=$1
  local port=$2
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "$name port $port is already in use. Choose a different port for this agent session." >&2
    exit 1
  fi
}

# Allocate ports (18xxx range to avoid conflict with production 9983), unless explicitly provided.
SERVER_PORT="${CHRONICLE_SERVER_PORT:-$(find_port 18080)}"
TAURI_VITE_PORT="${PORT:-$(find_port 18090)}"
MCP_PORT="${CHRONICLE_MCP_PORT:-}"

validate_port "CHRONICLE_SERVER_PORT" "$SERVER_PORT"
validate_port "PORT" "$TAURI_VITE_PORT"
ensure_port_free "Server" "$SERVER_PORT"
ensure_port_free "Tauri/Vite" "$TAURI_VITE_PORT"

if [[ -n "$MCP_PORT" ]]; then
  validate_port "CHRONICLE_MCP_PORT" "$MCP_PORT"
  ensure_port_free "MCP" "$MCP_PORT"
  export CHRONICLE_MCP_PORT="$MCP_PORT"
fi

# Dev DB path (isolated from production ~/.chronicle/data.db)
DEV_DB_DIR="$PWD/.dev-data"
mkdir -p "$DEV_DB_DIR"
DEV_DB="$DEV_DB_DIR/tasks-dev.db"
DEV_ATTACHMENT_DIR="$DEV_DB_DIR/attachments"
DEV_CHRONICLE_HOME="$DEV_DB_DIR/chronicle-home"
DEV_LOG_DIR="$DEV_CHRONICLE_HOME/logs"
mkdir -p "$DEV_ATTACHMENT_DIR"
mkdir -p "$DEV_CHRONICLE_HOME"
mkdir -p "$DEV_LOG_DIR"

# Generate unique dev version (per-session, no file written — avoids multi-session conflict)
DEV_VERSION=$(node "$PWD/scripts/generate-version.js")

# Export env vars — all child processes inherit them
export CHRONICLE_SERVER_PORT=$SERVER_PORT
export CHRONICLE_DB_PATH=$DEV_DB
export CHRONICLE_ATTACHMENT_DIR=$DEV_ATTACHMENT_DIR
export CHRONICLE_CONFIG_DIR="$DEV_CHRONICLE_HOME"
export CHRONICLE_CONFIG_PATH="$DEV_CHRONICLE_HOME/config.json"
export CHRONICLE_LOG_DIR="$DEV_LOG_DIR"
export CHRONICLE_LOG_PATH="$DEV_LOG_DIR/server.log"
export CHRONICLE_LAURI_SERVER_PORT=$SERVER_PORT
export CHRONICLE_VERSION=$DEV_VERSION
export PORT=$TAURI_VITE_PORT

echo "=== Chronicle Dev Environment ==="
echo "Version:         $DEV_VERSION"
echo "Server port:     $SERVER_PORT"
if [[ -n "$MCP_PORT" ]]; then
  echo "MCP port:        $MCP_PORT"
fi
echo "Tauri dev URL:   http://localhost:$TAURI_VITE_PORT"
echo "Database:        $DEV_DB"
echo "Attachments:     $DEV_ATTACHMENT_DIR"
echo "Config dir:      $DEV_CHRONICLE_HOME"
echo "================================="
echo ""

# Patch tauri.conf.json devUrl to point to our vite port
TAURI_CONF="tauri/src-tauri/tauri.conf.json"
TAURI_CONF_BAK="$TAURI_CONF.bak"
cp "$TAURI_CONF" "$TAURI_CONF_BAK"
node -e "
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync('$TAURI_CONF','utf8'));
conf.build.devUrl = 'http://localhost:$TAURI_VITE_PORT';
fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
"

# Cleanup on exit — restore original devUrl and kill processes
cleanup() {
  echo ""
  echo "Stopping dev environment..."
  # Restore original devUrl
  mv "$TAURI_CONF_BAK" "$TAURI_CONF"
  kill $SERVER_PID $TAURI_PID 2>/dev/null || true
  wait $SERVER_PID $TAURI_PID 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

# Start server (tsx watch)
cd server
npm run dev -- --port $SERVER_PORT &
SERVER_PID=$!
cd ..

# Start Tauri dev (beforeDevCommand starts vite on PORT)
cd tauri
npm run tauri:dev &
TAURI_PID=$!
cd ..

wait
