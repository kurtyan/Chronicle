import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeDb, getDb, initDb } from '../server/src/db'
import { exportDatabase, importDatabase } from '../server/src/services/settingsService'
import { createArea, createMilestone, getMilestone } from '../server/src/services/projectService'
import { createTask, createTaskEntry, getTaskEntries } from '../server/src/services/taskService'
import { createNote, getNoteById, updateNote } from '../server/src/services/noteService'
import { createProjectReview, confirmProjectReview, getProjectReview } from '../server/src/services/projectReviewService'
import { buildReviewEvidence, evidenceFingerprint, isReviewEvidenceStale } from '../server/src/services/reviewEvidenceService'
import { getProjectInsight } from '../server/src/services/projectInsightService'

test.describe.configure({ mode: 'serial' })
let dir: string
const keys = ['CHRONICLE_DB_PATH', 'CHRONICLE_ATTACHMENT_DIR', 'CHRONICLE_CONFIG_DIR', 'CHRONICLE_CONFIG_PATH', 'CHRONICLE_LOG_PATH']
let original: Record<string, string | undefined>
test.beforeEach(() => {
  original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-backup-'))
  process.env.CHRONICLE_DB_PATH = path.join(dir, 'source.db')
  process.env.CHRONICLE_CONFIG_DIR = dir
  process.env.CHRONICLE_CONFIG_PATH = path.join(dir, 'config.json')
  process.env.CHRONICLE_LOG_PATH = path.join(dir, 'server.log')
  initDb()
})
test.afterEach(() => {
  closeDb()
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
  fs.rmSync(dir, { force: true, recursive: true })
})
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function fixture(attachmentDir: string) {
  process.env.CHRONICLE_ATTACHMENT_DIR = attachmentDir
  fs.mkdirSync(attachmentDir, { recursive: true })
  const filePath = path.join(attachmentDir, 'evidence.txt')
  fs.writeFileSync(filePath, 'Actual attachment bytes')
  const html = `<p>Personal conclusion with source ${escape(filePath)}</p><a href="file://${escape(filePath)}">Evidence</a><img data-fullpath="${escape(filePath)}" src="/api/attachment?path=${encodeURIComponent(filePath)}">`
  const area = createArea({ name: 'Work', description: `Evidence folder ${attachmentDir}` })
  const milestone = createMilestone({ areaId: area.id, name: 'Learning', kind: 'ongoing', goal: `Inspect ${filePath}` })
  const task = createTask({ title: 'Read evidence', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
  const entry = createTaskEntry(task.id, html)
  const note = createNote({ title: 'Keep my conclusion', contentHtml: html })
  const review = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'periodic', noteId: note.id })
  const confirmed = confirmProjectReview(review.id, { expectedNoteRevision: note.revision })!
  const evidence = buildReviewEvidence({ targetType: 'milestone', targetId: milestone.id })
  const content = { observations: [{ text: `Evidence is at ${filePath}`, citations: [{ sourceId: `entry:${entry.id}`, quote: evidence.sources.find(s => s.entityId === entry.id)!.content }] }], interpretations: [], evidenceGaps: [], reflectionQuestions: ['What changed?'], suggestedChecks: [] }
  const budget = { inputCharacters: 96000, maxCalls: 6, maxOutputTokens: 4000 }, promptVersion = 'project-review-evidence-v1', model = 'backup-test'
  const requestKey = evidenceFingerprint({ scope: evidence.scope, fingerprint: evidence.fingerprint, model, budget, promptVersion })
  getDb().prepare(`INSERT INTO project_insight_drafts(id,target_type,target_id,period_start,period_end,request_key,status,evidence_json,content_json,model,prompt_version,budget_json,created_at,updated_at,completed_at)
    VALUES('backup-draft','milestone',?,NULL,NULL,?,'success',?,?,?,?,?,?,?,?)`).run(milestone.id, requestKey, JSON.stringify(evidence), JSON.stringify(content), model, promptVersion, JSON.stringify(budget), Date.now(), Date.now(), Date.now())
  const document = { type: 'doc', content: [{ type: 'image', attrs: { fullpath: filePath, src: `file://${filePath}` } }, { type: 'paragraph', content: [{ type: 'text', text: 'Unchanged text with "quotes" and \\slashes' }] }] }
  getDb().prepare('INSERT INTO day_scripts(script_date,document_json,created_at,updated_at) VALUES(?,?,?,?)').run('2026-09-11', JSON.stringify(document), Date.now(), Date.now())
  expect(isReviewEvidenceStale(evidence).stale).toBe(false)
  return { filePath, milestone, task, entry, note, review, confirmed, evidence, content, document, html }
}

for (const quotedSource of [false, true]) {
  test(`bundle restore safely relocates JSON, HTML and evidence hashes from ${quotedSource ? 'quoted' : 'plain'} paths`, async () => {
    const source = path.join(dir, quotedSource ? 'source "quoted"\\folder' : 'source-attachments')
    const data = fixture(source)
    const exported = await exportDatabase()
    const target = path.join(dir, 'destination "quoted"\\folder')
    closeDb()
    process.env.CHRONICLE_DB_PATH = path.join(dir, 'restored.db')
    process.env.CHRONICLE_ATTACHMENT_DIR = target
    initDb()
    await importDatabase(exported.data)
    const restoredPath = path.join(target, 'evidence.txt')
    expect(fs.readFileSync(restoredPath, 'utf8')).toBe('Actual attachment bytes')
    const note = getNoteById(data.note.id)!
    expect(note.revision).toBe(data.note.revision)
    expect(note.contentHtml).toContain(`data-fullpath="${escape(restoredPath)}"`)
    expect(note.contentHtml).toContain(`href="file://${encodeURI(restoredPath)}"`)
    expect(note.contentHtml).toContain(encodeURIComponent(restoredPath))
    expect(getTaskEntries(data.task.id).find(entry => entry.id === data.entry.id)?.content).toBe(note.contentHtml)
    expect(getMilestone(data.milestone.id)?.goal).toBe(`Inspect ${restoredPath}`)
    const document = JSON.parse((getDb().prepare('SELECT document_json FROM day_scripts').get() as any).document_json)
    expect(document.content[0].attrs.fullpath).toBe(restoredPath)
    expect(document.content[0].attrs.src).toBe(`file://${encodeURI(restoredPath)}`)
    expect(document.content[1]).toEqual(data.document.content[1])
    const review = getProjectReview(data.review.id)!, version = review.versions![0]
    expect(version.contentHtml).toBe(note.contentHtml)
    expect(version.noteRevision).toBe(data.note.revision)
    expect(version.evidence.sources.find(s => s.entityId === data.entry.id)?.contentHtml).toBe(note.contentHtml)
    expect(isReviewEvidenceStale(version.evidence).stale).toBe(false)
    const draft = getProjectInsight('backup-draft')!
    expect(draft.stale).toBe(false)
    expect(draft.evidence.fingerprint).not.toBe(data.evidence.fingerprint)
    expect(draft.content!.observations[0].text).toBe(`Evidence is at ${restoredPath}`)
    expect(draft.content!.observations[0].citations[0].quote).toBe(draft.evidence.sources.find(s => s.entityId === data.entry.id)!.content)
    expect(draft.evidence.metrics).toEqual(data.evidence.metrics)
    expect(draft.evidence.window).toEqual(data.evidence.window)
    expect(draft.evidence.scope).toEqual(data.evidence.scope)
    expect(draft.evidence.coverage).toEqual(data.evidence.coverage)
    expect(getDb().pragma('foreign_key_check')).toEqual([])
    updateNote(note.id, { expectedRevision: note.revision, contentHtml: '<p>A genuinely different conclusion</p>' })
    expect(getProjectInsight('backup-draft')!.stale).toBe(true)
    expect(getProjectReview(data.review.id)!.versions![0].contentHtml).toBe(version.contentHtml)
  })
}

test('malformed snapshot JSON rejects before live database or attachments are replaced', async () => {
  const source = path.join(dir, 'source')
  fixture(source)
  getDb().prepare("UPDATE project_insight_drafts SET evidence_json='{invalid json'").run()
  const exported = await exportDatabase()
  closeDb()
  process.env.CHRONICLE_DB_PATH = path.join(dir, 'live.db')
  const target = path.join(dir, 'target "quoted"')
  process.env.CHRONICLE_ATTACHMENT_DIR = target
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'preserve.txt'), 'keep')
  initDb(); const live = createNote({ title: 'Live data must survive' })
  await expect(importDatabase(exported.data)).rejects.toThrow('Invalid backup JSON')
  expect(getNoteById(live.id)?.title).toBe('Live data must survive')
  expect(fs.readFileSync(path.join(target, 'preserve.txt'), 'utf8')).toBe('keep')
  expect(fs.readdirSync(dir).filter(name => name.startsWith('.import-') || name.startsWith('.attachments-import-'))).toEqual([])
})
