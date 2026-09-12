import { test as base, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inProcess = process.env.CHRONICLE_TEST_IN_PROCESS === '1'
type Harness = { app: typeof import('../../server/src/app').app; directory: string }

export const test = base.extend<{}, { harness: Harness | null }>({
  harness: [async ({}, use) => {
    if (!inProcess) { await use(null); return }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-http-'))
    const values = {
      CHRONICLE_TEST_DATA_DIR: directory,
      CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'),
      CHRONICLE_CONFIG_DIR: path.join(directory, 'config'),
      CHRONICLE_CONFIG_PATH: path.join(directory, 'config/config.json'),
      CHRONICLE_LOG_PATH: path.join(directory, 'logs/server.log'),
      CHRONICLE_LOG_DIR: path.join(directory, 'logs'),
      CHRONICLE_ATTACHMENT_DIR: path.join(directory, 'attachments'),
      CHRONICLE_LLM_BASE_URL: 'http://127.0.0.1:1/v1',
      CHRONICLE_LLM_API_KEY: '',
      CHRONICLE_LLM_TIMEOUT_MS: '100',
    }
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    const { app, initializeDatabaseState } = require('../../server/src/app')
    initializeDatabaseState()
    try { await use({ app, directory }) }
    finally {
      const { closeDb } = require('../../server/src/db')
      closeDb()
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, { scope: 'worker' }],
  request: async ({ request, harness }, use) => {
    if (!harness) { await use(request); return }
    async function send(method: string, url: string, options: any = {}) {
      const headers = new Headers(options.headers)
      let body: BodyInit | undefined
      if (options.multipart) {
        const form = new FormData()
        for (const [key, value] of Object.entries(options.multipart) as [string, any][]) {
          if (value?.buffer) form.append(key, new File([value.buffer], value.name, { type: value.mimeType }))
          else form.append(key, String(value))
        }
        body = form
      } else if (options.data !== undefined) { body = JSON.stringify(options.data); headers.set('Content-Type', 'application/json') }
      const response = await harness!.app.request(new URL(url, 'http://127.0.0.1:18182').href, { method, headers, body })
      const bytes = Buffer.from(await response.arrayBuffer())
      return { ok: () => response.ok, status: () => response.status, headers: () => Object.fromEntries(response.headers),
        text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')), body: async () => bytes, dispose: async () => {} }
    }
    const client = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'head'].map(method => [method, (url: string, options?: any) => send(method.toUpperCase(), url, options)]))
    await use(client as any)
  },
  page: async ({ page, harness }, use) => {
    if (harness) await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (!['localhost', '127.0.0.1'].includes(url.hostname)) { await route.abort(); return }
      if (url.pathname === '/api/events') { await route.abort(); return }
      const response = await harness.app.request(request.url(), { method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    })
    await use(page)
  },
})
export { expect }
