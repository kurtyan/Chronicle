// All build and runtime artifacts stay under the repository; no production fallback.
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
fs.mkdirSync(path.join(root, '.dev-data'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, '.dev-data/work-outline-ui-'))
const listener = net.createServer()
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const env = { ...process.env, TMPDIR: directory, CHRONICLE_TEST_DATA_DIR: directory, CHRONICLE_TEST_PORT: String(port), NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' }
env.CHRONICLE_TEST_REGRESSIONS = process.argv.includes('--regressions') ? '1' : '0'
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
console.log(`Isolated work-outline tests: ${directory}; server port ${port}`)
async function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  const stop = signal => child.kill(signal)
  const int = () => stop('SIGINT'), term = () => stop('SIGTERM')
  process.once('SIGINT', int); process.once('SIGTERM', term)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  process.off('SIGINT', int); process.off('SIGTERM', term)
  if (code) process.exit(code)
}
if (!process.argv.includes('--skip-build')) for (const project of ['web', 'server']) await run(path.join(root, 'scripts/with-node.sh'), ['npm', '--prefix', project, 'run', 'build'])
await run(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.work-outline.config.ts', ...process.argv.slice(2).filter(a => !['--skip-build', '--regressions'].includes(a))])
