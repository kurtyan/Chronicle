import { test, expect } from '@playwright/test'

async function createTaskWithTitle(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  return res.json()
}

async function openTask(page: import('@playwright/test').Page, title: string) {
  await page.goto('/?lang=zh-CN')
  await page.waitForLoadState('load')
  await page.locator('h4').filter({ hasText: title }).first().click()
  await expect(page.getByTestId('workspace-info-bar')).toBeVisible()
}

async function expectIdle(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    const res = await page.request.get('/api/sessions/current')
    return res.ok() ? await res.json() : null
  }).toBeNull()
}

async function installTauriEventMock(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const listeners: Record<string, Record<number, (event: any) => void>> = {}
    let nextCallbackId = 1
    ;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (event: string, id: number) => {
        delete listeners[event]?.[id]
      },
    }
    ;(window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: any) => void) => {
        const id = nextCallbackId++
        ;(window as any).__chronicleTauriCallbacks ??= {}
        ;(window as any).__chronicleTauriCallbacks[id] = callback
        return id
      },
      invoke: async (cmd: string, args: any) => {
        if (cmd === 'plugin:event|listen') {
          listeners[args.event] ??= {}
          listeners[args.event][args.handler] = (window as any).__chronicleTauriCallbacks[args.handler]
          return args.handler
        }
        if (cmd === 'plugin:event|unlisten') {
          delete listeners[args.event]?.[args.eventId]
          return null
        }
        return null
      },
    }
    ;(window as any).__chronicleEmitTauriEvent = (event: string, payload: unknown) => {
      Object.entries(listeners[event] ?? {}).forEach(([id, handler]) => {
        handler({ event, id: Number(id), payload })
      })
    }
    ;(window as any).__chronicleTauriListenerCount = (event: string) => Object.keys(listeners[event] ?? {}).length
  })
}

test.describe('Auto takeover on actual edit', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
  })

  test('existing entry takeover waits for content change and fires once per edit session', async ({ page }) => {
    const title = `AutoTakeoverExisting-${Date.now()}`
    const task = await createTaskWithTitle(page, title)
    await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>Original entry</p>', type: 'log' },
    })

    let takeoverCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(`/api/tasks/${task.id}/takeover`)) {
        takeoverCount += 1
      }
    })

    await openTask(page, title)
    await page.getByTestId('task-entry-block').first().click()
    await expect(page.locator('[data-rich-editor="true"] .ProseMirror')).toBeVisible()
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Original entry updated')
    await expect.poll(() => takeoverCount).toBe(1)

    const currentSession = await (await page.request.get('/api/sessions/current')).json()
    expect(currentSession.taskId).toBe(task.id)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Original entry updated again')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(1)

    await page.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: 'AFK' }).click()
    await expectIdle(page)

    await page.getByTestId('task-entry-block').first().click()
    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Second edit session')
    await expect.poll(() => takeoverCount).toBe(2)
  })

  test('new entry takeover waits for user content and restored drafts do not fire', async ({ page }) => {
    const title = `AutoTakeoverNew-${Date.now()}`
    const task = await createTaskWithTitle(page, title)
    const restoredDraft = '<p>Restored draft content</p>'

    await page.addInitScript(({ taskId, content }) => {
      localStorage.setItem(`chronicle:entry_draft:${taskId}:__new__`, content)
    }, { taskId: task.id, content: restoredDraft })

    let takeoverCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(`/api/tasks/${task.id}/takeover`)) {
        takeoverCount += 1
      }
    })

    await openTask(page, title)
    await expect(page.locator('[data-rich-editor="true"] .ProseMirror')).toContainText('Restored draft content')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').click()
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Restored draft content changed')
    await expect.poll(() => takeoverCount).toBe(1)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Restored draft content changed again')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(1)

    await page.getByRole('button', { name: '提交记录' }).click()
    await expect(page.locator('[data-rich-editor="true"] .ProseMirror')).toBeEmpty()
    await page.getByRole('button', { name: 'AFK' }).click()
    await expectIdle(page)
    await expect(page.getByRole('button', { name: 'AFK' })).toHaveCount(0)

    await page.locator('[data-rich-editor="true"] .ProseMirror').fill('Second new entry')
    await expect.poll(() => takeoverCount).toBe(2)
  })

  test('auto AFK resumes previous task from system return event and keeps AFK dialog for note', async ({ page }) => {
    await installTauriEventMock(page)
    const title = `AutoResumeAfk-${Date.now()}`
    const task = await createTaskWithTitle(page, title)
    await page.request.post(`/api/tasks/${task.id}/takeover`)

    await openTask(page, title)
    await expect(page.getByTestId('workspace-info-bar').getByRole('button', { name: 'AFK' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__chronicleTauriListenerCount?.('auto-afk-triggered') ?? 0)).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => (window as any).__chronicleTauriListenerCount?.('auto-afk-resume-detected') ?? 0)).toBeGreaterThan(0)

    const triggeredAt = Date.now() - 90_000
    await page.evaluate((value) => {
      ;(window as any).__chronicleEmitTauriEvent('auto-afk-triggered', { reason: 'idle', triggeredAt: value })
    }, triggeredAt)
    await expect(page.getByRole('dialog')).toContainText('AutoAFK')
    await expectIdle(page)

    const returnedAt = Date.now() - 10_000
    await page.evaluate((value) => {
      ;(window as any).__chronicleEmitTauriEvent('auto-afk-resume-detected', { reason: 'idle-return', returnedAt: value })
    }, returnedAt)

    await expect.poll(async () => {
      const res = await page.request.get('/api/sessions/current')
      return await res.json()
    }).toMatchObject({ taskId: task.id, startedAt: returnedAt })
    await expect(page.getByRole('dialog')).toContainText('Work session resumed automatically')
    await expect(page.getByText('Resumed from AFK')).toBeVisible()

    await page.getByPlaceholder(/Briefly describe|请简要说明/).fill('auto resumed')
    await page.getByRole('button', { name: /Submit|提交/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const events = await (await page.request.get(`/api/afk-events?start=${triggeredAt - 1000}&end=${returnedAt + 1000}`)).json()
    expect(events.some((event: { submittedAt: number; userNote: string | null }) =>
      event.submittedAt === returnedAt && event.userNote === 'auto resumed'
    )).toBeTruthy()
  })
})
