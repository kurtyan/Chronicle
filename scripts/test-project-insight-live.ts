/**
 * Explicitly opt-in, synthetic-data smoke test. Never part of the default suite.
 * Run: ./scripts/with-node.sh node --require ./server/node_modules/tsx/dist/cjs/index.cjs scripts/test-project-insight-live.ts --run --output-tokens 8000
 * Offline runner verification: replace --run with --self-test.
 * --diagnostics retains only synthetic assistant output, input fragments, and
 * deterministic metrics in a separate temporary JSON file on failure.
 * The current provider configuration is read before installing isolated paths;
 * credentials remain in memory and are never serialized or printed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { initDb, getDb, closeDb } from '../server/src/db'
import { getLlmSettings } from '../server/src/services/llmService'
import { createArea, createMilestone, updateMilestone, getMilestoneDetail } from '../server/src/services/projectService'
import { createTask, createTaskEntry, updateTask } from '../server/src/services/taskService'
import { createNote, getNoteById, updateNote } from '../server/src/services/noteService'
import { addProjectReference } from '../server/src/services/projectReferenceService'
import { createProjectInsight, getProjectInsight, cancelProjectInsight, acceptProjectInsight, validateProjectInsightOutput } from '../server/src/services/projectInsightService'
import { createProjectReview, confirmProjectReview, getProjectReview } from '../server/src/services/projectReviewService'

const args = new Set(process.argv.slice(2))
const fixture = args.has('--self-test')
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function main() {
  if (!args.has('--run') && !fixture) {
    console.log('Opt-in only. Pass --run to use the configured LLM with synthetic data, or --self-test for an offline fixture. Optional: --output-tokens 256..16000 (default 4000), --diagnostics. Each invocation makes at most one model call.')
    return
  }
  const outputTokenIndex = process.argv.indexOf('--output-tokens')
  const outputTokens = outputTokenIndex === -1 ? 4000 : Number(process.argv[outputTokenIndex + 1])
  assert.ok(Number.isInteger(outputTokens) && outputTokens >= 256 && outputTokens <= 16000, '--output-tokens must be an integer between 256 and 16000')
  assert.ok(!args.has('--invalid-numeric-fixture') || fixture, '--invalid-numeric-fixture is only available with --self-test')
  const configured = fixture ? { baseUrl: 'https://example.invalid/v1', model: 'project-insight-fixture', apiKey: '', timeoutMs: 3000 } : getLlmSettings()
  assert.ok(configured.baseUrl.trim() && configured.model.trim(), 'An LLM provider and model must already be configured')
  const endpoint = new URL(configured.baseUrl)
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search, 'Use separate provider credentials; embedded URL credentials cannot be persisted in test call logs')
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-insight-live-'))
  const environment = {
    CHRONICLE_CONFIG_DIR: path.join(temporaryDirectory, 'config'),
    CHRONICLE_CONFIG_PATH: path.join(temporaryDirectory, 'config', 'config.json'),
    CHRONICLE_DB_PATH: path.join(temporaryDirectory, 'tasks.db'),
    CHRONICLE_LOG_PATH: path.join(temporaryDirectory, 'server.log'),
    CHRONICLE_ATTACHMENT_DIR: path.join(temporaryDirectory, 'attachments'),
    CHRONICLE_LLM_BASE_URL: configured.baseUrl,
    CHRONICLE_LLM_MODEL: configured.model,
    CHRONICLE_LLM_API_KEY: configured.apiKey,
    CHRONICLE_LLM_TIMEOUT_MS: String(Math.min(Math.max(configured.timeoutMs, 1000), 120000)),
  }
  const savedEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  let draftId: string | undefined
  let initialized = false
  try {
    Object.assign(process.env, environment)
    if (fixture) globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const payload = JSON.parse(request.messages[1].content)
      const fragment = payload.fragments.find((item: any) => item.sourceId.startsWith('entry:'))
      const result = {
        observations: [{ text: args.has('--invalid-numeric-fixture') ? '记录中验证了99个案例。' : '记录展示了从初始猜测到验证结论的转变。', citations: [{ sourceId: fragment.sourceId, quote: fragment.content.slice(0, 60) }] }],
        interpretations: [], evidenceGaps: ['还需要更多独立案例检验适用边界。'], reflectionQuestions: ['哪项判断最值得保留？'], suggestedChecks: [],
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 })
    }) as typeof fetch
    initDb(); initialized = true
    const area = createArea({ name: '合成测试：系统可靠性', description: '仅用于自动化验证的虚构工作，不代表用户实际项目。' })
    const growth = createArea({ name: '合成测试：职业成长' })
    const milestone = createMilestone({ areaId: area.id, name: '合成测试：定位重复请求原因', kind: 'stage', status: 'active', goal: '通过可复现证据区分网络问题与缓存键问题。', completionCriteria: '能够复现问题、验证修正，并记录适用边界。' })
    const task = createTask({ title: '合成测试：验证缓存键假设', type: 'TODO', priority: 'MEDIUM', primaryMilestoneId: milestone.id })
    createTaskEntry(task.id, '<p>起初怀疑网络超时触发重试，但尚无能够区分原因的证据。决定先固定输入并记录请求标识。</p>')
    createTaskEntry(task.id, '<p>对照实验中网络条件保持不变；只有缺少租户标识的缓存键出现重复结果。加入租户标识后，同一案例无法再复现。</p>')
    createTaskEntry(task.id, '<p>结论只在合成测试案例中成立，尚未覆盖不同租户并发与缓存失效场景。复用前需补充这些边界验证。</p>')
    updateTask(task.id, { status: 'DONE' })
    const originalNote = createNote({ title: '合成测试：可复用判断方法', contentHtml: '<p>先固定输入、列出可区分的假设，再进行对照验证。一次案例成功不能证明所有场景都适用。</p>' })
    addProjectReference('note', originalNote.id, { targetType: 'milestone', targetId: milestone.id, role: 'outcome' })
    addProjectReference('note', originalNote.id, { targetType: 'area', targetId: growth.id, role: 'growth' })
    const completed = updateMilestone(milestone.id, { expectedRevision: milestone.revision, status: 'completed', confirmCompletion: true })
    const now = Date.now()
    getDb().prepare('INSERT INTO work_sessions(id,task_id,started_at,ended_at) VALUES(?,?,?,?)').run(randomUUID(), task.id, now - 3600000, now - 1800000)
    const started = Date.now()
    const draft = createProjectInsight({ targetType: 'milestone', targetId: milestone.id, periodStart: now - 86400000, budget: { inputCharacters: 12000, maxCalls: 1, maxOutputTokens: outputTokens } })
    draftId = draft.id
    const deadline = started + Number(environment.CHRONICLE_LLM_TIMEOUT_MS) + 10000
    while (getProjectInsight(draft.id)?.status === 'running' && Date.now() < deadline) await delay(100)
    const result = getProjectInsight(draft.id)!
    if (result.status === 'running') { cancelProjectInsight(draft.id); throw new Error('Smoke test exceeded its bounded deadline') }
    if (result.status !== 'success') {
      const calls = getDb().prepare("SELECT status,finish_reason,latency_ms,error_message,raw_response FROM llm_call_logs WHERE feature = 'project_insight' ORDER BY created_at").all() as any[]
      const classify = (message: string) => /timed out|timeout/i.test(message) ? 'timeout' : /finish_reason is length|truncated|输出预算耗尽/i.test(message) ? 'output_budget_exhausted' : /Invalid insight citation/i.test(message) ? 'invalid_citation' : /unsupported numeric|percentage metrics/i.test(message) ? 'unsupported_numeric_claim' : /LLM request failed \((\d+)\)/.exec(message)?.[0] ?? 'network_or_output_error'
      let diagnosticPath: string | undefined
      if (args.has('--diagnostics')) {
        const redact = (text: string) => [configured.apiKey, configured.baseUrl, endpoint.origin].filter(Boolean).reduce((value, sensitive) => value.replaceAll(sensitive, '[redacted]'), text)
        const sourceById = new Map(result.evidence.sources.map(source => [source.id, source]))
        const diagnostic = {
          assistantOutputs: calls.map(call => redact(call.raw_response ?? '')),
          fragments: (result.evidence.analysis?.batches ?? []).flatMap(batch => batch.fragments.map(fragment => ({
            batch: batch.index, ...fragment, content: redact(fragment.content),
            title: redact(sourceById.get(fragment.sourceId)?.title ?? ''),
            role: sourceById.get(fragment.sourceId)?.role ?? null,
            createdAt: sourceById.get(fragment.sourceId)?.createdAt ?? null,
          }))),
          metrics: result.evidence.metrics,
        }
        const diagnosticDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-insight-diagnostic-'))
        diagnosticPath = path.join(diagnosticDirectory, 'synthetic-output.json')
        fs.writeFileSync(diagnosticPath, JSON.stringify(diagnostic, null, 2), { mode: 0o600 })
      }
      console.log(JSON.stringify({ mode: fixture ? 'offline_fixture' : 'live', model: configured.model, maxOutputTokens: outputTokens, status: result.status, elapsedMs: Date.now() - started, errorCategory: classify(result.error ?? ''), ...(diagnosticPath ? { diagnosticPath } : {}), calls: calls.map(call => ({ status: call.status, finishReason: call.finish_reason, latencyMs: call.latency_ms, responseCharacters: call.raw_response?.length ?? 0, errorCategory: classify(call.error_message ?? '') })) }, null, 2))
      process.exitCode = 1
      return
    }
    assert.ok(result.content, 'Successful draft must contain structured content')
    const fragments = result.evidence.analysis!.batches.flatMap(batch => batch.fragments)
    validateProjectInsightOutput(result.content, fragments, result.evidence.sources)
    assert.equal(result.evidence.metrics.recordedMs, 1800000)
    assert.equal(result.evidence.coverage.complete, true)
    assert.equal(result.stale, false)
    const points = [...result.content.observations, ...result.content.interpretations, ...result.content.suggestedChecks]
    assert.ok(points.length > 0, 'Synthetic evidence should produce at least one cited point')
    const adopted = acceptProjectInsight(draft.id, { title: '合成测试：待个人编辑的复盘' })!
    assert.equal(getNoteById(originalNote.id)!.revision, originalNote.revision)
    assert.equal(getProjectInsight(draft.id)!.stale, false)
    assert.equal(getMilestoneDetail(milestone.id).reviewStatus, 'pending')
    const edited = updateNote(adopted.note.id, { expectedRevision: adopted.note.revision, contentHtml: `${adopted.note.contentHtml}<h2>合成人工补充</h2><p>这是一条用于验证编辑保存的虚构感悟：先辨别证据，再选择方案。</p>` })!
    const review = createProjectReview({ targetType: 'milestone', targetId: milestone.id, kind: 'completion', noteId: edited.id, insightDraftId: draft.id })
    const confirmed = confirmProjectReview(review.id, { expectedNoteRevision: edited.revision })!
    assert.equal(confirmed.completionEventId, completed.completionEventId)
    assert.equal(confirmed.versions![0].evidence.fingerprint, result.evidence.fingerprint)
    assert.ok(confirmed.versions![0].contentHtml.includes('合成人工补充'))
    updateNote(edited.id, { expectedRevision: edited.revision, contentHtml: '<p>确认之后的合成新编辑。</p>' })
    assert.equal(getProjectReview(review.id)!.versions![0].contentHtml, confirmed.versions![0].contentHtml)
    console.log(JSON.stringify({
      mode: fixture ? 'offline_fixture' : 'live', model: configured.model, maxOutputTokens: outputTokens, status: 'success', elapsedMs: Date.now() - started,
      modelCallCount: result.evidence.analysis!.batches.length, sourceCount: result.evidence.coverage.totalSources,
      coverageComplete: result.evidence.coverage.complete, includedCharacters: result.evidence.coverage.includedCharacters,
      observations: result.content.observations.length, interpretations: result.content.interpretations.length,
      citationCount: points.reduce((sum, point) => sum + point.citations.length, 0), deterministicRecordedMs: result.evidence.metrics.recordedMs,
      noteAdoption: 'passed', userEditAndConfirmation: 'passed', immutableVersion: 'passed', falseStaleness: false,
      observationPreview: result.content.observations.slice(0, 2).map(point => point.text),
      evidenceGapPreview: result.content.evidenceGaps.slice(0, 2),
    }, null, 2))
  } finally {
    if (initialized && draftId && getProjectInsight(draftId)?.status === 'running') cancelProjectInsight(draftId)
    // Allow cancellation continuations to settle before closing their isolated DB.
    await delay(100)
    if (initialized) closeDb()
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

void main().catch((error: any) => {
  // Configuration/transport errors may embed provider URLs. Never print them or credentials.
  console.error(JSON.stringify({ status: 'failed', category: error?.code ?? error?.name ?? 'Error', assertion: error?.name === 'AssertionError' ? error.message : 'Live smoke test could not finish; inspect its sanitized status above' }))
  process.exitCode = 1
})
