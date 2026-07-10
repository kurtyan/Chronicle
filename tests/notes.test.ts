import { test, expect, type Page } from '@playwright/test'

async function createTask(page: Page, title: string, body?: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM', tags: ['notes'], body },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function addLog(page: Page, taskId: string, content: string) {
  const res = await page.request.post(`/api/tasks/${taskId}/logs`, {
    data: { content, type: 'log' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function createNote(page: Page, title: string, contentHtml = '<p>Initial note content</p>', linkedTaskIds: string[] = []) {
  const res = await page.request.post('/api/notes', {
    data: { title, contentHtml, tags: ['notes'], linkedTaskIds },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

const searchShortcut = process.platform === 'darwin' ? 'Meta+Shift+F' : 'Control+Shift+F'

test.describe('Notes', () => {
  test('CRUD, archive default exclusion, note FTS, and global search grouping', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `NotesApi-${unique}`, '<p>Alpha useful link and planning detail</p>')

    const searchNotes = await page.request.get(`/api/search?q=${encodeURIComponent('useful link')}&scope=notes`)
    expect(searchNotes.ok()).toBeTruthy()
    const noteSearchBody = await searchNotes.json()
    expect(noteSearchBody.results.some((result: any) => result.noteId === note.id)).toBeTruthy()

    const searchAll = await page.request.get(`/api/search?q=${encodeURIComponent(`NotesApi-${unique}`)}&scope=all`)
    expect(searchAll.ok()).toBeTruthy()
    const allBody = await searchAll.json()
    expect(allBody.results.notes.some((result: any) => result.noteId === note.id)).toBeTruthy()
    expect(Array.isArray(allBody.results.tasks)).toBeTruthy()
    expect(Array.isArray(allBody.results.taskEntries)).toBeTruthy()

    const archive = await page.request.post(`/api/notes/${note.id}/archive`)
    expect(archive.ok()).toBeTruthy()

    const defaultList = await (await page.request.get('/api/notes')).json()
    expect(defaultList.some((item: any) => item.id === note.id)).toBeFalsy()

    const archivedList = await (await page.request.get('/api/notes?includeArchived=true')).json()
    expect(archivedList.some((item: any) => item.id === note.id && item.archived)).toBeTruthy()

    const archivedSearch = await (await page.request.get(`/api/search?q=${encodeURIComponent(`NotesApi-${unique}`)}&scope=notes`)).json()
    expect(archivedSearch.results.some((result: any) => result.noteId === note.id)).toBeFalsy()

    const archivedNotesSearch = await (await page.request.get(`/api/notes?q=${encodeURIComponent(`NotesApi-${unique}`)}&includeArchived=true`)).json()
    expect(archivedNotesSearch.some((item: any) => item.id === note.id && item.archived)).toBeTruthy()
  })

  test('creates a note from a task, appends a task entry, and exposes linked notes/tasks', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `NotesTask-${unique}`, '<p>Task body for note conversion</p>')
    const log = await addLog(page, task.id, '<p>Decision: keep separate note FTS</p>')

    const noteRes = await page.request.post(`/api/tasks/${task.id}/create-note`)
    expect(noteRes.ok()).toBeTruthy()
    const note = await noteRes.json()
    expect(note.id).toMatch(/^N\d{10}$/)
    expect(note.title).toBe(task.title)
    expect(note.contentHtml).toContain('Task logs')
    expect(note.contentHtml).toContain('Decision: keep separate note FTS')

    const appendRes = await page.request.post(`/api/tasks/${task.id}/entries/${log.id}/add-to-note`, {
      data: { noteId: note.id },
    })
    expect(appendRes.ok()).toBeTruthy()
    const appended = await appendRes.json()
    expect(appended.contentHtml).toContain(`From ${task.id} - ${task.title}`)

    const taskNotes = await (await page.request.get(`/api/tasks/${task.id}/notes`)).json()
    expect(taskNotes.some((item: any) => item.id === note.id)).toBeTruthy()

    const noteTasks = await (await page.request.get(`/api/notes/${note.id}/tasks`)).json()
    expect(noteTasks.some((item: any) => item.id === task.id)).toBeTruthy()
  })

  test('rejects malformed note API requests and maps missing references to 404', async ({ page }) => {
    const badCreate = await page.request.post('/api/notes', { data: { contentHtml: '<p>Missing title</p>' } })
    expect(badCreate.status()).toBe(400)

    const partialTitle = `InvalidLinkedTask-${Date.now()}`
    const invalidLinkedTask = await page.request.post('/api/notes', {
      data: { title: partialTitle, linkedTaskIds: ['T0000000000'] },
    })
    expect(invalidLinkedTask.status()).toBe(404)
    const invalidLinkedTaskSearch = await (await page.request.get(`/api/notes?q=${encodeURIComponent(partialTitle)}&includeArchived=true`)).json()
    expect(invalidLinkedTaskSearch.some((item: any) => item.title === partialTitle)).toBeFalsy()

    const badUpdate = await page.request.put('/api/notes/N0000000000', { data: { tags: ['ok', 42] } })
    expect(badUpdate.status()).toBe(400)

    const missingAppend = await page.request.post('/api/notes/N0000000000/append', { data: { contentHtml: '<p>x</p>' } })
    expect(missingAppend.status()).toBe(404)

    const note = await createNote(page, `AppendIntegrity-${Date.now()}`, '<p>Original body</p>')
    const badAppendSource = await page.request.post(`/api/notes/${note.id}/append`, {
      data: { contentHtml: '<p>Should not persist</p>', source: { taskId: 'T0000000000', entryId: 'missing-entry' } },
    })
    expect(badAppendSource.status()).toBe(404)
    const unchanged = await (await page.request.get(`/api/notes/${note.id}`)).json()
    expect(unchanged.contentHtml).toBe('<p>Original body</p>')

    const missingTask = await page.request.post('/api/tasks/T0000000000/create-note')
    expect(missingTask.status()).toBe(404)

    const task = await createTask(page, `MissingEntry-${Date.now()}`)
    const missingEntry = await page.request.post(`/api/tasks/${task.id}/entries/missing-entry/add-to-note`, { data: {} })
    expect(missingEntry.status()).toBe(404)

    const log = await addLog(page, task.id, '<p>Malformed JSON target</p>')
    await page.goto('/?lang=en')
    const malformedAddToNoteStatus = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"noteId":',
      })
      return res.status
    }, `/api/tasks/${task.id}/entries/${log.id}/add-to-note`)
    expect(malformedAddToNoteStatus).toBe(400)

    const missingNoteTasks = await page.request.get('/api/notes/N0000000000/tasks')
    expect(missingNoteTasks.status()).toBe(404)

    const missingTaskNotes = await page.request.get('/api/tasks/T0000000000/notes')
    expect(missingTaskNotes.status()).toBe(404)
  })

  test('deleting a task removes stale note links', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `DeleteLinkedTask-${unique}`)
    const note = await createNote(page, `DeleteLinkedNote-${unique}`, '<p>Linked before delete</p>', [task.id])

    const beforeDelete = await (await page.request.get(`/api/tasks/${task.id}/notes`)).json()
    expect(beforeDelete.some((item: any) => item.id === note.id)).toBeTruthy()

    const deleteTask = await page.request.delete(`/api/tasks/${task.id}`)
    expect(deleteTask.ok()).toBeTruthy()

    const afterDeleteTaskNotes = await page.request.get(`/api/tasks/${task.id}/notes`)
    expect(afterDeleteTaskNotes.status()).toBe(404)
    const noteTasks = await (await page.request.get(`/api/notes/${note.id}/tasks`)).json()
    expect(noteTasks.some((item: any) => item.id === task.id)).toBeFalsy()
  })

  test('syncs task mentions in note HTML into linked tasks', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `MentionLinked-${unique}`)
    const note = await createNote(
      page,
      `MentionNote-${unique}`,
      `<p>Related to <a href="/?task=${task.id}" data-task-id="${task.id}">@${task.title}</a></p>`
    )

    const linkedTasks = await (await page.request.get(`/api/notes/${note.id}/tasks`)).json()
    expect(linkedTasks.some((item: any) => item.id === task.id)).toBeTruthy()
  })

  test('Notes page creates and autosaves a note', async ({ page }) => {
    const unique = Date.now()
    await page.goto('/notes?lang=en')
    await page.waitForLoadState('load')

    await page.getByTitle('New note').click()
    await page.waitForURL(/\/notes\?id=N\d{10}/)
    await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Untitled note')
    await page.getByPlaceholder('Untitled note').fill(`UiNote-${unique}`)
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror')
    await editor.click()
    await page.keyboard.type('Autosaved note body from Playwright')

    await expect(page.getByText('saved', { exact: true })).toBeVisible({ timeout: 5000 })
    await expect.poll(async () => {
      const search = await (await page.request.get(`/api/search?q=${encodeURIComponent(`UiNote-${unique}`)}&scope=notes`)).json()
      return search.results.some((result: any) => result.title === `UiNote-${unique}`)
    }).toBeTruthy()
    await page.getByPlaceholder('Search notes...').fill(`UiNote-${unique}`)
    await expect(page.getByText(`UiNote-${unique}`).first()).toBeVisible()

    const search = await (await page.request.get(`/api/search?q=${encodeURIComponent(`UiNote-${unique}`)}&scope=notes`)).json()
    expect(search.results.some((result: any) => result.title === `UiNote-${unique}`)).toBeTruthy()
  })

  test('create then immediately rename and type body preserves title', async ({ page }) => {
    const unique = Date.now()
    await page.goto('/notes?lang=en')
    await page.waitForLoadState('load')

    await page.getByTitle('New note').click()
    await page.waitForURL(/\/notes\?id=N\d{10}/)
    await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Untitled note')
    await page.getByPlaceholder('Untitled note').fill(`UiRenameA-${unique}`)
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror')
    await editor.click()
    await page.keyboard.type(`RenameBodyA-${unique}`)

    await expect(page.getByText('saved', { exact: true })).toBeVisible({ timeout: 5000 })
    const savedTitle = await page.getByPlaceholder('Untitled note').inputValue()
    expect(savedTitle).toBe(`UiRenameA-${unique}`)

    await expect.poll(async () => {
      const note = await (await page.request.get(`/api/notes/${(page.url().match(/id=(N\d{10})/) || [])[1]}`)).json()
      return note.title
    }).toBe(`UiRenameA-${unique}`)

    await expect.poll(async () => {
      const search = await (await page.request.get(`/api/search?q=${encodeURIComponent(`UiRenameA-${unique}`)}&scope=notes`)).json()
      return search.results.some((result: any) => result.title === `UiRenameA-${unique}`)
    }).toBeTruthy()
  })

  test('rapid title changes preserve last value', async ({ page }) => {
    const unique = Date.now()
    await page.goto('/notes?lang=en')
    await page.waitForLoadState('load')

    await page.getByTitle('New note').click()
    await page.waitForURL(/\/notes\?id=N\d{10}/)
    await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Untitled note')

    const titleInput = page.getByPlaceholder('Untitled note')
    await titleInput.fill(`UiFastA-${unique}`)
    await titleInput.fill(`UiFastB-${unique}`)
    await titleInput.fill(`UiFastC-${unique}`)

    await expect(page.getByText('saved', { exact: true })).toBeVisible({ timeout: 5000 })
    const savedTitle = await titleInput.inputValue()
    expect(savedTitle).toBe(`UiFastC-${unique}`)

    const noteId = (page.url().match(/id=(N\d{10})/) || [])[1]
    await expect.poll(async () => {
      const note = await (await page.request.get(`/api/notes/${noteId}`)).json()
      return note.title
    }).toBe(`UiFastC-${unique}`)
  })

  test('Notes page searches body content through the API', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `BodySearchTitle-${unique}`, `<p>NeedleBody-${unique} appears only in the body.</p>`)
    const unrelated = await createNote(page, `BodySearchUnrelated-${unique}`, '<p>No matching content here.</p>')

    await page.goto('/notes?lang=en')
    await page.waitForLoadState('load')
    await expect(page.getByText(unrelated.title).first()).toBeVisible()
    await page.getByPlaceholder('Search notes...').fill(`NeedleBody-${unique}`)
    await expect(page.getByText(note.title).first()).toBeVisible()
    await expect(page.getByText(unrelated.title).first()).not.toBeVisible()
  })

  test('pending autosave survives immediate note switch', async ({ page }) => {
    const unique = Date.now()
    const first = await createNote(page, `SwitchFirst-${unique}`)
    const second = await createNote(page, `SwitchSecond-${unique}`)

    await page.goto(`/notes?id=${first.id}&lang=en`)
    await page.waitForLoadState('load')
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror')
    await editor.click()
    await page.keyboard.type(`SwitchBody-${unique}`)
    await page.getByText(second.title).click()

    await expect.poll(async () => {
      const saved = await (await page.request.get(`/api/notes/${first.id}`)).json()
      return saved.contentHtml
    }).toContain(`SwitchBody-${unique}`)
  })

  test('pending autosave flushes before creating a new note', async ({ page }) => {
    const unique = Date.now()
    const first = await createNote(page, `CreateFlushFirst-${unique}`)

    await page.goto(`/notes?id=${first.id}&lang=en`)
    await page.waitForLoadState('load')
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror')
    await editor.click()
    await page.keyboard.type(`CreateFlushBody-${unique}`)
    await page.getByTitle('New note').click()
    await expect(page).toHaveURL(/\/notes\?id=N\d{10}/)

    await expect.poll(async () => {
      const saved = await (await page.request.get(`/api/notes/${first.id}`)).json()
      return saved.contentHtml
    }).toContain(`CreateFlushBody-${unique}`)
  })

  test('switching notes does not prepend blank paragraphs', async ({ page }) => {
    const unique = Date.now()
    const first = await createNote(page, `NoLeadingBlankFirst-${unique}`, `<p>FirstBody-${unique}</p>`)
    const second = await createNote(page, `NoLeadingBlankSecond-${unique}`, `<p>SecondBody-${unique}</p>`)

    await page.goto(`/notes?id=${first.id}&lang=en`)
    await page.waitForLoadState('load')
    const firstListItem = page.locator('aside button').filter({ hasText: first.title })
    const secondListItem = page.locator('aside button').filter({ hasText: second.title })
    await secondListItem.click()
    await firstListItem.click()
    await secondListItem.click()

    await expect.poll(async () => {
      const saved = await (await page.request.get(`/api/notes/${first.id}`)).json()
      return saved.contentHtml
    }).toBe(`<p>FirstBody-${unique}</p>`)
  })

  test('Escape from note editor returns focus to the note list', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `EscFocusNote-${unique}`, `<p>EscFocusBody-${unique}</p>`)

    await page.goto(`/notes?id=${note.id}&lang=en`)
    await page.waitForLoadState('load')
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror')
    await editor.click()
    await expect(editor).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(page.locator(`[data-note-id="${note.id}"]`)).toBeFocused()
  })

  test('archived notes can be shown, searched, opened, and unarchived', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `ArchiveUi-${unique}`, `<p>ArchiveBody-${unique}</p>`)
    await page.request.post(`/api/notes/${note.id}/archive`)

    await page.goto('/notes?lang=en')
    await page.waitForLoadState('load')
    await page.getByLabel('Archived').check()
    await page.getByPlaceholder('Search notes...').fill(`ArchiveBody-${unique}`)
    await page.getByText(note.title).click()
    await expect(page).toHaveURL(new RegExp(`/notes\\?id=${note.id}`))
    await page.getByTitle('Unarchive').click()
    await expect(page.getByTitle('Archive')).toBeVisible()

    await expect.poll(async () => {
      const unarchived = await (await page.request.get(`/api/notes/${note.id}`)).json()
      return unarchived.archived
    }).toBeFalsy()
  })

  test('Cmd+Shift+F opens global search from Notes and Today', async ({ page }) => {
    await page.goto('/notes?lang=en')
    await page.keyboard.press(searchShortcut)
    await expect(page.getByRole('dialog').getByPlaceholder('Search...')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.goto('/today?lang=en')
    await page.keyboard.press(searchShortcut)
    await expect(page.getByRole('dialog').getByPlaceholder('Search...')).toBeVisible()
  })

  test('global search finds note body content and opens the note', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `GlobalNote-${unique}`, `<p>GlobalBodyNeedle-${unique}</p>`)

    await page.goto('/today?lang=en')
    await page.keyboard.press(searchShortcut)
    await page.getByRole('dialog').getByPlaceholder('Search...').fill(`GlobalBodyNeedle-${unique}`)
    await page.getByRole('dialog').getByText(note.title).click()
    await expect(page).toHaveURL(new RegExp(`/notes\\?id=${note.id}`))
    await expect(page.locator('.search-highlight').filter({ hasText: `GlobalBodyNeedle-${unique}` }).first()).toBeVisible()
  })

  test('global search finds task entries and opens the task', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `GlobalEntryTask-${unique}`)
    const log = await addLog(page, task.id, `<p>GlobalEntryNeedle-${unique}</p>`)

    await page.goto('/notes?lang=en')
    await page.keyboard.press(searchShortcut)
    await page.getByRole('dialog').getByPlaceholder('Search...').fill(`GlobalEntryNeedle-${unique}`)
    await page.getByRole('dialog').getByText(task.title).click()
    await expect(page).toHaveURL(/\/(\?lang=en)?$/)
    await expect(page.locator('h4').filter({ hasText: task.title }).first()).toBeVisible()
    await expect(page.locator(`[data-task-entry-id="${log.id}"] .search-highlight`).filter({ hasText: `GlobalEntryNeedle-${unique}` }).first()).toBeVisible()
  })

  test('/api/search/rebuild rebuilds the notes search index', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `RebuildNote-${unique}`, `<p>RebuildNeedle-${unique}</p>`)
    const rebuild = await page.request.post('/api/search/rebuild')
    expect(rebuild.ok()).toBeTruthy()
    const search = await (await page.request.get(`/api/search?q=${encodeURIComponent(`RebuildNeedle-${unique}`)}&scope=notes`)).json()
    expect(search.results.some((result: any) => result.noteId === note.id)).toBeTruthy()
  })

  test('task UI can create linked notes and append selected entry text to an existing note', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `TaskNoteUi-${unique}`)
    await addLog(page, task.id, '<p>First entry should become a note</p>')
    await addLog(page, task.id, '<p>Selected useful URL https://example.com/notes</p>')
    const targetNote = await createNote(page, `AppendTarget-${unique}`, `<p>PickerBodyNeedle-${unique}</p>`)

    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: task.title }).first().click()

    await page.getByTitle('Create note from task').click()
    await expect(page).toHaveURL(/\/notes\?id=N\d{10}/)

    await page.goto('/?lang=en')
    await page.locator('h4').filter({ hasText: task.title }).first().click()
    const secondEntry = page.getByTestId('task-entry-block').filter({ hasText: 'Selected useful URL' })
    const secondContent = secondEntry.locator('[data-testid="entry-content"]')
    await secondContent.evaluate((el) => {
      const p = el.querySelector('p')
      if (!p) return
      const range = document.createRange()
      range.selectNodeContents(p)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })
    await secondContent.dispatchEvent('mouseup')
    await page.getByText('Add to note').click()
    await page.getByPlaceholder('Search notes...').fill(`PickerBodyNeedle-${unique}`)
    await page.getByText(targetNote.title).click()

    const updated = await (await page.request.get(`/api/notes/${targetNote.id}`)).json()
    expect(updated.contentHtml).toContain('https://example.com/notes')

    const taskNotes = await (await page.request.get(`/api/tasks/${task.id}/notes`)).json()
    expect(taskNotes.some((item: any) => item.id === targetNote.id)).toBeTruthy()
  })
})
