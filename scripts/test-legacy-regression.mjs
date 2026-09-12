// Run legacy browser regression against an already-built artifact, with an
// isolated database and unused ports. Build web/server before invoking this.
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-legacy-project-regression-'))
const serverPort = await port()
let mcpPort = await port()
while (serverPort === mcpPort) mcpPort = await port()
const env = { ...process.env, CHRONICLE_TEST_DATA_DIR: directory, CHRONICLE_TEST_PORT: String(serverPort), CHRONICLE_TEST_MCP_PORT: String(mcpPort) }
const requested = process.argv.slice(2)
console.log(JSON.stringify({ directory, serverPort, mcpPort, reusedBuild: true }))
const child = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.project.config.ts', ...(requested.length ? requested : ['tests/notes.test.ts', 'tests/data-integrity.test.ts', 'tests/search-relevance.test.ts', 'tests/search-done-detail.test.ts'])], { cwd: root, env, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
