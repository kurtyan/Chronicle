import { createHash, randomUUID } from 'crypto'
import { getDb, getMetaValue } from '../db'
import { getDayScript } from './dayScriptService'
import { getAllTasks, getSessionsForRange, getTaskEntries, type Task, type WorkSession } from './taskService'
import {
  callChatCompletionsWithRaw,
  DEFAULT_DAILY_SUMMARY_PROMPT,
  getLlmSettings,
  insertLlmCallLog,
} from './llmService'
import { getTaskContexts } from './taskContextService'

type JsonNode = {
  type?: string
  text?: string
  attrs?: Record<string, any>
  marks?: Array<{ type?: string; attrs?: Record<string, any> }>
  content?: JsonNode[]
}

export interface DailySummaryResult {
  date: string
  summaryMarkdown: string
  cached: boolean
  llmCallLogId: string | null
}

export interface DailySummaryCacheResult extends DailySummaryResult {
  updatedAt: number
  fingerprintStatus: 'fresh' | 'stale'
}

export interface PlanTodayDraftResult {
  date: string
  document: JsonNode
  sources: {
    taskCount: number
    recommendedTaskCount: number
    carriedBlockCount: number
  }
}

interface SessionWithTask extends WorkSession {
  endedAt: number
  taskTitle: string
}

function queryOne(sql: string, params: any[] = []): any | null {
  return getDb().prepare(sql).get(...params)
}

function run(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params)
}

function escapeJson(text: string): string {
  return text.replace(/\u0000/g, '')
}

function stripHtml(content: string): string {
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function localDateAt(date: string, hour: number): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, 0, 0, 0)
}

function addDays(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(year, month - 1, day + offset)
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-')
}

function getStartOfDayOffset(): number {
  const offset = Number(getMetaValue('start_of_day_offset') ?? 5)
  if (!Number.isFinite(offset)) return 5
  return Math.max(0, Math.min(23, Math.trunc(offset)))
}

function workdayRange(date: string): { start: number; end: number } {
  const start = localDateAt(date, getStartOfDayOffset()).getTime()
  return { start, end: start + 24 * 60 * 60 * 1000 }
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`
}

function mergeSessions(sessions: SessionWithTask[]): SessionWithTask[] {
  const result: SessionWithTask[] = []
  for (const session of sessions) {
    const last = result[result.length - 1]
    if (last && last.taskId === session.taskId && session.startedAt - last.endedAt <= 5000) {
      last.endedAt = Math.max(last.endedAt, session.endedAt)
      continue
    }
    result.push({ ...session })
  }
  return result
}

function makeTaskMention(task: Task): JsonNode {
  return {
    type: 'text',
    text: `@${task.title}`,
    marks: [{
      type: 'link',
      attrs: {
        href: `/today?task=${encodeURIComponent(task.id)}`,
        taskId: task.id,
      },
    }],
  }
}

function paragraph(content: Array<JsonNode>): JsonNode {
  return { type: 'paragraph', content }
}

function text(value: string): JsonNode {
  return { type: 'text', text: value }
}

function normalizeDoc(nodes: JsonNode[]): JsonNode {
  return { type: 'doc', content: nodes.length > 0 ? nodes : [paragraph([text('')])] }
}

function carriedBlockHeader(block: { startTime: string; endTime: string; headerText: string; taskIds: string[] }, tasksById: Map<string, Task>): JsonNode[] {
  const prefix = block.startTime && block.endTime ? `${block.startTime}-${block.endTime} ` : ''
  const taskId = block.taskIds[0]
  const task = taskId ? tasksById.get(taskId) : null
  if (!task) return [text(`${prefix}${block.headerText}`)]
  const mention = `@${task.title}`
  const mentionIndex = block.headerText.indexOf(mention)
  const before = mentionIndex >= 0 ? block.headerText.slice(0, mentionIndex).trim() : ''
  const remainder = mentionIndex >= 0
    ? block.headerText.slice(mentionIndex + mention.length).trim()
    : block.headerText.trim()
  return [
    text(`${prefix}${before ? `${before} ` : ''}`),
    makeTaskMention(task),
    ...(remainder ? [text(` ${remainder}`)] : []),
  ]
}

function extractDocText(node: JsonNode | null | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'horizontalRule') return '\n----\n'
  return (node.content ?? []).map(extractDocText).join(node.type === 'paragraph' ? '' : '\n').trim()
}

function buildHourlyBars(sessions: SessionWithTask[], start: number, end: number): string {
  const lines: string[] = []
  for (let hourStart = start; hourStart < end; hourStart += 60 * 60 * 1000) {
    const hourEnd = Math.min(end, hourStart + 60 * 60 * 1000)
    const activeMs = sessions.reduce((sum, session) => {
      const overlapStart = Math.max(hourStart, session.startedAt)
      const overlapEnd = Math.min(hourEnd, session.endedAt)
      return sum + Math.max(0, overlapEnd - overlapStart)
    }, 0)
    const blocks = Math.round(activeMs / (3 * 60 * 1000))
    lines.push(`${formatTime(hourStart)} ${'█'.repeat(blocks)} ${formatDuration(activeMs)}`)
  }
  return lines.join('\n')
}

function getDayScriptSyncedEntryIds(date: string): Set<string> {
  const rows = getDb().prepare(
    `SELECT last_entry_id AS entry_id
     FROM day_script_progress_syncs s
     JOIN day_script_blocks b ON b.id = s.block_id
     WHERE b.script_date = ? AND last_entry_id IS NOT NULL
     UNION
     SELECT progress_entry_id AS entry_id
     FROM day_script_execution_records
     WHERE script_date = ?`
  ).all(date, date) as Array<{ entry_id: string | null }>
  return new Set(rows.map((row) => row.entry_id).filter((id): id is string => Boolean(id)))
}

function isDayScriptProgressEntryForDate(content: string, date: string): boolean {
  return content.includes(`Day Script progress · ${date}`)
}

function buildSummaryInput(date: string): { inputText: string; fingerprintData: unknown; sessionCount: number } {
  const script = getDayScript(date)
  const { start, end } = workdayRange(date)
  const now = Date.now()
  const tasksById = new Map(getAllTasks().map((task) => [task.id, task]))
  const syncedEntryIds = getDayScriptSyncedEntryIds(date)
  const sessions = mergeSessions(getSessionsForRange(start, end)
    .map((session) => ({
      ...session,
      startedAt: Math.max(session.startedAt, start),
      endedAt: Math.min(session.endedAt ?? now, end),
      taskTitle: tasksById.get(session.taskId)?.title ?? session.taskId,
    }))
    .filter((session) => session.endedAt > session.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt))

  const taskIds = [...new Set([
    ...sessions.map((session) => session.taskId),
    ...script.blocks.flatMap((block) => block.taskIds),
  ])]
  const taskDetails = taskIds.map((taskId) => {
    const task = tasksById.get(taskId)
    const entries = getTaskEntries(taskId)
    const todayLogs = entries
      .filter((entry) => entry.createdAt >= start && entry.createdAt < end)
      .filter((entry) => !syncedEntryIds.has(entry.id))
      .filter((entry) => !isDayScriptProgressEntryForDate(entry.content, date))
      .slice(-6)
      .map((entry) => ({
        type: entry.type,
        createdAt: new Date(entry.createdAt).toISOString(),
        content: stripHtml(entry.content),
      }))
    const recentContextBeforeToday = todayLogs.length >= 2
      ? []
      : entries
        .filter((entry) => entry.createdAt < start)
        .filter((entry) => !isDayScriptProgressEntryForDate(entry.content, date))
        .slice(-3)
        .map((entry) => ({
          type: entry.type,
          createdAt: new Date(entry.createdAt).toISOString(),
          content: stripHtml(entry.content),
        }))
    return task ? {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      todayLogs,
      recentContextBeforeToday,
    } : null
  }).filter(Boolean)

  const sessionLines = sessions.length > 0
    ? sessions.map((session) => `${formatTime(session.startedAt)}-${formatTime(session.endedAt)} [${formatDuration(session.endedAt - session.startedAt)}] ${session.taskTitle}`).join('\n')
    : 'No work sessions.'

  const gaps = sessions.slice(1).map((session, index) => {
    const previous = sessions[index]
    const gapMs = session.startedAt - previous.endedAt
    return gapMs >= 60000 ? `${formatTime(previous.endedAt)}-${formatTime(session.startedAt)} [${formatDuration(gapMs)}]` : ''
  }).filter(Boolean).join('\n') || 'No AFK gaps longer than 1 minute.'

  const taskTime = [...sessions.reduce((map, session) => {
    map.set(session.taskId, (map.get(session.taskId) ?? 0) + session.endedAt - session.startedAt)
    return map
  }, new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([taskId, ms]) => `${tasksById.get(taskId)?.title ?? taskId}: ${formatDuration(ms)}`)
    .join('\n') || 'No task time.'

  const activeMs = sessions.reduce((sum, session) => sum + Math.max(0, session.endedAt - session.startedAt), 0)
  const spanMs = sessions.length > 0 ? sessions[sessions.length - 1].endedAt - sessions[0].startedAt : 0
  const focusRatio = spanMs > 0 ? Math.round(activeMs / spanMs * 100) : 0

  const focusBlocks = script.blocks.map((block) => [
    `${block.startTime}-${block.endTime} ${block.headerText}${block.completed ? ' ✅' : ''}`,
    block.progressText ? `Progress: ${block.progressText}` : '',
  ].filter(Boolean).join('\n')).join('\n\n') || extractDocText(script.document) || 'No focus content.'

  const input = {
    date,
    workday: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    sessions,
    focusBlocks: script.blocks,
    document: script.document,
    taskDetails,
  }

  const inputText = [
    `Date: ${date}`,
    `Workday: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`,
    '',
    'Daily Stats:',
    `Active work time: ${formatDuration(activeMs)}`,
    `Work span: ${formatDuration(spanMs)}`,
    `Focus ratio: ${focusRatio}%`,
    `Tasks touched: ${taskIds.length}`,
    '',
    'Sessions Timeline:',
    sessionLines,
    '',
    'AFK Gaps:',
    gaps,
    '',
    'Time by Task:',
    taskTime,
    '',
    'Hourly Activity Bars:',
    buildHourlyBars(sessions, start, end),
    '',
    'Focus Area Blocks:',
    focusBlocks,
    '',
    'Related Task Details:',
    'Use todayLogs as workday facts. Use recentContextBeforeToday only as historical background; do not count it as today progress.',
    JSON.stringify(taskDetails, null, 2),
  ].join('\n')

  return { inputText, fingerprintData: input, sessionCount: sessions.length }
}

export async function generateDailySummary(date: string, options: { refresh?: boolean; mode?: 'record' | 'test' } = {}): Promise<DailySummaryResult> {
  const mode = options.mode ?? 'record'
  const settings = getLlmSettings()
  if (!settings.baseUrl || !settings.model) throw new Error('LLM is not configured')
  const prompt = settings.dailySummaryPrompt.trim() || DEFAULT_DAILY_SUMMARY_PROMPT
  const promptVersion = settings.dailySummaryPrompt.trim() ? 'daily_summary_custom' : 'daily_summary_default_v1'
  const input = buildSummaryInput(date)
  const fingerprint = createHash('sha1').update(JSON.stringify({ prompt, input: input.fingerprintData })).digest('hex')
  const cached = queryOne('SELECT * FROM day_script_daily_summaries WHERE script_date = ?', [date]) as { fingerprint: string; summary_markdown: string; llm_call_log_id: string | null } | null
  if (mode === 'record' && !options.refresh && cached?.fingerprint === fingerprint) {
    return { date, summaryMarkdown: cached.summary_markdown, cached: true, llmCallLogId: cached.llm_call_log_id }
  }

  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: input.inputText },
  ]
  const logId = randomUUID()
  const started = Date.now()
  let rawProviderResponse: string | null = null
  let rawResponse: string | null = null
  let finishReason: string | null = null
  let status = 'success'
  let errorMessage: string | null = null
  let parsedOutput: any = null
  let summaryMarkdown = ''

  try {
    const response = await callChatCompletionsWithRaw(settings, messages, settings.dailySummaryMaxTokens, { jsonResponse: false })
    rawProviderResponse = response.providerResponse
    summaryMarkdown = response.content.trim()
    rawResponse = summaryMarkdown
    finishReason = response.finishReason
    parsedOutput = { summaryMarkdown }
  } catch (err: any) {
    if (err?.providerResponse && !rawProviderResponse) rawProviderResponse = err.providerResponse
    if (err?.content && !rawResponse) rawResponse = err.content
    if (err?.finishReason && !finishReason) finishReason = err.finishReason
    status = err?.finishReason === 'length' ? 'truncated' : (rawResponse || rawProviderResponse ? 'parse_error' : 'error')
    errorMessage = err?.message ?? 'Daily summary failed'
    parsedOutput = null
    throw err
  } finally {
    insertLlmCallLog({
      id: logId,
      feature: 'daily_summary',
      promptVersion,
      model: settings.model,
      baseUrl: settings.baseUrl,
      requestInput: { date, mode, inputText: input.inputText, sessionCount: input.sessionCount },
      requestMessages: messages,
      rawProviderResponse,
      rawResponse,
      finishReason,
      parsedOutput,
      status,
      errorMessage,
      latencyMs: Date.now() - started,
    })
  }

  if (mode === 'record') {
    run(
      `INSERT INTO day_script_daily_summaries (script_date, fingerprint, summary_markdown, llm_call_log_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(script_date) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         summary_markdown = excluded.summary_markdown,
         llm_call_log_id = excluded.llm_call_log_id,
         updated_at = excluded.updated_at`,
      [date, fingerprint, escapeJson(summaryMarkdown), logId, Date.now()]
    )
  }
  return { date, summaryMarkdown, cached: false, llmCallLogId: logId }
}

export function getDailySummaryCache(date: string): DailySummaryCacheResult | null {
  const settings = getLlmSettings()
  const prompt = settings.dailySummaryPrompt.trim() || DEFAULT_DAILY_SUMMARY_PROMPT
  const input = buildSummaryInput(date)
  const fingerprint = createHash('sha1').update(JSON.stringify({ prompt, input: input.fingerprintData })).digest('hex')
  const cached = queryOne('SELECT * FROM day_script_daily_summaries WHERE script_date = ?', [date]) as {
    fingerprint: string
    summary_markdown: string
    llm_call_log_id: string | null
    updated_at: number
  } | null
  if (!cached) return null
  return {
    date,
    summaryMarkdown: cached.summary_markdown,
    cached: true,
    llmCallLogId: cached.llm_call_log_id,
    updatedAt: cached.updated_at,
    fingerprintStatus: cached.fingerprint === fingerprint ? 'fresh' : 'stale',
  }
}

export function buildPlanTodayDraft(date: string): PlanTodayDraftResult {
  const yesterday = addDays(date, -1)
  const tasksById = new Map(getAllTasks().map((task) => [task.id, task]))
  const contexts = getTaskContexts(['PENDING', 'DOING'])
  const nodes: JsonNode[] = []
  let recommendedTaskCount = 0
  let taskCount = 0

  for (const context of contexts) {
    const task = tasksById.get(context.taskId)
    if (!task) continue
    const explicit = context.summary.nextStep.trim()
    const recommended = context.summary.recommendedNextStep.trim()
    const action = explicit || recommended
    if (!action) continue
    taskCount += 1
    if (!explicit && recommended) recommendedTaskCount += 1
    nodes.push(paragraph([
      text(explicit ? 'Next step ' : 'Recommended '),
      makeTaskMention(task),
      text(`: ${action}`),
    ]))
  }

  const previous = getDayScript(yesterday)
  const unfinished = previous.blocks.filter((block) => !block.completed)
  if (nodes.length > 0 && unfinished.length > 0) nodes.push({ type: 'horizontalRule' })
  for (const block of unfinished) {
    nodes.push(paragraph(carriedBlockHeader(block, tasksById)))
    if (block.progressText.trim()) nodes.push(paragraph([text(block.progressText.trim())]))
  }

  return {
    date,
    document: normalizeDoc(nodes),
    sources: {
      taskCount,
      recommendedTaskCount,
      carriedBlockCount: unfinished.length,
    },
  }
}
