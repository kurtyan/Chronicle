## Skill Usage Rules

- When the user says "send to chronicle" or "log to chronicle" or similar, ALWAYS use the `send` skill — do NOT call the `add_log` MCP tool directly. The `send` skill handles binding lookup, HTML formatting, and conversation ID binding.
- When the user provides a Chronicle task ID to bind, use the `bind` skill.

## Build & Run

### Dev mode

```bash
./dev.sh              # start dev server + dev web + dev tauri
```

### Release build

```bash
npm run release       # full pipeline: clean → version → build → pack → install → tauri build
```

This produces:
- `dist/chronicle/` — server artifact
- `dist/chronicle-npm/` — npm publishable package
- `tauri/src-tauri/target/release/bundle/macos/Chronicle.app` — desktop app

### Individual steps

```bash
npm run clean         # clean dist
npm run build         # build web + server + artifact
npm run publish:local # pack and install globally
```

### Start release server

```bash
chronicle stop && chronicle start
```

### Launch release Tauri client

```bash
pkill -f "Chronicle.app" || true
open tauri/src-tauri/target/release/bundle/macos/Chronicle.app
```
