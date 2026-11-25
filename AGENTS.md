## Skill Usage Rules

- When the user says "send to chronicle" or "log to chronicle" or similar, ALWAYS use the `send` skill — do NOT call the `add_log` MCP tool directly. The `send` skill handles binding lookup, HTML formatting, and conversation ID binding.
- When the user provides a Chronicle task ID to bind, use the `bind` skill.

## Git Workflow

- Before starting work, run `git fetch origin main` to fetch the latest remote `main`.

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
- 新 worktree 可能没有安装依赖；若 `tauri: command not found` 或 Playwright 找不到包，先用 `./scripts/with-node.sh npm install`，并在 `tauri/` 下运行 `../scripts/with-node.sh npm install`。

### Managed Linux workspace

- Wait for the selected workspace to become ready before running repository commands. The managed Debian 13 workspace came with Node 24, npm 11, and `/usr/bin/chromium`. Check the current versions before applying the older local Node workaround above.
- A fresh checkout can lack both npm packages and Playwright browser binaries. For Work Outline browser tests, install dependencies from the root, web, and server lockfiles separately. The runner resolves Playwright from the root, which may lock a different version from `server/`.

  ```sh
  ./scripts/with-node.sh npm ci
  ./scripts/with-node.sh npm --prefix web ci
  ./scripts/with-node.sh npm --prefix server ci
  ./scripts/with-node.sh node node_modules/@playwright/test/cli.js install webkit
  ```

- If npm reports `connect EPERM`, retry a short `npm ping` with the managed shell's network permission. The default sandbox blocked the proxy connection, while npm worked with network permission. If npm cannot write its cache, pass `--cache` with a directory under `/tmp`. Keep the configured registry, proxy, and TLS settings.

### Browser testing on managed Linux

- Use the isolated runner below for Work Outline UI tests. It builds the web assets into `server/public`, builds the server, allocates a loopback port, and puts the test database and logs under `.dev-data/work-outline-ui-*`. Pass test paths or `--grep` to narrow the run. Use `--skip-build` only when the existing artifacts match the source being tested. The general `playwright.config.ts` has macOS-specific `/private/tmp` and NVM paths.

  ```sh
  ./scripts/with-node.sh node scripts/test-work-outline.mjs
  ```

- If Playwright's WebKit install returns `403 Domain forbidden`, the managed proxy is blocking the download. This occurred for `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`, and the image layers of `mcr.microsoft.com/playwright`. For a quick Chromium run, use a temporary checkout or copy and set `use.browserName` to `chromium` and `use.launchOptions.executablePath` to the installed Chromium path in its `playwright.work-outline.config.ts`. Keep the tracked WebKit configuration for the normal runner.
- Debian's WebKitGTK is available as a Linux rendering fallback. Use a `debian:trixie-slim` container with `webkitgtk-webdriver`, `xvfb`, `xauth`, and `dbus-daemon` installed from the Debian repositories. Unpacking the packages into `/tmp` alone failed because WebKit looks for its subprocesses at system paths. The WebKitWebDriver session also timed out, so the rendering check opened the test app in MiniBrowser directly under Xvfb.
- If Docker socket access reports `EPERM`, retry the managed socket with the appropriate shell permission. Set `BUILDX_CONFIG` to a writable temporary directory if `~/.docker/buildx` is read-only.
- Chromium can verify which shortcuts reach Tauri's `set_zoom` call with a mocked native bridge. Linux WebKitGTK can verify rendering and DOM key handling. The X11 Super key did not produce a Cmd event in the WebKitGTK probe. Verify physical Cmd keys, macOS text navigation, and native zoom in the Chronicle desktop app on a Mac. The GitHub CLI Actions endpoint returned `403` in this workspace, so check runner access before relying on it for macOS testing.

## Build & Run

### Dev mode

Before starting a dev environment, ask the user to assign ports for the current agent session when multiple worktrees/agents may run in parallel. Each agent should use distinct server, Tauri/Vite, and MCP ports, plus its own worktree-local `.dev-data` directory. Example allocation:

```bash
CHRONICLE_SERVER_PORT=18080 PORT=18090 CHRONICLE_MCP_PORT=18081 ./dev.sh
```

For additional agents, use a different range such as `18180/18190/18181` or `18280/18290/18281`. If the user explicitly approves automatic allocation, `./dev.sh` will choose unused server and Tauri/Vite ports starting from `18080` and `18090`.

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
