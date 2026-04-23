# Chronicle v1.2.0 Release Notes

## Summary

v1.2.0 adds Claude Code integration (bidirectional task binding), rich image support in the editor, an image viewer for inline attachments, and MCP tool enhancements.

---

## New Features

### Claude Code ↔ Chronicle Integration

Bidirectional task management between Claude Code and Chronicle:

- **Task binding** — Bind a Chronicle task to a Claude conversation. Each conversation gets its own isolated binding file.
- **Send logs** — Send conversation summaries to Chronicle task logs with HTML formatting. Explicit taskId support (no binding required).
- **Work summaries** — "Summarize today/yesterday/this week" generates AFK analysis, task reviews, and tomorrow's plans.
- **Conversation ID tracking** — `X-Claude-Conversation-Id` header on all write operations. Server stores it in task extra info. MCP tools (`get_task`, `takeover_task`) return `claude_conversation_id`.
- **Skills system** — Installable via `skills/INSTALL.md` with version tracking and manifest-driven updates.
- **Frontend "Claude" button** — Open Terminal.app with a Chronicle task session directly from the board.

### Rich Image Support in Editor

- Paste images directly into the RichEditor — stored as file references on disk (not base64 in SQLite).
- Configurable attachment directory via `CHRONICLE_ATTACHMENT_DIR` env var.
- Automatic timestamp-based file naming for collision avoidance.
- Tauri `save_editor_image` and `resolve_attachment_path` commands.

### Inline Image Viewer

- Zoom-in icon appears on images in task entries.
- Click to open fullscreen overlay with:
  - Mouse wheel zoom (0.1x–5x)
  - Click to drag/pan when zoomed in
  - Escape or × to close
  - Dark background with centered image

---

## Improvements

### MCP Bridge

- Migrated from `server/src/mcp/` to `skills/mcp-bridge.mjs` (development), then published as `chronicle-mcp` CLI via `publish.js`.
- Added `conversationId` parameter to write tools (`get_task`, `takeover_task`, `create_task`, `update_task_status`, `add_log`).
- Tools now attach `X-Claude-Conversation-Id` header when provided.
- `get_task` and `takeover_task` responses include `claude_conversation_id` for tracking.

### Task Entry Block

- Tauri attachment paths resolved via `CHRONICLE_ATTACHMENT_DIR` instead of hardcoded `~/.chronicle/attachment/`.
- Images stored in TaskEntryBlock content render correctly in Tauri via `convertFileSrc`.
- Copy button feedback with animated icon.

### RichEditor

- Fixed `addNodeView` for TipTap image extension — proper function chaining with parent NodeViewRenderer.
- ImageResize extension properly typed with `NodeViewRenderer` and `NodeViewRendererProps`.
- HTML image attributes correctly typed (`HTMLImageElement` for `querySelectorAll`).

---

## Build & Infrastructure

- **Skills installation** — Project-local `.claude/commands/` (flat structure: `/bind`, `/send`, `/summarize`).
- **Manifest-driven updates** — `skills/manifest.json` drives which skills are installed and version checking.
- **MCP server config** — `chronicle-mcp` as bin command (via `publish.js` generated package.json), no longer requires `node` + path args.
- **Cleanup** — Removed `skills/package.json` and `node_modules` (duplicate of server deps).
- **Image migration script** — `server/scripts/migrate-images.js` for converting base64 images to file references.

---

## API Changes

### Modified Responses

| Method | Path | Change |
|--------|------|--------|
| `GET` | `/api/tasks/:id` | Added `claude_conversation_id` field |

### New Tauri Commands

| Command | Description |
|---------|-------------|
| `save_editor_image` | Save pasted image to attachment directory, returns `{fileName, filePath}` |
| `resolve_attachment_path` | Resolve attachment file path for image viewer |

---

## Tech Stack Updates

- **TipTap** — NodeViewRenderer pattern for image extension
- **Lucide** — `ZoomIn`, `ZoomOut`, `X` icons for image viewer
- **lucide-react** — Added to Tauri dependencies

---

## Migration

Existing `tasks.db` is fully compatible.

If your database contains base64-embedded images in task logs, run `node server/scripts/migrate-images.js` to extract them to file references and reduce database size.
