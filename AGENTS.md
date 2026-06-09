## Skill Usage Rules

- When the user says "send to chronicle" or "log to chronicle" or similar, ALWAYS use the `send` skill — do NOT call the `add_log` MCP tool directly. The `send` skill handles binding lookup, HTML formatting, and conversation ID binding.
- When the user provides a Chronicle task ID to bind, use the `bind` skill.

## Environment Notes

- In Codex/non-interactive shells on this machine, `PATH` may resolve `/usr/local/bin/node` and `/usr/local/bin/npm` first. Those binaries are an old Node 6 / npm 3 install and will break modern TypeScript/Vite builds.
- Prefer the repo helper `./scripts/with-node.sh ...` for Chronicle Node/npm commands. It promotes a modern Node runtime from `NVM_BIN` or `nvm current` before executing the command.
- Before running any Chronicle Node/npm command, verify the effective toolchain with `type node`, `type npm`, `node -v`, and `npm -v`.
- If the shell resolves to the old `/usr/local/bin/node` or `/usr/local/bin/npm`, prepend the active Node 25 bin directory to `PATH` before running build commands. Prefer a dynamic approach such as:

```bash
./scripts/with-node.sh npm run build
```

- If `nvm` is unavailable in the current shell but `NVM_BIN` is present, `./scripts/with-node.sh` will use `NVM_BIN`. If neither is available, inspect the current environment first instead of hardcoding a user-specific absolute path into repo docs.
- Do not assume `which node` from an interactive terminal matches the non-interactive build environment. Verify both `type node`/`type npm` and the effective `PATH` when builds behave inconsistently.

## Build & Run

### Dev mode

```bash
./dev.sh              # start dev server + dev web + dev tauri
```

### Release build

```bash
npm run release       # full pipeline: clean → version → build → pack → install → tauri build
```

Notes:
- `npm run release` ends with `git checkout -- ...` inside the release script to restore Tauri version files. Treat it as a destructive command and do not run it unless the user explicitly wants the release pipeline.

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

Notes:
- This assumes the `chronicle` CLI is already installed globally, typically via `npm run publish:local`. It is not a generic "start from source tree" command.

### Launch release Tauri client

```bash
pkill -f "Chronicle.app" || true
open tauri/src-tauri/target/release/bundle/macos/Chronicle.app
```
