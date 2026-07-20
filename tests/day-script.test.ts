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

function localTimestamp(date: string, time: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function formatTime(date: Date): string {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':')
}

function ceilToFiveMinutes(date: Date): Date {
  const interval = 5 * 60_000
  return new Date(Math.ceil(date.getTime() / interval) * interval)
}

function extractParagraphTexts(document: any): string[] {
  return (document.content ?? []).map((node: any) =>
    (node.content ?? [])
      .filter((child: any) => child.type === 'text')
      .map((child: any) => child.text ?? '')
      .join('')
  )
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

function paragraph(text: string, taskId?: string, attrs?: Record<string, any>) {
  if (!taskId) return { type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] }
  const marker = text.indexOf('@')
  if (marker < 0) return { type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] }
  const before = text.slice(0, marker)
  const mention = text.slice(marker)
  return {
    type: 'paragraph',
    ...(attrs ? { attrs } : {}),
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

function doc(lines: Array<{ text: string; taskId?: string; attrs?: Record<string, any> }>) {
  return { type: 'doc', content: lines.map((line) => paragraph(line.text, line.taskId, line.attrs)) }
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

async function submitProgress(page: Page, date: string, focusActivity?: Array<{ blockKey: string; taskId: string; firstEditedAt: number }>) {
  const res = await page.request.post(`/api/day-scripts/${date}/submit-progress`, {
    data: {
      ...(focusActivity ? { focusActivity } : {}),
    },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function rescheduleFocus(page: Page, date: string, expectedRevision: number, sortOrders: number[]) {
  return page.request.post(`/api/day-scripts/${date}/reschedule-focus`, {
    data: { expectedRevision, sortOrders },
  })
}

async function getDayScriptRevision(page: Page, date: string): Promise<number> {
  const current = await page.request.get(`/api/day-scripts/${date}`)
  expect(current.ok()).toBeTruthy()
  return ((await current.json()).revision ?? 0) as number
}

test.describe('Day Script progress sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/afk').catch(() => {})
  })

  test('submit progress keeps planned focus times unchanged', async ({ page }) => {
    const offsetRes = await page.request.get('/api/settings/start-of-day-offset')
    expect(offsetRes.ok()).toBeTruthy()
    const originalOffset = (await offsetRes.json()).offset
    const currentTask = await createTask(page, `DayScript-DelayCurrent-${Date.now()}`)
    const nextTask = await createTask(page, `DayScript-DelayNext-${Date.now()}`)
    const laterTask = await createTask(page, `DayScript-DelayLater-${Date.now()}`)
    const date = todayDate()
    const target = ceilToFiveMinutes(new Date())
    const firstStart = addMinutes(target, -25)
    const firstEnd = addMinutes(firstStart, 10)
    const secondStart = addMinutes(target, -15)
    const secondEnd = addMinutes(secondStart, 20)
    const thirdStart = addMinutes(target, -10)
    const thirdEnd = addMinutes(thirdStart, 10)

    try {
      const saveOffset = await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 0 } })
      expect(saveOffset.ok()).toBeTruthy()

      const save = await page.request.put(`/api/day-scripts/${date}`, {
        data: {
          expectedRevision: await getDayScriptRevision(page, date),
          document: doc([
            { text: `${formatTime(firstStart)}-${formatTime(firstEnd)} @${currentTask.title}`, taskId: currentTask.id },
            { text: 'Actual progress happened here' },
            { text: `${formatTime(secondStart)}-${formatTime(secondEnd)} @${nextTask.title}`, taskId: nextTask.id },
            { text: `${formatTime(thirdStart)}-${formatTime(thirdEnd)} @${laterTask.title}`, taskId: laterTask.id },
          ]),
        },
      })
      expect(save.ok()).toBeTruthy()
      const saved = await save.json()

      const submitted = await submitProgress(page, date)
      expect(submitted.script.revision).toBe(saved.script.revision)
      const lines = extractParagraphTexts(submitted.script.document)
      expect(lines[0]).toContain(`${formatTime(firstStart)}-${formatTime(firstEnd)}`)
      expect(lines[2]).toContain(`${formatTime(secondStart)}-${formatTime(secondEnd)}`)
      expect(lines[3]).toContain(`${formatTime(thirdStart)}-${formatTime(thirdEnd)}`)
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset } })
    }
  })

  test('submit progress does not rewrite planned times without a completion', async ({ page }) => {
    const offsetRes = await page.request.get('/api/settings/start-of-day-offset')
    expect(offsetRes.ok()).toBeTruthy()
    const originalOffset = (await offsetRes.json()).offset
    const firstTask = await createTask(page, `DayScript-DelayFirst-${Date.now()}`)
    const secondTask = await createTask(page, `DayScript-DelaySecond-${Date.now()}`)
    const date = todayDate()
    const target = ceilToFiveMinutes(new Date())
    const firstStart = addMinutes(target, -20)
    const firstEnd = addMinutes(firstStart, 10)
    const secondStart = addMinutes(target, -5)
    const secondEnd = addMinutes(secondStart, 15)

    try {
      const saveOffset = await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 0 } })
      expect(saveOffset.ok()).toBeTruthy()

      const save = await page.request.put(`/api/day-scripts/${date}`, {
        data: {
          expectedRevision: await getDayScriptRevision(page, date),
          document: doc([
            { text: `${formatTime(firstStart)}-${formatTime(firstEnd)} @${firstTask.title}`, taskId: firstTask.id },
            { text: '' },
            { text: '' },
            { text: `${formatTime(secondStart)}-${formatTime(secondEnd)} @${secondTask.title} ✅`, taskId: secondTask.id },
          ]),
        },
      })
      expect(save.ok()).toBeTruthy()

      const submitted = await submitProgress(page, date)
      const lines = extractParagraphTexts(submitted.script.document)
      expect(lines[0]).toContain(`${formatTime(firstStart)}-${formatTime(firstEnd)}`)
      expect(lines[3]).toContain(`${formatTime(secondStart)}-${formatTime(secondEnd)}`)
      expect(submitted.createdLogs).toHaveLength(0)
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset } })
    }
  })

  test('submit progress never reschedules other focus lines', async ({ page }) => {
    const offsetRes = await page.request.get('/api/settings/start-of-day-offset')
    expect(offsetRes.ok()).toBeTruthy()
    const originalOffset = (await offsetRes.json()).offset
    const skippedTask = await createTask(page, `DayScript-SkippedBefore-${Date.now()}`)
    const currentTask = await createTask(page, `DayScript-OutOfOrderCurrent-${Date.now()}`)
    const nextTask = await createTask(page, `DayScript-OutOfOrderNext-${Date.now()}`)
    const dragonTask = await createTask(page, `DayScript-OutOfOrderDragon-${Date.now()}`)
    const date = todayDate()
    const target = ceilToFiveMinutes(new Date())
    const skippedStart = addMinutes(target, -45)
    const skippedEnd = addMinutes(skippedStart, 10)
    const currentStart = addMinutes(target, -35)
    const currentEnd = addMinutes(currentStart, 15)
    const nextStart = addMinutes(target, -15)
    const nextEnd = addMinutes(nextStart, 20)
    const dragonStart = addMinutes(target, -5)
    const dragonEnd = addMinutes(dragonStart, 10)

    try {
      const saveOffset = await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 0 } })
      expect(saveOffset.ok()).toBeTruthy()

      const save = await page.request.put(`/api/day-scripts/${date}`, {
        data: {
          expectedRevision: await getDayScriptRevision(page, date),
          document: doc([
            { text: `${formatTime(skippedStart)}-${formatTime(skippedEnd)} @${skippedTask.title}`, taskId: skippedTask.id },
            { text: 'Planning note for skipped item' },
            { text: `${formatTime(currentStart)}-${formatTime(currentEnd)} @${currentTask.title} ✅`, taskId: currentTask.id },
            { text: 'Finished current item' },
            { text: `${formatTime(nextStart)}-${formatTime(nextEnd)} @${nextTask.title}`, taskId: nextTask.id },
            { text: 'Planning note for next item' },
            { text: `${formatTime(dragonStart)}-${formatTime(dragonEnd)} @${dragonTask.title} 🐲`, taskId: dragonTask.id },
            { text: 'Append-only current context' },
          ]),
        },
      })
      expect(save.ok()).toBeTruthy()

      const submitted = await submitProgress(page, date)
      const lines = extractParagraphTexts(submitted.script.document)
      expect(lines[0]).toContain(`${formatTime(skippedStart)}-${formatTime(skippedEnd)}`)
      expect(lines[1]).toBe('Planning note for skipped item')
      expect(lines[2]).toContain(`${formatTime(currentStart)}-${formatTime(currentEnd)}`)
      expect(lines[4]).toContain(`${formatTime(nextStart)}-${formatTime(nextEnd)}`)
      expect(lines[5]).toBe('Planning note for next item')
      expect(lines[6]).toContain(`${formatTime(dragonStart)}-${formatTime(dragonEnd)}`)
      expect(submitted.createdLogs.map((log: any) => log.taskId).sort()).toEqual([currentTask.id, dragonTask.id].sort())
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset } })
    }
  })

  test('submit progress keeps previously synced planned times unchanged', async ({ page }) => {
    const offsetRes = await page.request.get('/api/settings/start-of-day-offset')
    expect(offsetRes.ok()).toBeTruthy()
    const originalOffset = (await offsetRes.json()).offset
    const syncedTask = await createTask(page, `DayScript-SyncedProtect-${Date.now()}`)
    const plannedTask = await createTask(page, `DayScript-SyncedProtectPlanned-${Date.now()}`)
    const date = todayDate()
    const target = ceilToFiveMinutes(new Date())
    const syncedStart = addMinutes(target, -30)
    const syncedEnd = addMinutes(syncedStart, 10)
    const plannedStart = addMinutes(target, -15)
    const plannedEnd = addMinutes(plannedStart, 15)

    try {
      const saveOffset = await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 0 } })
      expect(saveOffset.ok()).toBeTruthy()

      const initialSave = await page.request.put(`/api/day-scripts/${date}`, {
        data: {
          expectedRevision: await getDayScriptRevision(page, date),
          document: doc([
            { text: `${formatTime(syncedStart)}-${formatTime(syncedEnd)} @${syncedTask.title} ✅`, taskId: syncedTask.id },
            { text: 'Already synced progress' },
            { text: `${formatTime(plannedStart)}-${formatTime(plannedEnd)} @${plannedTask.title}`, taskId: plannedTask.id },
          ]),
        },
      })
      expect(initialSave.ok()).toBeTruthy()
      const firstSubmit = await submitProgress(page, date)
      expect(firstSubmit.createdLogs).toEqual([{ taskId: syncedTask.id, entryId: expect.any(String), blockId: expect.any(String) }])

      const removeMarker = await page.request.put(`/api/day-scripts/${date}`, {
        data: {
          expectedRevision: firstSubmit.script.revision,
          document: doc([
            { text: `${formatTime(syncedStart)}-${formatTime(syncedEnd)} @${syncedTask.title}`, taskId: syncedTask.id },
            { text: 'Already synced progress' },
            { text: `${formatTime(plannedStart)}-${formatTime(plannedEnd)} @${plannedTask.title}`, taskId: plannedTask.id },
          ]),
        },
      })
      expect(removeMarker.ok()).toBeTruthy()

      const submitted = await submitProgress(page, date)
      const lines = extractParagraphTexts(submitted.script.document)
      expect(lines[0]).toContain(`${formatTime(syncedStart)}-${formatTime(syncedEnd)}`)
      expect(lines[2]).toContain(`${formatTime(plannedStart)}-${formatTime(plannedEnd)}`)
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset } })
    }
  })

  test('reschedule focus changes only selected valid lines and protects completed, dragon, and synced lines', async ({ page }) => {
    const selectedTask = await createTask(page, `DayScript-RescheduleSelected-${Date.now()}`)
    const completedTask = await createTask(page, `DayScript-RescheduleCompleted-${Date.now()}`)
    const dragonTask = await createTask(page, `DayScript-RescheduleDragon-${Date.now()}`)
    const laterTask = await createTask(page, `DayScript-RescheduleLater-${Date.now()}`)
    const date = todayDate()
    const target = ceilToFiveMinutes(new Date())
    const selectedStart = addMinutes(target, -60)
    const selectedEnd = addMinutes(selectedStart, 10)
    const completedStart = addMinutes(target, -45)
    const completedEnd = addMinutes(completedStart, 10)
    const dragonStart = addMinutes(target, -30)
    const dragonEnd = addMinutes(dragonStart, 10)
    const laterStart = addMinutes(target, -15)
    const laterEnd = addMinutes(laterStart, 15)

    const saved = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: await getDayScriptRevision(page, date),
        document: doc([
          { text: `${formatTime(selectedStart)}-${formatTime(selectedEnd)} @${selectedTask.title}`, taskId: selectedTask.id },
          { text: `${formatTime(completedStart)}-${formatTime(completedEnd)} @${completedTask.title} ✅`, taskId: completedTask.id },
          { text: 'already completed' },
          { text: `${formatTime(dragonStart)}-${formatTime(dragonEnd)} @${dragonTask.title} 🐲`, taskId: dragonTask.id },
          { text: 'append-only record' },
          { text: `${formatTime(laterStart)}-${formatTime(laterEnd)} @${laterTask.title}`, taskId: laterTask.id },
        ]),
      },
    })
    expect(saved.ok()).toBeTruthy()
    const savedBody = await saved.json()
    await submitProgress(page, date)

    const rescheduled = await rescheduleFocus(page, date, savedBody.script.revision, [0, 1, 2, 3])
    expect(rescheduled.ok()).toBeTruthy()
    const result = await rescheduled.json()
    expect(result.changed).toBe(true)
    const lines = extractParagraphTexts(result.script.document)
    expect(lines[0]).toContain(`${formatTime(target)}-${formatTime(addMinutes(target, 10))}`)
    expect(lines[1]).toContain(`${formatTime(completedStart)}-${formatTime(completedEnd)}`)
    expect(lines[3]).toContain(`${formatTime(dragonStart)}-${formatTime(dragonEnd)}`)
    expect(lines[5]).toContain(`${formatTime(addMinutes(target, 10))}-${formatTime(addMinutes(target, 25))}`)

    const unchanged = await rescheduleFocus(page, date, result.script.revision, [])
    expect(unchanged.ok()).toBeTruthy()
    expect(await unchanged.json()).toMatchObject({ changed: false, script: { revision: result.script.revision } })

    const conflict = await rescheduleFocus(page, date, savedBody.script.revision, [0])
    expect(conflict.status()).toBe(409)
    const current = await page.request.get(`/api/day-scripts/${date}`)
    expect((await current.json()).revision).toBe(result.script.revision)
  })

  test('submit progress does not delay future planned focus lines or create a new revision', async ({ page }) => {
    const task = await createTask(page, `DayScript-NoAdvance-${Date.now()}`)
    const date = uniqueScriptDate(46)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title}`, taskId: task.id },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()

    const submitted = await submitProgress(page, date)
    expect(submitted.script.revision).toBe(saved.script.revision)
    expect(extractParagraphTexts(submitted.script.document)[0]).toContain('10:00-10:30')
  })

  test('cross-midnight planned time saves and records planned minutes', async ({ page }) => {
    const task = await createTask(page, `DayScript-CrossMidnight-${Date.now()}`)
    const date = uniqueScriptDate(47)
    const nextDate = uniqueScriptDate(48)
    const firstEditedAt = Date.now() - 60_000

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `23:55-00:15 @${task.title} ✅`, taskId: task.id },
          { text: 'Cross-midnight progress' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)

    const submitted = await submitProgress(page, date, [{
      blockKey: `0|23:55|00:15|@${task.title}|${task.id}`,
      taskId: task.id,
      firstEditedAt,
    }])
    expect(submitted.executionRecords).toHaveLength(1)
    expect(submitted.executionRecords[0].plannedStartAt).toBe(localTimestamp(date, '23:55'))
    expect(submitted.executionRecords[0].plannedEndAt).toBe(localTimestamp(nextDate, '00:15'))
    expect(submitted.executionRecords[0].plannedMinutes).toBe(20)
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
    expect(first.createdLogs).toHaveLength(0)
    expect(await submitProgress(page, date)).toMatchObject({ createdLogs: [{ taskId: taskA.id }] })

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
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(2)

    const taskAEntries = await getEntries(page, taskA.id)
    const taskBEntries = await getEntries(page, taskB.id)
    expect(taskAEntries).toHaveLength(2)
    expect(taskBEntries).toHaveLength(1)
    expect(taskAEntries[1].content).toContain('A appended progress')
    expect(taskAEntries[1].content).not.toContain('A initial progress')
  })

  test('submit progress ignores unfinished focus blocks', async ({ page }) => {
    const task = await createTask(page, `DayScript-Unfinished-${Date.now()}`)
    const date = uniqueScriptDate(41)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title}`, taskId: task.id },
          { text: 'This is still in progress and should stay in Focus only' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(0)
    expect(await getEntries(page, task.id)).toHaveLength(0)
  })

  test('blank lines before a focus block are ignored by validation', async ({ page }) => {
    const task = await createTask(page, `DayScript-BlankLead-${Date.now()}`)
    const date = uniqueScriptDate(43)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            { type: 'paragraph' },
            { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
            paragraph(`10:00-10:30 @${task.title}`, task.id),
          ],
        },
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)
    expect(saved.script.blocks).toHaveLength(1)
  })

  test('planned and carry-over completed blocks write body only or a short completion fact', async ({ page }) => {
    const plannedTask = await createTask(page, `DayScript-Planned-${Date.now()}`)
    const carryTask = await createTask(page, `DayScript-Carry-${Date.now()}`)
    const date = uniqueScriptDate(42)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          {
            text: `Next step @${plannedTask.title}: inspect mobile layout ✅`,
            taskId: plannedTask.id,
            attrs: { source: 'task_next_step' },
          },
          { text: 'Measured the mobile layout and listed breakpoints' },
          {
            text: `Carry over @${carryTask.title}: ship checklist ✅`,
            taskId: carryTask.id,
            attrs: {
              source: 'carry_over',
              originScriptDate: '2099-01-30',
              originBlockId: 'origin-block-1',
              originSource: 'manual',
            },
          },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.script.blocks.find((block: any) => block.taskIds.includes(plannedTask.id))).toMatchObject({
      source: 'task_next_step',
      originScriptDate: null,
    })
    expect(saved.script.blocks.find((block: any) => block.taskIds.includes(carryTask.id))).toMatchObject({
      source: 'carry_over',
      originScriptDate: '2099-01-30',
      originBlockId: 'origin-block-1',
      originSource: 'manual',
    })

    const submitted = await submitProgress(page, date)
    expect(submitted.createdLogs).toHaveLength(2)

    const plannedEntries = await getEntries(page, plannedTask.id)
    expect(plannedEntries).toHaveLength(1)
    expect(plannedEntries[0].content).toContain('Measured the mobile layout and listed breakpoints')
    expect(plannedEntries[0].content).not.toContain('inspect mobile layout')
    expect(plannedEntries[0].content).not.toContain('Next step')

    const carryEntries = await getEntries(page, carryTask.id)
    expect(carryEntries).toHaveLength(1)
    expect(carryEntries[0].content).toContain('完成延续事项：ship checklist')
    expect(carryEntries[0].content).not.toContain('Carry over')
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
    expect(first.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    const conflictSubmit = await submitProgress(page, date)
    expect(conflictSubmit.createdLogs).toHaveLength(0)
    expect(conflictSubmit.conflicts).toHaveLength(1)

    const item = conflictSubmit.conflicts.map((entry: { blockId: string; taskId: string }) => ({
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
    expect(saved.createdLogs).toHaveLength(0)
    const submitted = await submitProgress(page, date, [{
      blockKey: `0|10:00|10:30|@${task.title}|${task.id}`,
      taskId: task.id,
      firstEditedAt,
    }])
    expect(submitted.createdLogs).toHaveLength(1)
    expect(submitted.executionRecords).toHaveLength(1)
    expect(submitted.executionRecords[0]).toMatchObject({
      scriptDate: date,
      taskId: task.id,
      progressEntryId: submitted.createdLogs[0].entryId,
      workSessionId: session.id,
      plannedMinutes: 30,
    })
    expect(submitted.executionRecords[0].actualStartedAt).toBe(firstEditedAt)
    expect(submitted.executionRecords[0].actualCompletedAt).toBeGreaterThanOrEqual(firstEditedAt)
    expect(submitted.executionRecords[0].actualMinutes).toBeGreaterThanOrEqual(0)

    const recordsRes = await page.request.get(`/api/day-scripts/${date}/execution-records?taskId=${encodeURIComponent(task.id)}`)
    expect(recordsRes.ok()).toBeTruthy()
    const records = await recordsRes.json()
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(submitted.executionRecords[0].id)

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
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(0)

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
    expect(appended.createdLogs).toHaveLength(0)
    const appendedSubmit = await submitProgress(page, date, [{
      blockKey: `0|10:00|10:30|@${task.title}|${task.id}`,
      taskId: task.id,
      firstEditedAt: secondEditedAt,
    }])
    expect(appendedSubmit.createdLogs).toHaveLength(1)
    expect(appendedSubmit.executionRecords).toHaveLength(1)
    expect(appendedSubmit.executionRecords[0].actualStartedAt).toBe(secondEditedAt)

    const appendedRecordsRes = await page.request.get(`/api/day-scripts/${date}/execution-records?taskId=${encodeURIComponent(task.id)}`)
    expect(appendedRecordsRes.ok()).toBeTruthy()
    expect(await appendedRecordsRes.json()).toHaveLength(2)
  })

  test('workday offset maps early planned times to the next natural day', async ({ page }) => {
    const offsetRes = await page.request.get('/api/settings/start-of-day-offset')
    expect(offsetRes.ok()).toBeTruthy()
    const originalOffset = (await offsetRes.json()).offset
    const task = await createTask(page, `DayScript-OffsetExecution-${Date.now()}`)
    const date = uniqueScriptDate(18)
    const firstEditedAt = Date.now() - 60_000

    try {
      const saveOffset = await page.request.put('/api/settings/start-of-day-offset', { data: { offset: 5 } })
      expect(saveOffset.ok()).toBeTruthy()

      const save = await page.request.put(`/api/day-scripts/${date}`, {
        data: {
          expectedRevision: 0,
          document: doc([
            { text: `01:10-01:40 @${task.title} ✅`, taskId: task.id },
            { text: 'Early workday progress' },
          ]),
          focusActivity: [{
            blockKey: `0|01:10|01:40|@${task.title}|${task.id}`,
            taskId: task.id,
            firstEditedAt,
          }],
        },
      })
      expect(save.ok()).toBeTruthy()
      const saved = await save.json()
      expect(saved.executionRecords).toHaveLength(0)
      const submitted = await submitProgress(page, date, [{
        blockKey: `0|01:10|01:40|@${task.title}|${task.id}`,
        taskId: task.id,
        firstEditedAt,
      }])
      expect(submitted.executionRecords).toHaveLength(1)

      const nextNaturalDate = uniqueScriptDate(19)
      expect(submitted.executionRecords[0].plannedStartAt).toBe(localTimestamp(nextNaturalDate, '01:10'))
      expect(submitted.executionRecords[0].plannedEndAt).toBe(localTimestamp(nextNaturalDate, '01:40'))
    } finally {
      await page.request.put('/api/settings/start-of-day-offset', { data: { offset: originalOffset } })
    }
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
    expect(saved.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).not.toContain('Day Script progress')
    expect(entries[0].content).not.toContain(`<p>@${task.title}</p>`)
    expect(entries[0].content).toContain('<strong>Bold progress</strong>')
    expect(entries[0].content).toContain('<ul>')
    expect(entries[0].content).toContain('List progress')
    expect(entries[0].content).toContain('<pre data-code-wrap="off"><code>const value = 1</code></pre>')
    expect(entries[0].content).toContain('<img')
    expect(entries[0].content).toContain('day-script-image.png')
  })

  test('formatting changes in already synced progress create a conflict instead of slicing invalid html', async ({ page }) => {
    const task = await createTask(page, `DayScript-HtmlDelta-${Date.now()}`)
    const date = uniqueScriptDate(20)

    const firstSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Done', marks: [{ type: 'bold' }] }],
            },
          ],
        },
      },
    })
    expect(firstSave.ok()).toBeTruthy()
    const first = await firstSave.json()
    expect(first.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const secondSave = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: first.script.revision,
        document: {
          type: 'doc',
          content: [
            paragraph(`10:00-10:30 @${task.title} ✅`, task.id),
            { type: 'paragraph', content: [{ type: 'text', text: 'Done' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Next' }] },
          ],
        },
      },
    })
    expect(secondSave.ok()).toBeTruthy()
    const second = await secondSave.json()
    expect(second.createdLogs).toHaveLength(0)
    const secondSubmit = await submitProgress(page, date)
    expect(secondSubmit.createdLogs).toHaveLength(0)
    expect(secondSubmit.conflicts).toHaveLength(1)
    expect(secondSubmit.conflicts[0]).toMatchObject({
      taskId: task.id,
      existingProgress: 'Done',
      currentProgress: 'Done\nNext',
    })

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
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
    expect(first.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect(imageSaved.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(0)
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
    expect(textSaved.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect((await imageSave.json()).createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect(first.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(0)

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
    expect((await realAppend.json()).createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect(first.createdLogs).toHaveLength(0)
    const firstSubmit = await submitProgress(page, date)
    expect(firstSubmit.createdLogs).toHaveLength(1)

    await deleteEntry(page, task.id, firstSubmit.createdLogs[0].entryId)
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
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(0)
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
    expect((await appendSave.json()).createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

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
    expect(saved.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).not.toContain('Day Script progress')
    expect(entries[0].content).toContain('Compact time progress')
  })

  test('completed focus line includes header remainder as the second log line', async ({ page }) => {
    const task = await createTask(page, `DayScript-HeaderRemainder-${Date.now()}`)
    const date = uniqueScriptDate(14)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title} Diagnose login spike ✅`, taskId: task.id },
          { text: 'Checked dashboards' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    expect((await save.json()).createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries[0].content).not.toContain('Day Script progress')
    expect(entries[0].content).toContain('<p>Diagnose login spike</p>')
    expect(entries[0].content.match(/Diagnose login spike/g)).toHaveLength(1)
    expect(entries[0].content).not.toContain('Diagnose login spike ✅')
    expect(entries[0].content).toContain('Checked dashboards')
  })

  test('untimed completed task mention line syncs a day script log', async ({ page }) => {
    const task = await createTask(page, `DayScript-Untimed-${Date.now()}`)
    const date = uniqueScriptDate(15)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `@${task.title} Draft rollout checklist ✅`, taskId: task.id },
          { text: 'List affected services' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)
    expect(saved.createdLogs).toHaveLength(0)
    expect(saved.executionRecords).toHaveLength(0)
    expect(saved.script.blocks[0]).toMatchObject({ startTime: '', endTime: '' })
    const untimedSubmit = await submitProgress(page, date)
    expect(untimedSubmit.createdLogs).toHaveLength(1)
    expect(untimedSubmit.executionRecords).toHaveLength(0)

    const entries = await getEntries(page, task.id)
    expect(entries[0].content).not.toContain('Day Script progress')
    expect(entries[0].content).not.toContain(' · -')
    expect(entries[0].content).toContain('<p>Draft rollout checklist</p>')
    expect(entries[0].content).toContain('List affected services')
  })

  test('new task focus line creates ktlo task and rewrites the header mention', async ({ page }) => {
    const date = uniqueScriptDate(5)
    const title = `Inline KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${title}` },
          { text: 'Investigated production incident' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)
    expect(saved.script.blocks[0].taskIds).toEqual([])
    expect(saved.script.document.content[0].content[0].text).toBe(`10:00-10:30 new task ${title}`)

    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.createdTasks[0]).toMatchObject({
      title,
      type: 'TODO',
      priority: 'MEDIUM',
      tags: ['ktlo'],
      status: 'PENDING',
    })
    expect(submitted.script.blocks[0].taskIds).toEqual([submitted.createdTasks[0].id])

    const header = submitted.script.document.content[0].content
    expect(header[1]).toMatchObject({ type: 'newTaskBadge' })
    expect(header[3]).toMatchObject({
      type: 'text',
      text: `@${title}`,
      marks: [{ type: 'link', attrs: { taskId: submitted.createdTasks[0].id } }],
    })

    const entries = await getEntries(page, submitted.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries.some((entry: { type: string; content: string }) => entry.type === 'body' && entry.content.includes('Investigated production incident'))).toBeTruthy()
    expect(entries.some((entry: { type: string }) => entry.type === 'log')).toBeFalsy()

    const repeat = await submitProgress(page, date)
    expect(repeat.createdTasks).toHaveLength(0)
  })

  test('new task body baseline allows later completed deltas to become task logs', async ({ page }) => {
    const date = uniqueScriptDate(22)
    const title = `Inline KTLO Delta ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${title}` },
          { text: 'Initial incident context' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)
    expect(saved.createdLogs).toHaveLength(0)
    const submitted = await submitProgress(page, date)
    const taskId = submitted.createdTasks[0].id

    const append = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: submitted.script.revision,
        document: {
          ...submitted.script.document,
          content: [
            {
              ...submitted.script.document.content[0],
              content: [
                ...submitted.script.document.content[0].content,
                { type: 'text', text: ' ✅' },
              ],
            },
            ...submitted.script.document.content.slice(1),
            { type: 'paragraph', content: [{ type: 'text', text: 'New investigation finding' }] },
          ],
        },
      },
    })
    expect(append.ok()).toBeTruthy()
    const appended = await append.json()
    expect(appended.createdTasks).toHaveLength(0)
    expect(appended.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, taskId)
    expect(entries).toHaveLength(2)
    expect(entries.some((entry: { type: string; content: string }) => entry.type === 'body' && entry.content.includes('Initial incident context'))).toBeTruthy()
    const logEntry = entries.find((entry: { type: string }) => entry.type === 'log')
    expect(logEntry.content).toContain('New investigation finding')
    expect(logEntry.content).not.toContain('Initial incident context')
  })

  test('new task badge line without baseline still appends when completed later', async ({ page }) => {
    const date = uniqueScriptDate(44)
    const task = await createTask(page, `DayScript-NewTask-MissingBaseline-${Date.now()}`)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '10:00-10:30 ' },
                { type: 'newTaskBadge', attrs: { label: 'new' } },
                { type: 'text', text: ' ' },
                {
                  type: 'text',
                  text: `@${task.title}`,
                  marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(task.id)}`, taskId: task.id } }],
                },
              ],
            },
            { type: 'paragraph', content: [{ type: 'text', text: 'Existing progress before baseline was recorded' }] },
          ],
        },
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.script.blocks[0].taskIds).toEqual([task.id])

    const append = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: saved.script.revision,
        document: {
          ...saved.script.document,
          content: [
            {
              ...saved.script.document.content[0],
              content: [
                ...saved.script.document.content[0].content,
                { type: 'text', text: ' ✅' },
              ],
            },
            ...saved.script.document.content.slice(1),
            { type: 'paragraph', content: [{ type: 'text', text: 'Progress after completion marker' }] },
          ],
        },
      },
    })
    expect(append.ok()).toBeTruthy()

    const submitted = await submitProgress(page, date)
    expect(submitted.createdLogs).toEqual([{ taskId: task.id, entryId: expect.any(String), blockId: expect.any(String) }])
    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'log' })
    expect(entries[0].content).toContain('Existing progress before baseline was recorded')
    expect(entries[0].content).toContain('Progress after completion marker')
  })

  test('dragon focus line appends deltas without completing and carries over', async ({ page }) => {
    const task = await createTask(page, `DayScript-Dragon-${Date.now()}`)
    const date = uniqueScriptDate(23)
    const nextDate = uniqueScriptDate(24)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title} 🐲`, taskId: task.id },
          { text: 'Long task step one' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.script.blocks[0]).toMatchObject({
      completed: false,
      headerText: `@${task.title}`,
    })

    const firstSubmit = await submitProgress(page, date)
    expect(firstSubmit.createdLogs).toHaveLength(1)
    expect(firstSubmit.executionRecords).toHaveLength(0)
    expect(firstSubmit.script.blocks[0]).toMatchObject({ completed: false })

    const append = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: firstSubmit.script.revision,
        document: doc([
          { text: `10:00-10:30 @${task.title} 🐲`, taskId: task.id },
          { text: 'Long task step one' },
          { text: 'Long task step two' },
        ]),
      },
    })
    expect(append.ok()).toBeTruthy()
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(2)
    expect(entries[0].content).toContain('Long task step one')
    expect(entries[1].content).toContain('Long task step two')
    expect(entries[1].content).not.toContain('Long task step one')

    const carry = await page.request.get(`/api/day-scripts/${nextDate}/carry-over-blocks`)
    expect(carry.ok()).toBeTruthy()
    const carryBlocks = await carry.json()
    expect(carryBlocks.some((block: any) => block.taskIds.includes(task.id) && block.headerText === `@${task.title}`)).toBeTruthy()
  })

  test('focus line rejects mutually exclusive completed and dragon markers', async ({ page }) => {
    const task = await createTask(page, `DayScript-Marker-Conflict-${Date.now()}`)
    const date = uniqueScriptDate(25)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 @${task.title} ✅ 🐲`, taskId: task.id },
          { text: 'Ambiguous progress' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toContainEqual({ lineIndex: 0, message: 'Focus line cannot use both ✅ and 🐲.' })
    expect(saved.createdTasks).toHaveLength(0)
    expect(saved.createdLogs).toHaveLength(0)
  })

  test('new task line rejects completed and dragon markers', async ({ page }) => {
    const date = uniqueScriptDate(28)
    const doneTitle = `Invalid Done KTLO ${Date.now()}`
    const dragonTitle = `Invalid Dragon KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${doneTitle} ✅` },
          { text: `11:00-11:30 new task ${dragonTitle} 🐲` },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toContainEqual({ lineIndex: 0, message: 'Focus line cannot combine new task with ✅ or 🐲.' })
    expect(saved.validationErrors).toContainEqual({ lineIndex: 1, message: 'Focus line cannot combine new task with ✅ or 🐲.' })
    expect(saved.createdTasks).toHaveLength(0)
  })

  test('invalid focus draft still saves the document and advances revision', async ({ page }) => {
    const date = uniqueScriptDate(31)
    const title = `Invalid Saved KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${title} ✅` },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toContainEqual({ lineIndex: 0, message: 'Focus line cannot combine new task with ✅ or 🐲.' })
    expect(saved.script.revision).toBe(1)

    const fetched = await page.request.get(`/api/day-scripts/${date}`)
    expect(fetched.ok()).toBeTruthy()
    const fetchedScript = await fetched.json()
    expect(fetchedScript.revision).toBe(1)
    expect(JSON.stringify(fetchedScript.document)).toContain(title)
    expect(JSON.stringify(fetchedScript.document)).toContain('✅')
  })

  test('an invalid recovery draft never deletes existing derived focus blocks', async ({ page }) => {
    const task = await createTask(page, `DayScript-Recovery-${Date.now()}`)
    const date = uniqueScriptDate(34)
    const valid = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([{ text: `10:00-10:30 @${task.title}`, taskId: task.id }, { text: 'Durable progress' }]),
      },
    })
    expect(valid.ok()).toBeTruthy()
    const saved = await valid.json()
    expect(saved.script.blocks).toHaveLength(1)
    const originalBlockId = saved.script.blocks[0].id

    const invalid = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: saved.script.revision,
        document: doc([{ text: `10:00-25:00 @${task.title}`, taskId: task.id }]),
      },
    })
    expect(invalid.ok()).toBeTruthy()
    const recovery = await invalid.json()
    expect(recovery.validationErrors).toContainEqual({ lineIndex: 0, message: 'Malformed time header.' })
    expect(recovery.script.blocks.map((block: { id: string }) => block.id)).toEqual([originalBlockId])
  })

  test('saved block identity survives a focus-line title edit', async ({ page }) => {
    const task = await createTask(page, `DayScript-StableId-${Date.now()}`)
    const date = uniqueScriptDate(35)
    const first = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([{ text: `10:00-10:30 @${task.title} initial label`, taskId: task.id }]),
      },
    })
    expect(first.ok()).toBeTruthy()
    const initial = await first.json()
    const originalBlockId = initial.script.blocks[0].id
    const editedDocument = JSON.parse(JSON.stringify(initial.script.document))
    editedDocument.content[0].content.push({ type: 'text', text: ' revised label' })

    const second = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: initial.script.revision,
        document: editedDocument,
      },
    })
    expect(second.ok()).toBeTruthy()
    const stable = await second.json()
    expect(stable.script.blocks[0].id).toBe(originalBlockId)
    expect(stable.script.document.content[0].attrs.blockId).toBe(originalBlockId)
  })

  test('incomplete new task draft on an empty focus area still saves', async ({ page }) => {
    const date = uniqueScriptDate(32)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: 'new task' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toContainEqual({ lineIndex: 0, message: 'New task line needs a title.' })
    expect(saved.script.revision).toBe(1)
    expect(saved.script.blocks).toHaveLength(0)
    expect(JSON.stringify(saved.script.document)).toContain('new task')

    const fetched = await page.request.get(`/api/day-scripts/${date}`)
    expect(fetched.ok()).toBeTruthy()
    const fetchedScript = await fetched.json()
    expect(fetchedScript.revision).toBe(1)
    expect(fetchedScript.blocks).toHaveLength(0)
    expect(JSON.stringify(fetchedScript.document)).toContain('new task')
  })

  test('existing focus block followed by new task block saves and submits the new task', async ({ page }) => {
    const existingTask = await createTask(page, `DayScript-Focus-Then-New-${Date.now()}`)
    const date = uniqueScriptDate(33)
    const title = `Followup KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `09:00-09:30 @${existingTask.title}`, taskId: existingTask.id },
          { text: 'Existing task context' },
          { text: `new task ${title}` },
          { text: 'Additional task context' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)
    expect(saved.createdTasks).toHaveLength(0)
    expect(saved.script.blocks).toHaveLength(2)

    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.createdTasks[0]).toMatchObject({ title })
    const entries = await getEntries(page, submitted.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'body' })
    expect(entries[0].content).toContain('Additional task context')
  })

  test('mixed-case new task line creates ktlo task on submit', async ({ page }) => {
    const date = uniqueScriptDate(45)
    const title = `Mixed Case KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 New task ${title}` },
          { text: 'Case-insensitive declaration context' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toHaveLength(0)
    expect(saved.createdTasks).toHaveLength(0)
    expect(saved.script.blocks).toHaveLength(1)
    expect(saved.script.blocks[0]).toMatchObject({ headerText: `New task ${title}`, taskIds: [] })

    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.createdTasks[0]).toMatchObject({ title })
    expect(submitted.script.blocks[0].taskIds).toEqual([submitted.createdTasks[0].id])
  })

  test('mixed completed task and new task submit logs progress and creates the new task once', async ({ page }) => {
    const existingTask = await createTask(page, `DayScript-Mixed-${Date.now()}`)
    const date = uniqueScriptDate(29)
    const title = `Mixed Inline KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `09:00-09:30 @${existingTask.title} ✅`, taskId: existingTask.id },
          { text: 'Finished existing task step' },
          { text: `10:00-10:30 new task ${title}` },
          { text: 'Initial context for created item' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)

    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.createdTasks[0]).toMatchObject({ title })
    expect(submitted.createdLogs).toEqual([{ taskId: existingTask.id, entryId: expect.any(String), blockId: expect.any(String) }])

    const existingEntries = await getEntries(page, existingTask.id)
    expect(existingEntries).toHaveLength(1)
    expect(existingEntries[0].content).toContain('Finished existing task step')

    const newEntries = await getEntries(page, submitted.createdTasks[0].id)
    expect(newEntries).toHaveLength(1)
    expect(newEntries[0]).toMatchObject({ type: 'body' })
    expect(newEntries[0].content).toContain('Initial context for created item')

    const repeat = await submitProgress(page, date)
    expect(repeat.createdTasks).toHaveLength(0)
    expect(repeat.createdLogs).toHaveLength(0)
  })

  test('new task line creates baseline task and remains carry-over eligible', async ({ page }) => {
    const date = uniqueScriptDate(26)
    const nextDate = uniqueScriptDate(27)
    const title = `Inline Carry KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${title}` },
          { text: 'Initial long-running context' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)

    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.createdLogs).toHaveLength(0)
    expect(submitted.executionRecords).toHaveLength(0)
    expect(submitted.script.blocks[0]).toMatchObject({
      completed: false,
      taskIds: [submitted.createdTasks[0].id],
    })
    const rewrittenHeader = submitted.script.document.content[0].content
    expect(rewrittenHeader[rewrittenHeader.length - 1].text).toBe(`@${title}`)

    const entries = await getEntries(page, submitted.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'body' })
    expect(entries[0].content).toContain('Initial long-running context')

    const carry = await page.request.get(`/api/day-scripts/${nextDate}/carry-over-blocks`)
    expect(carry.ok()).toBeTruthy()
    const carryBlocks = await carry.json()
    expect(carryBlocks.some((block: any) => block.taskIds.includes(submitted.createdTasks[0].id) && block.headerText === `@${title}`)).toBeTruthy()
  })

  test('bare new task baseline allows first later completed progress to become a task log', async ({ page }) => {
    const date = uniqueScriptDate(30)
    const title = `Bare Inline KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `10:00-10:30 new task ${title}` },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)

    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.createdLogs).toHaveLength(0)
    const taskId = submitted.createdTasks[0].id

    const append = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: submitted.script.revision,
        document: {
          ...submitted.script.document,
          content: [
            {
              ...submitted.script.document.content[0],
              content: [
                ...submitted.script.document.content[0].content,
                { type: 'text', text: ' ✅' },
              ],
            },
            { type: 'paragraph', content: [{ type: 'text', text: 'First concrete progress' }] },
          ],
        },
      },
    })
    expect(append.ok()).toBeTruthy()

    const completed = await submitProgress(page, date)
    expect(completed.createdLogs).toEqual([{ taskId, entryId: expect.any(String), blockId: expect.any(String) }])
    const entries = await getEntries(page, taskId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'log' })
    expect(entries[0].content).toContain('First concrete progress')
  })

  test('new task text inside code blocks does not create or rewrite tasks', async ({ page }) => {
    const date = uniqueScriptDate(21)
    const title = `Code KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              content: [{ type: 'text', text: `new task ${title}` }],
            },
          ],
        },
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)
    expect(saved.script.document.content[0]).toMatchObject({
      type: 'codeBlock',
      content: [{ type: 'text', text: `new task ${title}` }],
    })
  })

  test('compact time new task line creates ktlo task and normalizes the header', async ({ page }) => {
    const date = uniqueScriptDate(11)
    const title = `Inline Compact KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `1443-1500 new task ${title}` },
          { text: 'Investigated compact-time production incident' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)
    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.script.blocks[0]).toMatchObject({
      startTime: '14:43',
      endTime: '15:00',
    })
    expect(submitted.script.document.content[0].content[0].text).toBe('14:43-15:00 ')
    expect(submitted.script.document.content[0].content[1]).toMatchObject({ type: 'newTaskBadge' })

    const entries = await getEntries(page, submitted.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries.some((entry: { type: string; content: string }) => entry.type === 'body' && entry.content.includes('Investigated compact-time production incident'))).toBeTruthy()
    expect(entries.some((entry: { type: string }) => entry.type === 'log')).toBeFalsy()
  })

  test('untimed new task line creates ktlo task and rewrites the header mention', async ({ page }) => {
    const date = uniqueScriptDate(17)
    const title = `Untimed KTLO ${Date.now()}`

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: doc([
          { text: `new task ${title}` },
          { text: 'Untimed production incident context' },
        ]),
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.createdTasks).toHaveLength(0)
    const submitted = await submitProgress(page, date)
    expect(submitted.createdTasks).toHaveLength(1)
    expect(submitted.script.blocks[0]).toMatchObject({
      startTime: '',
      endTime: '',
      taskIds: [submitted.createdTasks[0].id],
    })
    expect(submitted.script.document.content[0].content[0]).toMatchObject({ type: 'newTaskBadge' })
    expect(submitted.script.document.content[0].content[2]).toMatchObject({
      type: 'text',
      text: `@${title}`,
      marks: [{ type: 'link', attrs: { taskId: submitted.createdTasks[0].id } }],
    })

    const entries = await getEntries(page, submitted.createdTasks[0].id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'body' })
    expect(entries[0].content).toContain('Untimed production incident context')
  })

  test('dash lines stay ordinary progress instead of separating focus blocks', async ({ page }) => {
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
    expect(saved.script.blocks[0].progressText).toBe('Synced progress\n----\nDetached daily note')
    expect(saved.createdLogs).toHaveLength(0)
    expect((await submitProgress(page, date)).createdLogs).toHaveLength(1)

    const entries = await getEntries(page, task.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('Synced progress')
    expect(entries[0].content).toContain('Detached daily note')

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

  test('focus line with multiple task mentions is rejected', async ({ page }) => {
    const taskA = await createTask(page, `DayScript-MultiA-${Date.now()}`)
    const taskB = await createTask(page, `DayScript-MultiB-${Date.now()}`)
    const date = uniqueScriptDate(16)

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: 0,
        document: {
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: '10:00-10:30 ' },
              { type: 'text', text: `@${taskA.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskA.id)}`, taskId: taskA.id } }] },
              { type: 'text', text: ' and ' },
              { type: 'text', text: `@${taskB.title}`, marks: [{ type: 'link', attrs: { href: `/today?task=${encodeURIComponent(taskB.id)}`, taskId: taskB.id } }] },
            ],
          }],
        },
      },
    })
    expect(save.ok()).toBeTruthy()
    const saved = await save.json()
    expect(saved.validationErrors).toEqual([{ lineIndex: 0, message: 'Focus line can reference only one task.' }])
    expect(saved.createdLogs).toHaveLength(0)
  })

  test('Day Script editor only takes over after actual progress editing', async ({ page }) => {
    const task = await createTask(page, `DayScript-Takeover-${Date.now()}`)
    const now = new Date()
    const start = formatTime(addMinutes(now, -5))
    const end = formatTime(addMinutes(now, 25))
    const date = todayDate()

    const save = await page.request.put(`/api/day-scripts/${date}`, {
      data: {
        expectedRevision: await getDayScriptRevision(page, date),
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

    await page.goto(`/today?date=${date}&lang=zh-CN`)
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
