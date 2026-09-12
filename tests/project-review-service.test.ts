import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, getDb, closeDb } from '../server/src/db'
import { initProjectReviewSchema } from '../server/src/projectReviewSchema'
import { applyAreaInsightSummary, createArea, createMilestone, getArea, getProjectEvents, updateArea, updateMilestone } from '../server/src/services/projectService'
import { createTask, createTaskEntry, updateTask } from '../server/src/services/taskService'
import { createNote, getNoteById, updateNote, deleteNote } from '../server/src/services/noteService'
import { addProjectReference } from '../server/src/services/projectReferenceService'
import { buildReviewEvidence, isReviewEvidenceStale } from '../server/src/services/reviewEvidenceService'
import { createProjectReview, confirmProjectReview, getProjectReview, deleteProjectReview } from '../server/src/services/projectReviewService'
import { createProjectInsight, getProjectInsight, cancelProjectInsight, retryProjectInsight, acceptProjectInsight, validateProjectInsightOutput } from '../server/src/services/projectInsightService'
import { projectRoutes } from '../server/src/projectRoutes'

test.describe('Project review service with isolated SQLite and deterministic model responses', () => {
  test.describe.configure({ mode: 'serial' })
  let tempDir: string
  const originalFetch = globalThis.fetch
  const savedEnvironment: Record<string, string | undefined> = {}

  test.beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-reviews-'))
    const env = { CHRONICLE_CONFIG_DIR: path.join(tempDir, 'config'), CHRONICLE_CONFIG_PATH: path.join(tempDir, 'config', 'config.json'), CHRONICLE_DB_PATH: path.join(tempDir, 'tasks.db'), CHRONICLE_LOG_PATH: path.join(tempDir, 'server.log'), CHRONICLE_LLM_BASE_URL: 'https://example.invalid/v1', CHRONICLE_LLM_MODEL: 'deterministic-review-test', CHRONICLE_LLM_API_KEY: '', CHRONICLE_LLM_TIMEOUT_MS: '3000' }
    for (const [key, value] of Object.entries(env)) { savedEnvironment[key] = process.env[key]; process.env[key] = value }
    initDb()
  })
  test.afterEach(() => { globalThis.fetch = originalFetch })
  test.afterAll(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    closeDb()
    for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function fixture(name: string, kind: 'stage' | 'ongoing' = 'stage') {
    const area = createArea({ name: `${name} Area` })
    const milestone = createMilestone({ areaId: area.id, name, kind, goal: 'Verify a concrete outcome', completionCriteria: 'Evidence reviewed', status: 'active' })
    const task = createTask({ title: `${name} task`, type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
    const entry = createTaskEntry(task.id, '<p>We separated facts from assumptions before choosing a solution.</p>')
    return { area, milestone, task, entry }
  }
  function providerReply(body: string) {
    const request = JSON.parse(body), evidence = JSON.parse(request.messages[1].content)
    const fragment = evidence.fragments.find((item: any) => item.sourceId.startsWith('entry:')) ?? evidence.fragments[0]
    const content = { observations: [{ text: '记录提供了一个可回顾的判断案例。', citations: [{ sourceId: fragment.sourceId, quote: fragment.content.slice(0, 60) }] }], interpretations: [], evidenceGaps: ['是否能复用仍需验证。'], reflectionQuestions: ['当时有哪些认识发生变化？'], suggestedChecks: [] }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }), { status: 200 })
  }
  function fakeProvider() { globalThis.fetch = (async (_url, init) => providerReply(String(init?.body))) as typeof fetch }
  async function finish(id: string) {
    await expect.poll(() => getProjectInsight(id)?.status, { timeout: 5000, intervals: [5, 10, 20] }).not.toBe('running')
    return getProjectInsight(id)!
  }

  test('confirms Note revisions as immutable evidence snapshots independent from milestone completion', () => {
    const { milestone, entry } = fixture('Stage review')
    const review = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'completion', contentHtml: '<p>My own reflection.</p>' })
    expect(() => confirmProjectReview(review.id, { expectedNoteRevision: review.noteRevision! })).toThrow('Complete or terminate')
    const completed = updateMilestone(milestone.id, { status: 'completed', expectedRevision: milestone.revision, confirmCompletion: true })
    const confirmed = confirmProjectReview(review.id, { expectedNoteRevision: review.noteRevision! })!
    expect(confirmed.completionEventId).toBe(completed.completionEventId)
    expect(confirmed.versions![0].contentHtml).toBe('<p>My own reflection.</p>')
    expect(confirmed.versions![0].evidence.sources.some(source => source.entityId === entry.id && source.content.includes('facts from assumptions'))).toBeTruthy()
    updateNote(review.noteId, { contentHtml: '<p>Edited later.</p>', expectedRevision: review.noteRevision! })
    expect(getProjectReview(review.id)!.noteChangedSinceConfirmation).toBeTruthy()
    expect(() => confirmProjectReview(review.id, { expectedNoteRevision: review.noteRevision! })).toThrow('NOTE_REVISION_CONFLICT')
    expect(getProjectReview(review.id)!.versions![0].contentHtml).toBe('<p>My own reflection.</p>')
    expect(() => deleteProjectReview(review.id)).toThrow('cannot be deleted')
    deleteNote(review.noteId)
    expect(getProjectReview(review.id)!.versions![0].contentHtml).toBe('<p>My own reflection.</p>')
  })

  test('ongoing work permits repeated periodic reviews and does not need an LLM', () => {
    const { milestone } = fixture('Ongoing learning', 'ongoing')
    const first = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'periodic' })
    const second = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'periodic' })
    expect(first.id).not.toBe(second.id)
    const confirmed = confirmProjectReview(first.id, { expectedNoteRevision: first.noteRevision! })!
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.completionEventId).toBeNull()
    expect(() => createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'completion' })).toThrow('stage milestone')
  })

  test('Area insight summaries require explicit adoption and matching Note/Area revisions while retaining source history', async () => {
    const { area, milestone } = fixture('Area summary')
    fakeProvider()
    const draft = await finish(createProjectInsight({ targetType: 'area', targetId: area.id }).id)
    const input = { insightDraftId: draft.id, expectedRevision: area.revision, expectedNoteRevision: 1, latestProgress: '已梳理判断依据。', nextStep: '用新案例检验。' }
    expect(() => applyAreaInsightSummary(area.id, input)).toThrow(/Accept/)
    const adopted = acceptProjectInsight(draft.id, {})!
    expect(getArea(area.id)?.summaryUpdatedAt).toBeNull()
    expect(acceptProjectInsight(draft.id, {})!.note.id).toBe(adopted.note.id)
    const wrongArea = createArea({ name: 'Other Area' })
    expect(() => applyAreaInsightSummary(wrongArea.id, input)).toThrow(/match/)
    expect(() => applyAreaInsightSummary(area.id, { ...input, expectedRevision: 999 })).toThrow(/changed/)
    const editedNote = updateNote(adopted.note.id, { expectedRevision: adopted.note.revision, contentHtml: `${adopted.note.contentHtml}<p>本人核对后的解释。</p>` })!
    expect(() => applyAreaInsightSummary(area.id, input)).toThrow(/Note changed/)
    const response = await projectRoutes.request(`/areas/${area.id}/summary-from-insight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, expectedNoteRevision: editedNote.revision }) })
    expect(response.status).toBe(200)
    const summary = await response.json()
    expect(summary).toMatchObject({ latestProgress: input.latestProgress, nextStep: input.nextStep, summarySource: 'insight', summarySourceNoteId: adopted.note.id, summarySourceInsightId: draft.id, summarySourceNoteRevision: editedNote.revision, revision: area.revision + 1 })
    expect(getNoteById(adopted.note.id)).toEqual(editedNote)
    expect(getProjectEvents('area', area.id)[0]).toMatchObject({ kind: 'summary_applied', after: { summarySourceInsightId: draft.id } })
    const unchanged = updateArea(area.id, { expectedRevision: summary.revision, name: 'Renamed direction' })
    expect(unchanged).toMatchObject({ summarySource: 'insight', summaryUpdatedAt: summary.summaryUpdatedAt, summarySourceNoteId: adopted.note.id })
    const manual = updateArea(area.id, { expectedRevision: unchanged.revision, nextStep: '手工重新判断下一步。' })
    expect(manual).toMatchObject({ summarySource: 'manual', summarySourceNoteId: null, summarySourceInsightId: null, summarySourceNoteRevision: null })
    const milestoneDraft = await finish(createProjectInsight({ targetType: 'milestone', targetId: milestone.id }).id)
    acceptProjectInsight(milestoneDraft.id, {})
    expect(() => applyAreaInsightSummary(area.id, { ...input, expectedRevision: manual.revision, insightDraftId: milestoneDraft.id })).toThrow(/match/)
    deleteNote(adopted.note.id)
    expect(() => applyAreaInsightSummary(area.id, { ...input, expectedRevision: manual.revision, expectedNoteRevision: editedNote.revision })).toThrow(/deleted/)
    expect(getArea(area.id)).toEqual(manual)
  })

  test('full-range evidence keeps old logs, deterministic primary effort, cross-target growth references, and actual source versions', () => {
    const { area, milestone, task } = fixture('Evidence')
    const oldTime = Date.now() - 100000
    for (let index = 0; index < 24; index++) {
      const entry = createTaskEntry(task.id, `<p>Historical decision ${index}</p>`)
      getDb().prepare('UPDATE task_entries SET created_at = ? WHERE id = ?').run(oldTime + index, entry.id)
    }
    getDb().prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run('evidence-session', task.id, oldTime, oldTime + 10000)
    const growth = createArea({ name: 'Career growth evidence' })
    const note = createNote({ title: 'Reusable method', contentHtml: '<p>Validate assumptions against evidence.</p>' })
    addProjectReference('note', note.id, { targetType: 'milestone', targetId: milestone.id, role: 'outcome' })
    addProjectReference('note', note.id, { targetType: 'area', targetId: growth.id, role: 'growth' })
    const pack = buildReviewEvidence({ targetType: 'area', targetId: area.id })
    expect(pack.sources.filter(source => source.kind === 'task_entry').length).toBe(25)
    expect(pack.sources.some(source => source.content === 'Historical decision 0')).toBeTruthy()
    expect(pack.metrics.recordedMs).toBe(10000)
    const growthPack = buildReviewEvidence({ targetType: 'area', targetId: growth.id })
    expect(growthPack.metrics.recordedMs).toBe(0)
    expect(growthPack.sources.some(source => source.entityId === note.id && source.role === 'growth')).toBeTruthy()
    expect(isReviewEvidenceStale(pack).stale).toBeFalsy()
    updateNote(note.id, { contentHtml: '<p>Revised conclusion</p>', expectedRevision: note.revision })
    expect(isReviewEvidenceStale(pack).stale).toBeTruthy()
    expect(pack.sources.find(source => source.entityId === note.id)!.contentHtml).toContain('Validate assumptions')
  })

  test('AI deduplicates concurrent requests, validates original citations and appends with revision protection', async () => {
    const { milestone } = fixture('AI lifecycle')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    globalThis.fetch = (async (_url, init) => { calls++; await gate; return providerReply(String(init?.body)) }) as typeof fetch
    const draft = createProjectInsight({ targetType: 'milestone', targetId: milestone.id })
    const duplicate = createProjectInsight({ targetType: 'milestone', targetId: milestone.id })
    expect(duplicate.id).toBe(draft.id)
    release()
    const success = await finish(draft.id)
    expect(success.status).toBe('success'); expect(calls).toBe(1)
    expect(success.content!.observations[0].citations[0].sourceId).toContain('entry:')
    const note = createNote({ title: 'Existing personal thoughts', contentHtml: '<p>Keep my original writing.</p>' })
    updateNote(note.id, { contentHtml: '<p>Keep my newer writing.</p>', expectedRevision: note.revision })
    expect(() => acceptProjectInsight(draft.id, { noteId: note.id, expectedNoteRevision: note.revision })).toThrow('NOTE_REVISION_CONFLICT')
    const result = acceptProjectInsight(draft.id, { noteId: note.id, expectedNoteRevision: note.revision + 1 })!
    expect(result.note.contentHtml).toContain('Keep my newer writing.')
    expect(result.note.contentHtml).toContain('LLM 复盘草稿')
    const acceptedAgain = acceptProjectInsight(draft.id, { noteId: note.id, expectedNoteRevision: result.note.revision })!
    expect(acceptedAgain.note.revision).toBe(result.note.revision)
    expect(getDb().prepare('SELECT id FROM project_reviews WHERE note_id = ?').get(note.id)).toBeUndefined()
    expect(getProjectInsight(draft.id)!.stale).toBeFalsy()
    const review = createProjectReview({ targetType: 'milestone', targetId: milestone.id, noteId: note.id, kind: 'periodic', insightDraftId: draft.id })
    expect(getProjectInsight(draft.id)!.stale).toBeFalsy()
    expect(confirmProjectReview(review.id, { expectedNoteRevision: result.note.revision })!.status).toBe('confirmed')
  })

  test('rejects nonexistent citations and invented statistics', () => {
    const output = { observations: [{ text: 'A claim', citations: [{ sourceId: 'entry:missing', quote: 'fact' }] }], interpretations: [], evidenceGaps: [], reflectionQuestions: [], suggestedChecks: [] }
    expect(() => validateProjectInsightOutput(output, [{ sourceId: 'entry:real', content: 'fact' }])).toThrow('Invalid insight citation')
    output.observations[0] = { text: 'Improved 50%', citations: [{ sourceId: 'entry:real', quote: 'fact' }] }
    expect(() => validateProjectInsightOutput(output, [{ sourceId: 'entry:real', content: 'fact' }])).toThrow('numeric claim')
  })

  test('completion events remain exactly quotable after transport and cited task IDs are not counted as numeric claims', async () => {
    const { milestone, task } = fixture('Readable event evidence')
    updateTask(task.id, { status: 'DONE' })
    const completed = updateMilestone(milestone.id, { expectedRevision: milestone.revision, status: 'completed', confirmCompletion: true })
    const evidence = buildReviewEvidence({ targetType: 'milestone', targetId: milestone.id })
    const event = evidence.sources.find(source => source.entityId === completed.completionEventId)!
    // Regression from a real synthetic model response: the model quoted this
    // decoded text, while nested JSON strings previously required extra slashes.
    const completionQuote = '"status":"completed"'
    expect(event.content).toContain(completionQuote)
    expect(JSON.parse(event.content).before_json.status).toBe('active')
    expect(JSON.parse(event.content).after_json.status).toBe('completed')
    expect(typeof (getDb().prepare('SELECT after_json FROM project_events WHERE id = ?').get(completed.completionEventId) as any).after_json).toBe('string')
    expect(isReviewEvidenceStale(evidence).stale).toBeFalsy()
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.messages[1].content)
      const suppliedEvent = payload.fragments.find((fragment: any) => fragment.sourceId === event.id)
      expect(suppliedEvent.content).toContain(completionQuote)
      const result = {
        observations: [
          { text: '里程碑记录包含完成事件。', citations: [{ sourceId: event.id, quote: completionQuote }] },
          { text: `任务 ${task.id} 的当前状态标记为 DONE。`, citations: [{ sourceId: `task:${task.id}`, quote: 'DONE' }] },
        ],
        interpretations: [], evidenceGaps: [], reflectionQuestions: [], suggestedChecks: [],
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 })
    }) as typeof fetch
    const result = await finish(createProjectInsight({ targetType: 'milestone', targetId: milestone.id }).id)
    expect(result.status, result.error ?? '').toBe('success')
    expect(result.promptVersion).toBe('project-review-evidence-v2')
    expect(result.content!.observations[0].citations[0].quote).toBe(completionQuote)
    expect(result.content!.observations[1].text).toContain(task.id)
  })

  test('only the complete cited source entity ID is exempt from numerical claims, while exact quotes and metrics remain guarded', () => {
    const taskId = 'T0000000001', sourceId = `task:${taskId}`
    const fragments = [{ sourceId, content: JSON.stringify({ id: taskId, status: 'DONE', otherTaskId: 'T0000000002', recordedMinutes: 30, progress: '50%' }) }]
    const sources = [{ id: sourceId, entityId: taskId }, { id: 'task:T0000000003', entityId: 'T0000000003' }]
    const output = (text: string, quote = 'DONE') => ({ observations: [{ text, citations: [{ sourceId, quote }] }], interpretations: [], evidenceGaps: [], reflectionQuestions: [], suggestedChecks: [] })
    expect(() => validateProjectInsightOutput(output(`任务 ${taskId} 当前标记为 DONE。`), fragments, sources)).not.toThrow()
    expect(() => validateProjectInsightOutput(output(`任务 ${taskId} 当前标记为 DONE。`), fragments)).toThrow('numeric claim')
    for (const text of ['任务 T0000000002 完成。', '任务 T0000000003 完成。', '任务 XT0000000001 完成。', '任务 T00000000011 完成。', '任务 T0000000001suffix 完成。', '完成了 0000000001 个任务。']) {
      expect(() => validateProjectInsightOutput(output(text), fragments, sources)).toThrow('numeric claim')
    }
    expect(() => validateProjectInsightOutput(output(`任务 ${taskId} 完成。`, 'a nonexistent quotation'), fragments, sources)).toThrow('Invalid insight citation')
    expect(() => validateProjectInsightOutput(output(`任务 ${taskId} 投入 30 分钟。`, '"recordedMinutes":30'), fragments, sources)).toThrow('time and percentage metrics')
    expect(() => validateProjectInsightOutput(output(`任务 ${taskId} 已完成 50%。`, '50%'), fragments, sources)).toThrow('time and percentage metrics')
  })

  test('budget limitations are explicit while full original evidence persists', async () => {
    const { milestone, task } = fixture('Budget')
    const entry = createTaskEntry(task.id, `<p>${'A complete long investigation. '.repeat(6000)}</p>`)
    fakeProvider()
    const draft = createProjectInsight({ targetType: 'milestone', targetId: milestone.id, budget: { inputCharacters: 1000, maxCalls: 1 } })
    const success = await finish(draft.id)
    expect(success.status).toBe('success')
    expect(success.evidence.coverage.complete).toBeFalsy()
    expect(success.evidence.coverage.includedCharacters).toBeLessThanOrEqual(1000)
    expect(success.evidence.sources.find(source => source.entityId === entry.id)!.content.length).toBeGreaterThan(100000)
    expect(success.evidence.analysis!.batches[0].status).toBe('success')
    expect(success.evidence.analysis!.batches[0].fragments.reduce((sum, fragment) => sum + fragment.content.length, 0)).toBeLessThanOrEqual(1000)
  })

  test('stale AI reviews require acknowledgement and retain the exact original analysis packet', async () => {
    const { milestone, entry } = fixture('Stale periodic', 'ongoing')
    fakeProvider()
    const success = await finish(createProjectInsight({ targetType: 'milestone', targetId: milestone.id }).id)
    getDb().prepare('UPDATE task_entries SET content = ? WHERE id = ?').run('<p>Corrected source after generation.</p>', entry.id)
    expect(getProjectInsight(success.id)!.stale).toBeTruthy()
    const review = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'periodic', insightDraftId: success.id, contentHtml: '<p>I checked this historical evidence.</p>' })
    expect(() => confirmProjectReview(review.id, { expectedNoteRevision: review.noteRevision! })).toThrow('STALE_REVIEW_EVIDENCE')
    const confirmed = confirmProjectReview(review.id, { expectedNoteRevision: review.noteRevision!, acknowledgeStaleEvidence: true })!
    expect(confirmed.versions![0].evidence.fingerprint).toBe(success.evidence.fingerprint)
    expect(confirmed.versions![0].evidence.analysis).toEqual(success.evidence.analysis)
    expect(confirmed.versions![0].evidence.sources.find(source => source.entityId === entry.id)!.content).toContain('facts from assumptions')
  })

  test('cancelled stage milestones can preserve lessons without being marked completed', () => {
    const { milestone } = fixture('Cancelled learning')
    updateMilestone(milestone.id, { expectedRevision: milestone.revision, status: 'cancelled' })
    const review = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'completion' })
    const confirmed = confirmProjectReview(review.id, { expectedNoteRevision: review.noteRevision! })!
    expect(confirmed.completionEventId).toBeTruthy()
    expect(confirmed.versions![0].evidence.target.status).toBe('cancelled')
  })

  test('HTTP adoption, review creation and repeated confirmation stay fresh and idempotent', async () => {
    const { milestone } = fixture('HTTP adoption', 'ongoing')
    fakeProvider()
    const request = (url: string, body: unknown) => projectRoutes.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const generatedResponse = await request('/project-insights', { targetType: 'milestone', targetId: milestone.id })
    expect(generatedResponse.status).toBe(202)
    const draft = await finish((await generatedResponse.json()).id)
    const adoptedResponse = await request(`/project-insights/${draft.id}/accept`, {})
    expect(adoptedResponse.status).toBe(200)
    const adopted = await adoptedResponse.json()
    const reviewInput = { targetType: 'milestone', targetId: milestone.id, kind: 'periodic', noteId: adopted.note.id, insightDraftId: draft.id }
    const review = await (await request('/project-reviews', reviewInput)).json()
    const repeatedCreate = await (await request('/project-reviews', reviewInput)).json()
    expect(repeatedCreate.id).toBe(review.id)
    expect((await (await projectRoutes.request(`/project-insights/${draft.id}`)).json()).stale).toBeFalsy()
    const confirmed = await request(`/project-reviews/${review.id}/confirm`, { expectedNoteRevision: adopted.note.revision })
    expect(confirmed.status).toBe(200)
    const repeatedConfirmation = await request(`/project-reviews/${review.id}/confirm`, { expectedNoteRevision: adopted.note.revision })
    expect((await repeatedConfirmation.json()).versions).toHaveLength(1)
    const manual = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'periodic' })
    confirmProjectReview(manual.id, { expectedNoteRevision: manual.noteRevision! })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(confirmProjectReview(manual.id, { expectedNoteRevision: manual.noteRevision! })!.versions).toHaveLength(1)
    expect((await request('/project-reviews', { targetType: 'milestone', targetId: milestone.id, kind: 'completion' })).status).toBe(400)
    const pending = createProjectInsight({ targetType: 'milestone', targetId: milestone.id })
    cancelProjectInsight(pending.id)
    expect((await request(`/project-insights/${pending.id}/accept`, {})).status).toBe(409)
  })

  test('a truncated generation reports its output budget and retry can increase that budget without replacing old results', async () => {
    const { milestone } = fixture('Output budget recovery')
    const requestedBudgets: number[] = []
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      requestedBudgets.push(request.max_tokens)
      return request.max_tokens < 8000
        ? new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), { status: 200 })
        : providerReply(String(init?.body))
    }) as typeof fetch
    const failed = await finish(createProjectInsight({ targetType: 'milestone', targetId: milestone.id, budget: { maxOutputTokens: 4000 } }).id)
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('输出预算耗尽')
    expect(failed.error).toContain('4000 tokens')
    expect(failed.content).toBeNull()
    expect(() => retryProjectInsight(failed.id, { budget: { maxOutputTokens: 16001 } })).toThrow('Invalid insight budget')
    const retry = retryProjectInsight(failed.id, { budget: { maxOutputTokens: 8000 } })!
    expect(retry.id).not.toBe(failed.id)
    expect(retry.previousDraftId).toBe(failed.id)
    expect(retry.budget.inputCharacters).toBe(failed.budget.inputCharacters)
    const recovered = await finish(retry.id)
    expect(recovered.status).toBe('success')
    expect(requestedBudgets).toEqual([4000, 8000])
    expect(getProjectInsight(failed.id)!.status).toBe('error')
    expect(getProjectInsight(failed.id)!.budget.maxOutputTokens).toBe(4000)
  })

  test('cancellation discards late writes, retry creates a new draft, failures preserve prior successes, and restart retains evidence', async () => {
    const { milestone } = fixture('Recovery')
    let release!: () => void
    globalThis.fetch = (async (_url, init) => { await new Promise<void>(resolve => { release = resolve }); return providerReply(String(init?.body)) }) as typeof fetch
    const draft = createProjectInsight({ targetType: 'milestone', targetId: milestone.id })
    await expect.poll(() => Boolean(release), { intervals: [5, 10] }).toBeTruthy()
    expect(cancelProjectInsight(draft.id)!.status).toBe('cancelled')
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(getProjectInsight(draft.id)!.status).toBe('cancelled')
    fakeProvider()
    const retry = retryProjectInsight(draft.id)!
    expect(retry.id).not.toBe(draft.id); expect(retry.previousDraftId).toBe(draft.id)
    const success = await finish(retry.id)
    expect(success.status).toBe('success')
    globalThis.fetch = (async () => new Response('Unavailable', { status: 503 })) as typeof fetch
    const failure = await finish(retryProjectInsight(success.id)!.id)
    expect(failure.status).toBe('error')
    expect(getProjectInsight(success.id)!.content).toEqual(success.content)
    getDb().prepare("UPDATE project_insight_drafts SET status = 'running' WHERE id = ?").run(failure.id)
    initProjectReviewSchema(getDb())
    expect(getProjectInsight(failure.id)!.error).toContain('server restart')
    expect(getProjectInsight(failure.id)!.evidence.sources.length).toBeGreaterThan(0)
    expect(getProjectInsight(success.id)!.status).toBe('success')
    expect(getNoteById('nonexistent')).toBeNull()
  })
})
