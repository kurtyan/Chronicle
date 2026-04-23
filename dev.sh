#!/usr/bin/env bash
#
# Chronicle dev environment launcher
# Allocates unused ports and isolated DB, then starts server + tauri.
#
# Usage: bash dev.sh
#
set -e
cd "$(dirname "$0")"

# Find an unused port starting from $1
find_port() {
  local port=$1
  while lsof -ti:$port >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo $port
}

# Allocate ports (18xxx range to avoid conflict with production 9983)
SERVER_PORT=$(find_port 18080)
TAURI_VITE_PORT=$(find_port 18090)

# Dev DB path (isolated from production ~/.chronicle/data.db)
DEV_DB_DIR="$PWD/.dev-data"
mkdir -p "$DEV_DB_DIR"
DEV_DB="$DEV_DB_DIR/tasks-dev.db"

# Export env vars — all child processes inherit them
export CHRONICLE_SERVER_PORT=$SERVER_PORT
export CHRONICLE_DB_PATH=$DEV_DB
export CHRONICLE_LAURI_SERVER_PORT=$SERVER_PORT
export PORT=$TAURI_VITE_PORT

echo "=== Chronicle Dev Environment ==="
echo "Server port:       $SERVER_PORT"
echo "Tauri dev URL:     http://localhost:$TAURI_VITE_PORT"
echo "Database:          $DEV_DB"
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
