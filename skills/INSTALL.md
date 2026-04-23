# Chronicle Skills Installation

This file contains instructions for installing Chronicle skills in Claude Code.

## Installation Steps

Perform all of the following steps:

### 1. Create directories

Create `~/.claude/commands/chronicle/` if it doesn't exist.

Create `~/.chronicle/` and `~/.chronicle/bindings/` if they don't exist.

### 2. Copy skill files

Copy all files from `skills/chronicle/` to `~/.claude/commands/chronicle/`:
- `skills/chronicle/bind.md` → `~/.claude/commands/chronicle/bind.md`
- `skills/chronicle/send.md` → `~/.claude/commands/chronicle/send.md`
- `skills/chronicle/summarize.md` → `~/.claude/commands/chronicle/summarize.md`
- `skills/chronicle/check-updates.md` → `~/.claude/commands/chronicle/check-updates.md`

Use the absolute paths of the skill files — they are located at `<project-root>/skills/chronicle/`.

### 3. Register MCP server in Claude Code settings

Read `~/.claude/settings.json`. Add or update the `mcpServers` section to include:

```json
{
  "mcpServers": {
    "chronicle": {
      "command": "node",
      "args": ["<ABSOLUTE-PATH-TO-PROJECT>/skills/mcp-bridge.mjs"]
    }
  }
}
```

Replace `<ABSOLUTE-PATH-TO-PROJECT>` with the absolute path to the Chronicle project root (the directory containing `skills/`). Preserve any existing `mcpServers` entries — do not overwrite them.

If `~/.claude/settings.json` doesn't exist, create it with `{"mcpServers":{"chronicle":{"command":"node","args":["..."]}}}`.

### 4. Write installed version

Write `"1.0.0"` to `~/.chronicle/skills-version`.

### 5. Verify

Confirm all files are in place and report the installed version.
