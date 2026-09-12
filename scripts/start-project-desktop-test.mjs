// Start the built desktop client with a fresh, worktree-local database.
// All business data for manual Computer Use acceptance is entered through UI.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = path.join(root, '.dev-data')
fs.mkdirSync(base, { recursive: true })
const requestedDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null
if (requestedDirectory && (path.dirname(requestedDirectory) !== base || !path.basename(requestedDirectory).startsWith('project-manual-') || !fs.statSync(requestedDirectory).isDirectory())) throw new Error('Resume only a project-manual-* directory under this worktree .dev-data')
const directory = requestedDirectory ?? fs.mkdtempSync(path.join(base, 'project-manual-'))
const listener = net.createServer()
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const configPath = path.join(directory, 'config.json')
const existingConfig = requestedDirectory ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { ui: { language: 'zh-CN' }, auto_afk: { enabled: false, screen_lock_enabled: false, idle_enabled: false, idle_timeout_seconds: 180 } }
fs.writeFileSync(configPath, JSON.stringify({ ...existingConfig, server: { ...existingConfig.server, host: '127.0.0.1', port }, lauri: { ...existingConfig.lauri, serverPort: port } }))
const env = { ...process.env, CHRONICLE_SERVER_PORT: String(port), CHRONICLE_LAURI_SERVER_PORT: String(port), CHRONICLE_CONFIG_DIR: directory, CHRONICLE_CONFIG_PATH: configPath, CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'), CHRONICLE_ATTACHMENT_DIR: path.join(directory, 'attachments'), CHRONICLE_LOG_DIR: path.join(directory, 'logs'), CHRONICLE_LOG_PATH: path.join(directory, 'logs/server.log'), CHRONICLE_ENABLE_LEGACY_MCP: '0', CHRONICLE_VERSION: 'MANUAL-UI-TEST', NO_PROXY: 'localhost,127.0.0.1' }
const output = fs.openSync(path.join(directory, 'process.log'), 'a')
const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], { cwd: path.join(root, 'server'), env, stdio: ['ignore', output, output] })
const baseURL = `http://127.0.0.1:${port}`
let app
let closed = false
function cleanup(code = 0) { if (closed) return; closed = true; app?.kill('SIGTERM'); server.kill('SIGTERM'); fs.closeSync(output); process.exit(code) }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => cleanup())
server.once('error', error => { console.error(error); cleanup(1) })
let ready = false
for (let attempt = 0; attempt < 50; attempt++) {
  try { if ((await fetch(`${baseURL}/api/version`)).ok) { ready = true; break } } catch {}
  await new Promise(resolve => setTimeout(resolve, 200))
}
if (!ready) { console.error('Isolated server did not become ready'); cleanup(1) }
const binary = path.join(root, 'tauri/src-tauri/target/debug/bundle/macos/Chronicle Project Test.app/Contents/MacOS/chronicle-tauri')
app = spawn(binary, [], { cwd: root, env, stdio: ['ignore', output, output] })
console.log(JSON.stringify({ directory, baseURL, serverPid: server.pid, appPid: app.pid, initialBusinessData: requestedDirectory ? 'resumed manual test data' : 'empty' }))
app.once('error', error => { console.error(error); cleanup(1) })
app.once('exit', code => { console.log(`Test desktop exited ${code}`); cleanup() })
