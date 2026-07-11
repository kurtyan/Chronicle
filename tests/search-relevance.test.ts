import { test, expect, type Page } from '@playwright/test'

async function createTask(page: Page, title: string, tags: string[] = [], body?: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM', tags, body },
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

async function createNote(page: Page, title: string, contentHtml: string, tags: string[] = []) {
  const res = await page.request.post('/api/notes', {
    data: { title, contentHtml, tags },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function searchTasks(page: Page, query: string) {
  const res = await page.request.get(`/api/search?q=${encodeURIComponent(query)}&scope=tasks`)
  return res.json()
}

async function searchAll(page: Page, query: string) {
  const res = await page.request.get(`/api/search?q=${encodeURIComponent(query)}&scope=all`)
  return res.json()
}

async function searchNotes(page: Page, query: string) {
  const res = await page.request.get(`/api/search?q=${encodeURIComponent(query)}&scope=notes`)
  return res.json()
}

test.describe('Search relevance and phrase ranking', () => {
  test('phrase match in title ranks above phrase match in content', async ({ page }) => {
    const unique = Date.now()

    const taskTitle = await createTask(page, `POC Build Strategy ${unique}`)
    const taskContent = await createTask(page, `Build Pipeline ${unique}`)
    await addLog(page, taskContent.id, `<p>Completed poc build for feature ${unique}</p>`)

    const result = await searchTasks(page, 'poc build')
    const ids = result.results.map((r: any) => r.taskId)

    expect(ids).toContain(taskTitle.id)
    expect(ids).toContain(taskContent.id)

    const titleIdx = ids.indexOf(taskTitle.id)
    const contentIdx = ids.indexOf(taskContent.id)

    expect(titleIdx).toBeLessThan(contentIdx)
  })

  test('exact ID match ranks highest', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `IDSearch-${unique}`)
    await createTask(page, `Another task mentioning ${task.id} in title ${unique}`)

    const result = await searchTasks(page, task.id)
    expect(result.results[0].taskId).toBe(task.id)
    expect(result.results[0].exactMatch).toBe(true)
  })

  test('title exact phrase ranks above content-only match', async ({ page }) => {
    const unique = Date.now()
    const taskTitle = await createTask(page, `neo4j integration ${unique}`)
    const taskContent = await createTask(page, `Database work ${unique}`)
    await addLog(page, taskContent.id, `<p>Long entry about neo4j and graph databases ${unique}</p>`)

    const result = await searchTasks(page, 'neo4j')
    const ids = result.results.map((r: any) => r.taskId)

    expect(ids[0]).toBe(taskTitle.id)
    expect(ids).toContain(taskContent.id)
    expect(ids.indexOf(taskTitle.id)).toBeLessThan(ids.indexOf(taskContent.id))
  })

  test('exact tag match ranks above content-only FTS match', async ({ page }) => {
    const unique = Date.now()
    const taskTag = await createTask(page, `TagSearch ${unique}`, ['urgent'])
    const taskContent = await createTask(page, `ContentSearch ${unique}`)
    await addLog(page, taskContent.id, `<p>This entry mentions urgent somewhere in the text ${unique}</p>`)

    const result = await searchTasks(page, 'urgent')
    const ids = result.results.map((r: any) => r.taskId)

    expect(ids).toContain(taskTag.id)
    expect(ids).toContain(taskContent.id)
    expect(ids.indexOf(taskTag.id)).toBeLessThan(ids.indexOf(taskContent.id))
  })

  test('multiple entry hits on same task are visible in scope=all', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `MultiEntry ${unique}`)
    const log1 = await addLog(page, task.id, `<p>multi-entry needle A ${unique}</p>`)
    const log2 = await addLog(page, task.id, `<p>multi-entry needle B ${unique}</p>`)

    const result = await searchAll(page, `multi-entry needle ${unique}`)
    const entryHits = result.results.taskEntries.filter((r: any) => r.taskId === task.id)
    expect(entryHits.length).toBeGreaterThanOrEqual(2)
    const entryIds = entryHits.map((r: any) => r.entryId)
    expect(entryIds).toContain(log1.id)
    expect(entryIds).toContain(log2.id)
  })

  test('Board scope shows one aggregated task with multiple hits', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `BoardMulti ${unique}`)
    await addLog(page, task.id, `<p>board-needle first ${unique}</p>`)
    await addLog(page, task.id, `<p>board-needle second ${unique}</p>`)

    const result = await searchTasks(page, `board-needle ${unique}`)
    const taskHits = result.results.filter((r: any) => r.taskId === task.id)
    expect(taskHits.length).toBe(1)
  })

  test('Board search keeps distinct tasks when one task has many matching entries', async ({ page }) => {
    const unique = Date.now()
    const noisyTask = await createTask(page, `CandidateNoise ${unique}`)
    const distinctTask = await createTask(page, `CandidateDistinct ${unique}`)
    for (let i = 0; i < 10; i++) {
      await addLog(page, noisyTask.id, `<p>candidate-cap-needle ${unique} ${i}</p>`)
    }
    await addLog(page, distinctTask.id, `<p>candidate-cap-needle ${unique}</p>`)

    const result = await page.request.get(
      `/api/search?q=${encodeURIComponent(`candidate-cap-needle ${unique}`)}&scope=tasks&limit=2`
    ).then((res) => res.json())
    const ids = result.results.map((entry: any) => entry.taskId)
    expect(ids).toContain(noisyTask.id)
    expect(ids).toContain(distinctTask.id)
  })

  test('search API normalizes malformed and oversized limits', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `LimitValidation ${unique}`)

    const malformed = await page.request.get(
      `/api/search?q=${encodeURIComponent(`LimitValidation ${unique}`)}&scope=tasks&limit=not-a-number`
    ).then((res) => res.json())
    expect(malformed.results.some((entry: any) => entry.taskId === task.id)).toBeTruthy()

    const oversized = await page.request.get(
      `/api/search?q=${encodeURIComponent(`LimitValidation ${unique}`)}&scope=tasks&limit=999999`
    ).then((res) => res.json())
    expect(oversized.results.some((entry: any) => entry.taskId === task.id)).toBeTruthy()
  })

  test('Chinese multi-token search works with unified index', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `中文搜索测试 ${unique}`)
    await addLog(page, task.id, `<p>首都天安门广场出现一小撮暴徒。</p>`)

    const result = await searchTasks(page, '首都天安门')
    expect(result.results.some((r: any) => r.taskId === task.id)).toBeTruthy()
  })

  test('technical tokens (URLs, paths) are searchable', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `TechToken ${unique}`)
    await addLog(page, task.id, `<p>Fix https://example.com/api/v2/users endpoint</p>`)

    const result = await searchTasks(page, 'example.com')
    expect(result.results.some((r: any) => r.taskId === task.id)).toBeTruthy()
  })

  test('HTML tag noise is not indexed', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `HtmlNoise ${unique}`)
    await addLog(page, task.id, `<p><strong>BoldContent</strong> text here</p>`)

    const result = await searchTasks(page, 'strong')
    expect(result.results.some((r: any) => r.taskId === task.id && r.matchType !== 'task')).toBeFalsy()
  })

  test('archived notes excluded by default in notes search', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `ArchiveExcl ${unique}`, `<p>ArchiveExclBody ${unique}</p>`)
    await page.request.post(`/api/notes/${note.id}/archive`)

    const defaultResult = await searchNotes(page, `ArchiveExclBody ${unique}`)
    expect(defaultResult.results.some((r: any) => r.noteId === note.id)).toBeFalsy()

    const archivedResult = await page.request.get(
      `/api/search?q=${encodeURIComponent(`ArchiveExclBody ${unique}`)}&scope=notes&includeArchived=true`
    ).then((r) => r.json())
    expect(archivedResult.results.some((r: any) => r.noteId === note.id)).toBeTruthy()
  })

  test('short tokens JS and TS are searchable', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `ShortToken ${unique}`)
    await addLog(page, task.id, `<p>Configure JS and TS build pipeline</p>`)

    const jsResult = await searchTasks(page, 'JS')
    expect(jsResult.results.some((r: any) => r.taskId === task.id)).toBeTruthy()

    const tsResult = await searchTasks(page, 'TS')
    expect(tsResult.results.some((r: any) => r.taskId === task.id)).toBeTruthy()
  })

  test('rebuild creates working index from source data', async ({ page }) => {
    const unique = Date.now()
    const task = await createTask(page, `RebuildTest ${unique}`)
    await addLog(page, task.id, `<p>RebuildNeedle ${unique}</p>`)

    const rebuild = await page.request.post('/api/search/rebuild')
    expect(rebuild.ok()).toBeTruthy()

    const result = await searchTasks(page, `RebuildNeedle ${unique}`)
    expect(result.results.some((r: any) => r.taskId === task.id)).toBeTruthy()
  })

  test('note search returns snippets and correct matched source', async ({ page }) => {
    const unique = Date.now()
    const note = await createNote(page, `NoteSnippet ${unique}`, `<p>NoteSnippetBody content here ${unique}</p>`, ['tag1'])

    const result = await searchNotes(page, `NoteSnippetBody ${unique}`)
    expect(result.results.some((r: any) => r.noteId === note.id)).toBeTruthy()
    const hit = result.results.find((r: any) => r.noteId === note.id)
    expect(hit.snippet).toBeTruthy()
    expect(hit.matchedSource).toBe('note_content')
  })

  test('scope=all returns counts and total', async ({ page }) => {
    const unique = Date.now()
    await createTask(page, `CountTest task ${unique}`)
    await createNote(page, `CountTest note ${unique}`, `<p>CountTestBody ${unique}</p>`)

    const result = await searchAll(page, `CountTest ${unique}`)
    expect(result.counts).toBeDefined()
    expect(result.total).toBeGreaterThan(0)
    expect(result.results.tasks.length + result.results.taskEntries.length + result.results.notes.length).toBeGreaterThan(0)
  })
})
