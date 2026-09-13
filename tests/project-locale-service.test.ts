import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, getDb, closeDb } from '../server/src/db'
import { createArea, createMilestone } from '../server/src/services/projectService'
import { createTask, createTaskEntry } from '../server/src/services/taskService'
import { createNote, getNoteById } from '../server/src/services/noteService'
import { createProjectReview } from '../server/src/services/projectReviewService'
import { acceptProjectInsight, createProjectInsight, getProjectInsight, retryProjectInsight, projectInsightToHtml } from '../server/src/services/projectInsightService'
import { projectRoutes } from '../server/src/projectRoutes'

test.describe('Project generation locale uses isolated storage and model fixtures', () => {
  test.describe.configure({ mode: 'serial' })
  let directory: string
  const originalFetch = globalThis.fetch
  const previous: Record<string, string | undefined> = {}
  test.beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-locale-'))
    const env = { CHRONICLE_CONFIG_DIR: path.join(directory, 'config'), CHRONICLE_CONFIG_PATH: path.join(directory, 'config/config.json'), CHRONICLE_DB_PATH: path.join(directory, 'tasks.db'), CHRONICLE_LOG_PATH: path.join(directory, 'server.log'), CHRONICLE_LLM_BASE_URL: 'https://example.invalid/v1', CHRONICLE_LLM_MODEL: 'project-locale-fixture', CHRONICLE_LLM_API_KEY: '', CHRONICLE_LLM_TIMEOUT_MS: '3000' }
    for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value }
    initDb()
  })
  test.afterEach(() => { globalThis.fetch = originalFetch })
  test.afterAll(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    closeDb()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  function fixture(name: string) {
    const area = createArea({ name: `${name} area` })
    const milestone = createMilestone({ areaId: area.id, name })
    const task = createTask({ title: `${name} task`, type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
    createTaskEntry(task.id, '<p>We validated the recovery procedure against an actual failure.</p>')
    return { targetType: 'milestone' as const, targetId: milestone.id }
  }
  const reply = (request: any) => {
    const payload = JSON.parse(request.messages[1].content)
    const fragment = payload.fragments.find((item: any) => item.sourceId.startsWith('entry:')) || payload.fragments[0]
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ observations: [{ text: 'The recorded exercise provides evidence to review.', citations: [{ sourceId: fragment.sourceId, quote: fragment.content.slice(0, 60) }] }], interpretations: [], evidenceGaps: [], reflectionQuestions: ['What would change your conclusion?'], suggestedChecks: [] }) } }] }), { status: 200 })
  }
  async function finish(id: string) {
    await expect.poll(() => getProjectInsight(id)?.status, { timeout: 5000, intervals: [5, 10, 20] }).not.toBe('running')
    return getProjectInsight(id)!
  }

  test('new English review templates and tags are localized without changing existing notes or legacy defaults', async () => {
    const scope = fixture('Locale review')
    const old = createProjectReview({ ...scope, kind: 'periodic' })
    const oldNote = getNoteById(old.noteId)!
    expect(oldNote.title).toContain('阶段回顾')
    expect(oldNote.tags).toContain('复盘')
    const response = await projectRoutes.request('/project-reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, kind: 'periodic', locale: 'en' }) })
    expect(response.status).toBe(201)
    const review = await response.json()
    const note = getNoteById(review.noteId)!
    expect(note.title).toContain('Periodic review')
    expect(note.contentHtml).toContain('What changed')
    expect(note.contentHtml).not.toMatch(/[\u4e00-\u9fff]/)
    expect(note.tags).toEqual(['Review'])
    const existing = createNote({ title: 'My reflection', contentHtml: '<p>保留我的原文。</p>', tags: ['个人'] })
    createProjectReview({ ...scope, kind: 'periodic', locale: 'en', noteId: existing.id, title: 'Ignored replacement', contentHtml: '<p>Ignored replacement</p>' })
    expect(getNoteById(existing.id)?.contentHtml).toBe(existing.contentHtml)
    expect(getNoteById(existing.id)?.tags).toEqual(existing.tags)
    expect(getNoteById(old.noteId)).toEqual(oldNote)
    const invalid = await projectRoutes.request('/project-reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, kind: 'periodic', locale: 'invalid' }) })
    expect(invalid.status).toBe(400)
  })

  test('generation locale is persisted, separates concurrent drafts, controls prompts, and survives retry and adoption', async () => {
    const scope = fixture('Locale insight')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const prompts: string[] = []
    globalThis.fetch = (async (_url, init) => { const request = JSON.parse(String(init?.body)); prompts.push(request.messages[0].content); await gate; return reply(request) }) as typeof fetch
    const english = createProjectInsight({ ...scope, locale: 'en' })
    const same = createProjectInsight({ ...scope, locale: 'en' })
    const chinese = createProjectInsight({ ...scope, locale: 'zh-CN' })
    expect(same.id).toBe(english.id)
    expect(chinese.id).not.toBe(english.id)
    const keys = getDb().prepare('SELECT request_key FROM project_insight_drafts WHERE id IN (?,?)').all(english.id, chinese.id) as Array<{ request_key: string }>
    expect(new Set(keys.map(row => row.request_key)).size).toBe(2)
    release()
    const success = await finish(english.id)
    expect((await finish(chinese.id)).status).toBe('success')
    expect(success.locale).toBe('en')
    expect(success.evidence.analysis?.locale).toBe('en')
    expect(prompts.some(prompt => prompt.includes('Reply in English'))).toBe(true)
    expect(prompts.some(prompt => prompt.includes('Reply in Chinese'))).toBe(true)
    expect((getDb().prepare('SELECT title FROM background_tasks WHERE id = ?').get(success.backgroundTaskId) as { title: string }).title).toContain('Review draft')
    const retry = retryProjectInsight(success.id)!
    expect(retry.locale).toBe('en')
    expect(retry.previousDraftId).toBe(success.id)
    const retried = await finish(retry.id)
    const adopted = acceptProjectInsight(retried.id, {})!
    expect(adopted.note.title).toContain('Review draft')
    expect(adopted.note.contentHtml).toContain('AI review draft')
    expect(adopted.note.contentHtml).toContain('Source: ')
    expect(adopted.note.contentHtml).not.toMatch(/[\u4e00-\u9fff]/)
    expect(adopted.note.tags).toEqual(['Review', 'AI draft'])
    const persistedNote = getNoteById(adopted.note.id)!
    expect(acceptProjectInsight(retried.id, {})!.note).toEqual(persistedNote)
    // Wrapping a draft never translates or strips the user's or model's actual text.
    const userText = '我核对后保留的认识。<script>keep as text</script>'
    const content = { ...retried.content!, reflectionQuestions: [userText] }
    const rendered = projectInsightToHtml({ ...retried, content })
    expect(rendered).toContain('我核对后保留的认识。&lt;script&gt;keep as text&lt;/script&gt;')
    // Old snapshots have no analysis.locale and retain the previous Chinese behavior.
    const legacyEvidence = { ...getProjectInsight(chinese.id)!.evidence }
    delete legacyEvidence.analysis!.locale
    getDb().prepare('UPDATE project_insight_drafts SET evidence_json = ? WHERE id = ?').run(JSON.stringify(legacyEvidence), chinese.id)
    expect(getProjectInsight(chinese.id)!.locale).toBe('zh-CN')
    expect(acceptProjectInsight(chinese.id, {})!.note.tags).toEqual(['复盘', 'AI草稿'])
  })

  test('English output budget failures remain English and retry retains the requested generation language', async () => {
    const scope = fixture('Truncated insight')
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), { status: 200 })) as typeof fetch
    const failure = await finish(createProjectInsight({ ...scope, locale: 'en', budget: { maxOutputTokens: 4000 } }).id)
    expect(failure.status).toBe('error')
    expect(failure.error).toContain('Output budget exhausted (4000 tokens)')
    expect(failure.error).not.toMatch(/[\u4e00-\u9fff]/)
    globalThis.fetch = (async (_url, init) => reply(JSON.parse(String(init?.body)))) as typeof fetch
    const success = await finish(retryProjectInsight(failure.id, { budget: { maxOutputTokens: 8000 } })!.id)
    expect(success.locale).toBe('en')
    expect(success.status).toBe('success')
    expect(getProjectInsight(failure.id)!.status).toBe('error')
    expect(() => createProjectInsight({ ...scope, locale: 'invalid' as any })).toThrow('Invalid project locale')
    expect(() => retryProjectInsight(success.id, { locale: 'invalid' as any })).toThrow('Invalid project locale')
  })
})
