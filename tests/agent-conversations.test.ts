import { expect, test } from '@playwright/test'

async function createTask(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function openTask(page: import('@playwright/test').Page, title: string) {
  await page.goto('/?lang=en')
  await page.waitForLoadState('load')
  await page.locator('h4').filter({ hasText: title }).first().click()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
}

test.describe('Agent conversations', () => {
  test('extracts agent resume commands from submitted task logs', async ({ page }) => {
    const task = await createTask(page, `AgentExtract-${Date.now()}`)

    const logRes = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>handoff: devin -r dev-123 and cladue -r claude-456</p>', type: 'log' },
    })
    expect(logRes.status()).toBe(201)

    const duplicateRes = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>same again devin -r dev-123</p>', type: 'log' },
    })
    expect(duplicateRes.status()).toBe(201)

    const bodyRes = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>body only claude -r ignored-999</p>', type: 'body' },
    })
    expect(bodyRes.status()).toBe(201)

    const conversationsRes = await page.request.get(`/api/tasks/${task.id}/agent-conversations`)
    expect(conversationsRes.ok()).toBeTruthy()
    const conversations = await conversationsRes.json()
    expect(conversations).toEqual([
      expect.objectContaining({ agent: 'devin', conversationId: 'dev-123', launchable: true }),
      expect.objectContaining({ agent: 'claude', conversationId: 'claude-456', launchable: true }),
    ])
  })

  test('extracts batch logs for each task and includes legacy Claude conversation', async ({ page }) => {
    const first = await createTask(page, `AgentBatchA-${Date.now()}`)
    const second = await createTask(page, `AgentBatchB-${Date.now()}`)

    const batchRes = await page.request.post('/api/tasks/logs/batch', {
      data: { taskIds: [first.id, second.id], content: '<p>agent: claude -r shared-777</p>', type: 'log' },
    })
    expect(batchRes.status()).toBe(201)

    const legacyRes = await page.request.put(`/api/tasks/${first.id}/extra-info/claude_conversation_id`, {
      data: { value: 'legacy-111' },
    })
    expect(legacyRes.ok()).toBeTruthy()

    const firstConversations = await (await page.request.get(`/api/tasks/${first.id}/agent-conversations`)).json()
    const secondConversations = await (await page.request.get(`/api/tasks/${second.id}/agent-conversations`)).json()

    expect(firstConversations).toEqual([
      expect.objectContaining({ agent: 'claude', conversationId: 'legacy-111', launchable: true }),
      expect.objectContaining({ agent: 'claude', conversationId: 'shared-777', launchable: true }),
    ])
    expect(secondConversations).toEqual([
      expect.objectContaining({ agent: 'claude', conversationId: 'shared-777', launchable: true }),
    ])
  })

  test('Agent button is disabled without conversations and opens selected conversation from the menu', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__TAURI__ = {}
      ;(window as any).__terminalCommands = []
      ;(window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any) => {
          if (cmd === 'run_agent_conversation') {
            ;(window as any).__terminalCommands.push(args)
            return null
          }
          if (cmd === 'get_server_url') return ''
          return null
        },
        transformCallback: () => 0,
      }
    })

    const emptyTask = await createTask(page, `AgentEmpty-${Date.now()}`)
    await openTask(page, emptyTask.title)
    await expect(page.getByTestId('task-agent-button')).toBeDisabled()

    const task = await createTask(page, `AgentMenu-${Date.now()}`)
    await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>devin -r dev-ui-1</p>', type: 'log' },
    })
    await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>claude -r claude-ui-2</p>', type: 'log' },
    })

    await openTask(page, task.title)
    await page.getByTestId('task-agent-button').click()
    await expect(page.getByTestId('task-agent-menu')).toBeVisible()
    await page.getByTestId('task-agent-menu').getByText('claude-ui-2').click()

    await expect.poll(() => page.evaluate(() => (window as any).__terminalCommands)).toEqual([
      { agent: 'claude', conversationId: 'claude-ui-2' },
    ])
  })

  test('does not extract unsafe conversation IDs from task logs', async ({ page }) => {
    const task = await createTask(page, `AgentUnsafe-${Date.now()}`)
    const response = await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>claude -r x;touch${IFS}/tmp/chronicle-pwn</p>', type: 'log' },
    })
    expect(response.ok()).toBeTruthy()

    const conversations = await (await page.request.get(`/api/tasks/${task.id}/agent-conversations`)).json()
    expect(conversations).toEqual([])
  })
})
