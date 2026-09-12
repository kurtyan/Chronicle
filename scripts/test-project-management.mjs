// Allocate a new database and loopback ports for every run. Never clean a
// shared developer database or depend on one particular user's Node path.
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function unusedPort() {
  const listener = net.createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-tests-'))
const serverPort = await unusedPort()
let mcpPort = await unusedPort()
while (mcpPort === serverPort) mcpPort = await unusedPort()
const environment = { ...process.env, CHRONICLE_TEST_PORT: String(serverPort), CHRONICLE_TEST_MCP_PORT: String(mcpPort), CHRONICLE_TEST_DATA_DIR: directory }
console.log(`Isolated project tests: ${directory}; server ${serverPort}, MCP ${mcpPort}`)
for (const project of ['web', 'server']) {
  const buildCode = await new Promise((resolve, reject) => {
    const build = spawn(path.join(root, 'scripts/with-node.sh'), ['npm', '--prefix', project, 'run', 'build'], { cwd: root, env: environment, stdio: 'inherit' })
    build.once('error', reject)
    build.once('exit', code => resolve(code ?? 1))
  })
  if (buildCode !== 0) process.exit(Number(buildCode))
}
const args = process.argv.slice(2)
const child = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.project.config.ts', ...(args.length ? args : ['tests/project-management.test.ts', 'tests/project-ui.test.ts', 'tests/project-gantt-ui.test.ts', 'tests/project-area-summary-ui.test.ts', 'tests/project-notes-filter-ui.test.ts'])], { cwd: root, env: environment, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
