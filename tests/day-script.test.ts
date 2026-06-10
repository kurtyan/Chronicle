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

async function deleteEntry(page: Page, taskId: string, entryId: string) {
  const res = await page.request.delete(`/api/tasks/${taskId}/logs/${entryId}`)
  expect(res.ok()).toBeTruthy()
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
              attrs: { softWrap: false },
              content: [{ type: 'text', text: 'const value = 1' }],
            },
            {
              type: 'imageResize',
              attrs: {
                src: 'asset://localhost/tmp/day-script-image.png',
                fullpath: '/tmp/day-script-image.png',
                filename: 'day-script-image.png',
                width: '245',
              },
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
    expect(entries[0].content).toContain('<pre data-code-wrap="off"><code>const value = 1</code></pre>')
    expect(entries[0].content).toContain('<img')
    expect(entries[0].content).toContain('day-script-image.png')
  })

  test('completed focus line appends image-only progress delta', async ({ page }) => {
    const task = await createTask(page, `DayScript-ImageDelta-${Date.now()}`)
    const date = uniqueScriptDate(8)

    const firstSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Text progress' }] },
          ],
        },
      },
    })
    expect(firstSave.ok()).toBeTruthy()
    const first = await firstSave.json()
    expect(first.createdLogs).toHaveLength(1)

    const withImage = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: first.script.revision,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Text progress' }] },
            {
              type: 'imageResize',
              attrs: {
                src: 'asset://localhost/tmp/day-script-delta-image.png',
                fullpath: '/tmp/day-script-delta-image.png',
                filename: 'day-script-delta-image.png',
                width: '245',
              },
            },
          ],
        },
      },
    })
    expect(withImage.ok()).toBeTruthy()
    const imageSaved = await withImage.json()
    expect(imageSaved.createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(2)
    expect(entries[1].content).toContain('<img')
    expect(entries[1].content).toContain('day-script-delta-image.png')

    const repeat = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: imageSaved.script.revision,
        document: imageSaved.script.document,
      },
    })
    expect(repeat.ok()).toBeTruthy()
    expect((await repeat.json()).createdLogs).toHaveLength(0)
  })

  test('completed focus line appends images after text was already synced', async ({ page }) => {
    const task = await createTask(page, `DayScript-ImageAfterText-${Date.now()}`)
    const date = uniqueScriptDate(9)

    const textSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Already synced text' }] },
          ],
        },
      },
    })
    expect(textSave.ok()).toBeTruthy()
    const textSaved = await textSave.json()
    expect(textSaved.createdLogs).toHaveLength(1)

    const imageSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: textSaved.script.revision,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Already synced text' }] },
            {
              type: 'imageResize',
              attrs: {
                src: 'asset://localhost/tmp/day-script-image-after-text.png',
                fullpath: '/tmp/day-script-image-after-text.png',
                filename: 'day-script-image-after-text.png',
                width: '500',
              },
            },
            {
              type: 'imageResize',
              attrs: {
                src: 'asset://localhost/tmp/day-script-second-image-after-text.png',
                fullpath: '/tmp/day-script-second-image-after-text.png',
                filename: 'day-script-second-image-after-text.png',
                width: '500',
              },
            },
          ],
        },
      },
    })
    expect(imageSave.ok()).toBeTruthy()
    expect((await imageSave.json()).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(2)
    expect(entries[1].content).toContain('<img')
    expect(entries[1].content).toContain('day-script-image-after-text.png')
    expect(entries[1].content).toContain('day-script-second-image-after-text.png')
    expect(entries[1].content).not.toContain('Already synced text')
  })

  test('completed focus line ignores trailing blank progress edits', async ({ page }) => {
    const task = await createTask(page, `DayScript-TrailingBlank-${Date.now()}`)
    const date = uniqueScriptDate(12)

    const firstSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Stable progress' }] },
          ],
        },
      },
    })
    expect(firstSave.ok()).toBeTruthy()
    const first = await firstSave.json()
    expect(first.createdLogs).toHaveLength(1)

    const blankSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: first.script.revision,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Stable progress' }] },
            { type: 'paragraph' },
            { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
          ],
        },
      },
    })
    expect(blankSave.ok()).toBeTruthy()
    const blankSaved = await blankSave.json()
    expect(blankSaved.createdLogs).toHaveLength(0)

    const entriesAfterBlank = await getEntries(page, task.id)
    expect(entriesAfterBlank).toHaveLength(1)

    const realAppend = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: blankSaved.script.revision,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Stable progress' }] },
            { type: 'paragraph' },
            { type: 'paragraph', content: [{ type: 'text', text: 'Real append' }] },
          ],
        },
      },
    })
    expect(realAppend.ok()).toBeTruthy()
    expect((await realAppend.json()).createdLogs).toHaveLength(1)

    const entriesAfterAppend = await getEntries(page, task.id)
    expect(entriesAfterAppend).toHaveLength(2)
    expect(entriesAfterAppend[1].content).toContain('Real append')
    expect(entriesAfterAppend[1].content).not.toContain('Stable progress')
  })

  test('deleted day script sync log is not recreated on next save', async ({ page }) => {
    const task = await createTask(page, `DayScript-DeletedSync-${Date.now()}`)
    const date = uniqueScriptDate(13)

    const firstSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Initial progress' },
        ]),
      },
    })
    expect(firstSave.ok()).toBeTruthy()
    const first = await firstSave.json()
    expect(first.createdLogs).toHaveLength(1)

    await deleteEntry(page, task.id, first.createdLogs[0].entryId)
    expect(await getEntries(page, task.id)).toHaveLength(0)

    const repeatSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: first.script.revision,
        document: first.script.document,
      },
    })
    expect(repeatSave.ok()).toBeTruthy()
    const repeat = await repeatSave.json()
    expect(repeat.createdLogs).toHaveLength(0)
    expect(await getEntries(page, task.id)).toHaveLength(0)

    const appendSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: repeat.script.revision,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Initial progress' },
          { text: 'Follow-up progress' },
        ]),
      },
    })
    expect(appendSave.ok()).toBeTruthy()
    expect((await appendSave.json()).createdLogs).toHaveLength(1)

    const entriesAfterAppend = await getEntries(page, task.id)
    expect(entriesAfterAppend).toHaveLength(1)
    expect(entriesAfterAppend[0].content).toContain('Follow-up progress')
    expect(entriesAfterAppend[0].content).not.toContain('Initial progress')
  })

  test('compact time header is normalized on save', async ({ page }) => {
    const task = await createTask(page, `DayScript-CompactTime-${Date.now()}`)
    const date = uniqueScriptDate(10)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `1443-1500 @${task.title} ✅`, taskId: task.id },
          { text: 'Compact time progress' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)
    expect(saved.script.blocks[0]).toMatchObject({
      startTime: '14:43',
      endTime: '15:00',
    })
    expect(saved.script.document.content[0].content[0].text).toBe('14:43-15:00 ')

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('Day Script progress · 2099-01-10 · 14:43-15:00')
    expect(entries[0].content).toContain('Compact time progress')
  })

  test('new task focus line creates ktlo task and rewrites the header mention', async ({ page }) => {
    const date = uniqueScriptDate(5)
    const title = `Inline KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${title} ✅` },
          { text: 'Investigated production incident' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(1)
    expect(saved.createdTasks[0]).toMatchObject({
      title,
      type: 'TODO',
      priority: 'MEDIUM',
      tags: ['ktlo'],
      status: 'PENDING',
    })
    expect(saved.script.blocks[0].taskIds).toEqual([saved.createdTasks[0].id])

    const header = saved.script.document.content[0].content
    expect(header[1]).toMatchObject({
      type: 'text',
      text: `@${title}`,
      marks: [{ type: 'link', attrs: { taskId: saved.createdTasks[0].id } }],
    })

    const entries = await getEntries(page, saved.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('Investigated production incident')

    const repeat = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: saved.script.revision,
        document: saved.script.document,
      },
    })
    expect(repeat.ok()).toBeTruthy()
    expect((await repeat.json()).createdTasks).toHaveLength(0)
  })

  test('compact time new task line creates ktlo task and normalizes the header', async ({ page }) => {
    const date = uniqueScriptDate(11)
    const title = `Inline Compact KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `1443-1500 new task ${title} ✅` },
          { text: 'Investigated compact-time production incident' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(1)
    expect(saved.script.blocks[0]).toMatchObject({
      startTime: '14:43',
      endTime: '15:00',
    })
    expect(saved.script.document.content[0].content[0].text).toBe('14:43-15:00 ')

    const entries = await getEntries(page, saved.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('Day Script progress · 2099-01-11 · 14:43-15:00')
    expect(entries[0].content).toContain('Investigated compact-time production incident')
  })

  test('strict separator stops loose notes from becoming previous task progress', async ({ page }) => {
    const task = await createTask(page, `DayScript-Separator-${Date.now()}`)
    const date = uniqueScriptDate(6)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅`, taskId: task.id },
          { text: 'Synced progress' },
          { text: '----' },
          { text: 'Detached daily note' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)
    expect(saved.script.blocks[0].progressText).toBe('Synced progress')

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('Synced progress')
    expect(entries[0].content).not.toContain('Detached daily note')

    const invalidSeparator = await page.request.put(`/api/day-scripts/${uniqueScriptDate(7)}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title}`, taskId: task.id },
          { text: '---' },
          { text: 'Still progress' },
        ]),
      },
    })
    expect(invalidSeparator.ok()).toBeTruthy()
    const invalidSaved = await invalidSeparator.json()
    expect(invalidSaved.script.blocks[0].progressText).toBe('---\nStill progress')
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
