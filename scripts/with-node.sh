#!/usr/bin/env bash

set -euo pipefail

min_major="${CHRONICLE_MIN_NODE_MAJOR:-20}"

node_major() {
  local bin="$1"
  "$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

is_modern_node() {
  local bin="$1"
  local major
  major="$(node_major "$bin")"
  [[ -n "$major" && "$major" =~ ^[0-9]+$ && "$major" -ge "$min_major" ]]
}

activate_node_bin() {
  local bin_dir="$1"
  export PATH="$bin_dir:$PATH"
}

if command -v node >/dev/null 2>&1 && is_modern_node "$(command -v node)"; then
  exec "$@"
fi

if [[ -n "${NVM_BIN:-}" ]] && [[ -x "${NVM_BIN}/node" ]] && is_modern_node "${NVM_BIN}/node"; then
  activate_node_bin "$NVM_BIN"
  exec "$@"
fi

if [[ -n "${NVM_DIR:-}" && -s "${NVM_DIR}/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "${NVM_DIR}/nvm.sh"
elif [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
fi

if command -v nvm >/dev/null 2>&1; then
  resolved_node="$(nvm which current 2>/dev/null || true)"
  if [[ -x "$resolved_node" ]] && is_modern_node "$resolved_node"; then
    activate_node_bin "$(dirname "$resolved_node")"
    exec "$@"
  fi
fi

echo "Unable to resolve a modern Node.js runtime (major >= ${min_major})." >&2
echo "Checked current PATH, NVM_BIN, and nvm current." >&2
exit 1
