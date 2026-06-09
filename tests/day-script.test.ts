import { test, expect, type Page } from '@playwright/test'

function todayDate(): string {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 0, dayOffset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

function formatTime(date: Date): string {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':')
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

function paragraph(text: string, taskId?: string) {
  if (!taskId) return { type: 'paragraph', content: [{ type: 'text', text }] }
  const marker = text.indexOf('@')
  if (marker < 0) return { type: 'paragraph', content: [{ type: 'text', text }] }
  const before = text.slice(0, marker)
  const mention = text.slice(marker)
  return {
    type: 'paragraph',
    content: [
      ...(before ? [{ type: 'text', text: before }] : []),
      {
        type: 'text',
        text: mention,
        marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskId)}`, taskId } }],
      },
    ],
  }
}

function doc(lines: Array<{ text: string; taskId?: string }>) {
  return { type: 'doc', content: lines.map((line) => paragraph(line.text, line.taskId)) }
}

async function getEntries(page: Page, taskId: string) {
  const res = await page.request.get(`/api/tasks/${taskId}/logs`)
  expect(res.ok()).toBeTruthy()
  return res.json()
}

test.describe('Day Script progress sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
  })

  test('inserting a block before a completed block preserves existing sync identity', async ({ page }) => {
    const taskA = await createTask(page, `DayScript-A-${Date.now()}`)
    const taskB = await createTask(page, `DayScript-B-${Date.now()}`)
    const date = uniqueScriptDate(1)

    const firstSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${taskA.title} ✅`, taskId: taskA.id },
          { text: 'A initial progress' },
        ]),
      },
    })
    expect(firstSave.ok()).toBeTruthy()
    const first = await firstSave.json()
    expect(first.createdLogs).toHaveLength(1)

    const secondSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: first.script.revision,
        document: doc([
          { text: `09:00-09:15 @${taskB.title} ✅`, taskId: taskB.id },
          { text: 'B progress' },
          { text: `10:00-10:30 @${taskA.title} ✅`, taskId: taskA.id },
          { text: 'A initial progress' },
          { text: 'A appended progress' },
        ]),
      },
    })
    expect(secondSave.ok()).toBeTruthy()

    const taskAEntries = await getEntries(page, taskA.id)
    const taskBEntries = await getEntries(page, taskB.id)
    expect(taskAEntries).toHaveLength(2)
    expect(taskBEntries).toHaveLength(1)
    expect(taskAEntries[1].content).toContain('A appended progress')
    expect(taskAEntries[1].content).not.toContain('A initial progress')
  })

  test('conflict confirmation is idempotent and validates current block-task association', async ({ page }) => {
    const task = await createTask(page, `DayScript-Conflict-${Date.now()}`)
    const date = uniqueScriptDate(2)

    const firstSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `11:00-11:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Original progress' },
        ]),
      },
    })
    expect(firstSave.ok()).toBeTruthy()
    const first = await firstSave.json()

    const conflictSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: first.script.revision,
        document: doc([
          { text: `11:00-11:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Edited historical progress' },
        ]),
      },
    })
    expect(conflictSave.ok()).toBeTruthy()
    const conflict = await conflictSave.json()
    expect(conflict.createdLogs).toHaveLength(0)
    expect(conflict.conflicts).toHaveLength(1)

    const item = conflict.conflicts.map((entry: { blockId: string; taskId: string }) => ({
      blockId: entry.blockId,
      taskId: entry.taskId,
    }))
    const firstConfirm = await page.request.post(`/api/day-scripts/${date}/confirm-progress-sync`, { data: { items: item } })
    expect(firstConfirm.ok()).toBeTruthy()
    expect((await firstConfirm.json()).createdLogs).toHaveLength(1)

    const secondConfirm = await page.request.post(`/api/day-scripts/${date}/confirm-progress-sync`, { data: { items: item } })
    expect(secondConfirm.ok()).toBeTruthy()
    expect((await secondConfirm.json()).createdLogs).toHaveLength(0)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(2)
  })

  test('completed focus line stores planned and actual execution record', async ({ page }) => {
    const task = await createTask(page, `DayScript-Execution-${Date.now()}`)
    const date = uniqueScriptDate(3)
    const firstEditedAt = Date.now() - 120_000

    const takeover = await page.request.post(`/api/tasks/${task.id}/takeover`)
    expect(takeover.ok()).toBeTruthy()
    const session = await takeover.json()

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Execution progress' },
        ]),
        focusActivity: [{
          blockKey: `0|10:00|10:30|@${task.title}|${task.id}`,
          taskId: task.id,
          firstEditedAt,
        }],
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdLogs).toHaveLength(1)
    expect(saved.executionRecords).toHaveLength(1)
    expect(saved.executionRecords[0]).toMatchObject({
      scriptDate: date,
      taskId: task.id,
      progressEntryId: saved.createdLogs[0].entryId,
      workSessionId: session.id,
      plannedMinutes: 30,
    })
    expect(saved.executionRecords[0].actualStartedAt).toBe(firstEditedAt)
    expect(saved.executionRecords[0].actualCompletedAt).toBeGreaterThanOrEqual(firstEditedAt)
    expect(saved.executionRecords[0].actualMinutes).toBeGreaterThanOrEqual(0)

    const recordsRes = await page.request.get(`/api/day-scripts/${date}/execution-records?taskId=${encodeURIComponent(task.id)}`)
    expect(recordsRes.ok()).toBeTruthy()
    const records = await recordsRes.json()
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(saved.executionRecords[0].id)

    const repeat = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: saved.script.revision,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Execution progress' },
        ]),
        focusActivity: [{
          blockKey: `0|10:00|10:30|@${task.title}|${task.id}`,
          taskId: task.id,
          firstEditedAt,
        }],
      },
    })
    expect(repeat.ok()).toBeTruthy()
    const repeated = await repeat.json()
    expect(repeated.createdLogs).toHaveLength(0)
    expect(repeated.executionRecords).toHaveLength(0)

    const secondEditedAt = Date.now() - 60_000
    const append = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: repeated.script.revision,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Execution progress' },
          { text: 'Second progress slice' },
        ]),
        focusActivity: [{
          blockKey: `0|10:00|10:30|@${task.title}|${task.id}`,
          taskId: task.id,
          firstEditedAt: secondEditedAt,
        }],
      },
    })
    expect(append.ok()).toBeTruthy()
    const appended = await append.json()
    expect(appended.createdLogs).toHaveLength(1)
    expect(appended.executionRecords).toHaveLength(1)
    expect(appended.executionRecords[0].actualStartedAt).toBe(secondEditedAt)

    const appendedRecordsRes = await page.request.get(`/api/day-scripts/${date}/execution-records?taskId=${encodeURIComponent(task.id)}`)
    expect(appendedRecordsRes.ok()).toBeTruthy()
    expect(await appendedRecordsRes.json()).toHaveLength(2)
  })

  test('completed focus line preserves rich progress formatting in task log', async ({ page }) => {
    const task = await createTask(page, `DayScript-Rich-${Date.now()}`)
    const date = uniqueScriptDate(4)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Bold progress', marks: [{ type: 'bold' }] },
              ],
            },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List progress' }] }],
              }],
            },
            {
              type: 'codeBlock',
              content: [{ type: 'text', text: 'const value = 1' }],
            },
          ],
        },
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('<strong>Bold progress</strong>')
    expect(entries[0].content).toContain('<ul>')
    expect(entries[0].content).toContain('List progress')
    expect(entries[0].content).toContain('<pre><code>const value = 1</code></pre>')
  })

  test('Day Script editor only takes over after actual progress editing', async ({ page }) => {
    const task = await createTask(page, `DayScript-Takeover-${Date.now()}`)
    const now = new Date()
    const start = formatTime(addMinutes(now, -5))
    const end = formatTime(addMinutes(now, 25))
    const date = todayDate()

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `${start}-${end} @${task.title}`, taskId: task.id },
          { text: 'Existing progress' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()

    let takeoverCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(`/api/tasks/${task.id}/takeover`)) {
        takeoverCount += 1
      }
    })

    await page.goto('/today?lang=zh-CN')
    await page.waitForLoadState('load')
    const editor = page.locator('.day-script-editor.ProseMirror')
    await expect(editor).toContainText('Existing progress')
    await editor.getByText('Existing progress').click()
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(0)

    await page.keyboard.type(' updated')
    await expect.poll(() => takeoverCount).toBe(1)
    await page.keyboard.type(' again')
    await page.waitForTimeout(500)
    expect(takeoverCount).toBe(1)
  })
})
