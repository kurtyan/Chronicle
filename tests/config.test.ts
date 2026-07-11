import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getLlmSettings, saveLlmSettings } from '../server/src/services/llmService'
import { getConfig } from '../server/src/config'

test.describe.configure({ mode: 'serial' })

test.describe('Config persistence', () => {
  const originalConfigPath = process.env.CHRONICLE_CONFIG_PATH
  const originalConfigDir = process.env.CHRONICLE_CONFIG_DIR
  let tempDir = ''
  let configPath = ''

  test.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-config-test-'))
    configPath = path.join(tempDir, 'config.json')
    process.env.CHRONICLE_CONFIG_DIR = tempDir
    process.env.CHRONICLE_CONFIG_PATH = configPath
  })

  test.afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CHRONICLE_CONFIG_DIR
    else process.env.CHRONICLE_CONFIG_DIR = originalConfigDir
    if (originalConfigPath === undefined) delete process.env.CHRONICLE_CONFIG_PATH
    else process.env.CHRONICLE_CONFIG_PATH = originalConfigPath
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('saveLlmSettings preserves auto_afk config', () => {
    const autoAfk = {
      enabled: true,
      timeoutMinutes: 15,
      ignoredApps: ['Chronicle'],
    }
    fs.writeFileSync(configPath, JSON.stringify({
      auto_afk: autoAfk,
      llm: { timeoutMs: 30000 },
    }))

    saveLlmSettings({ model: 'qwen-test' })

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(saved.auto_afk).toEqual(autoAfk)
    expect(saved.llm.model).toBe('qwen-test')
  })

  test('saveLlmSettings persists 300000 ms timeout', () => {
    saveLlmSettings({ timeoutMs: 300000 })

    expect(getLlmSettings().timeoutMs).toBe(300000)
  })

  test('forces loopback and requires explicit legacy MCP opt-in', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      server: { host: '0.0.0.0', port: 4555 },
      mcp: { enabled: true, port: 4556 },
    }))

    delete process.env.CHRONICLE_ENABLE_LEGACY_MCP
    expect(getConfig().server.host).toBe('127.0.0.1')
    expect(getConfig().mcp.enabled).toBeFalsy()

    process.env.CHRONICLE_ENABLE_LEGACY_MCP = '1'
    expect(getConfig().mcp.enabled).toBeTruthy()
    delete process.env.CHRONICLE_ENABLE_LEGACY_MCP
  })
})
