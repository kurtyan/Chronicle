# Chronicle Skills Installation

This file contains instructions for installing Chronicle skills in Claude Code.

**`source_root`** — the directory containing `skills/INSTALL.md` and `skills/manifest.json`. Determine it by finding the nearest parent directory with `skills/manifest.json`.

**`target_root`** — the current working directory (where Claude Code is running).

## Installation Steps

### 1. Read manifest

Read `source_root/manifest.json`. Extract the `version` and `skills` array.

### 2. Check if update needed

Read `target_root/.claude/commands/chronicle/version`.

- If it exists and matches manifest version: "Chronicle skills v{version} already installed. Nothing to do."
- If it doesn't exist or is older: proceed to step 3.

### 3. Install / update skills

Create `target_root/.claude/commands/chronicle/` if it doesn't exist.

For each entry in `manifest.json.skills`:
1. Read `source_root/chronicle/<file>` (the `file` field from manifest, relative to `skills/chronicle/`)
2. Write the content to `target_root/.claude/commands/chronicle/<file>`

### 4. Write version

Write `manifest.json.version` to `target_root/.claude/commands/chronicle/version`.

### 5. Register MCP server

Read `target_root/.mcp.json` if it exists, otherwise start with `{}`. Parse as JSON, ensure `mcpServers.chronicle` is set to `{ "command": "chronicle-mcp" }`, preserving any existing entries. Write the result back to `target_root/.mcp.json`.

### 6. Verify

Confirm all skill files from the manifest are present in `target_root/.claude/commands/chronicle/` and report: "Installed Chronicle skills v{version}: {list of skill names}."
