import { z } from 'zod'
import { getConfig, updateConfig } from '../config'
import { getDb } from '../db'

export const DEFAULT_MEETING_EXTRACTION_PROMPT = `You extract meeting notes from raw user input.
The user input may contain HTML rich text. Use both the HTML and plain-text versions when provided.
Return only valid JSON matching this shape:
{
  "title": "string",
  "startedAt": "ISO 8601 string | null",
  "endedAt": "ISO 8601 string | null",
  "content": "HTML string",
  "participants": ["string"],
  "tags": ["string"],
  "warnings": ["string"]
}
Rules:
- title is required. If the input does not contain an explicit title, infer a short, descriptive title from the meeting topic or first key discussion point.
- If the input only contains a time range such as 10:00-11:00, use today's local date.
- If participants are missing, return an empty array.
- The content field must be safe, simple HTML suitable for a rich-text editor. Prefer <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>, <h2>, and <h3>.
- Preserve meaningful formatting from the raw HTML. Do not return Markdown in content.
- Suggest relevant tags when clear, but include "meeting" if this is a meeting.
- Put unresolved ambiguity in warnings.
- Do not include markdown fences or prose outside JSON.`

export const DEFAULT_TASK_SUMMARY_PROMPT = `Summarize the latest task state.
Return only valid JSON matching this exact shape:
{
  "latestProgress": "non-empty string",
  "nextStep": "string"
}
Rules:
- Return exactly these two keys: latestProgress and nextStep.
- Do not add, remove, rename, or nest fields.
- Use the same language as the task logs when possible.
- Base the answer only on the supplied task data.
- latestProgress must be a concise summary of the current task state, ideally 1-2 short sentences.
- latestProgress must not be empty.
- Only fill nextStep when the supplied logs explicitly mention a next step, next action, follow-up plan, or equivalent wording.
- If there is no explicit next step in the supplied logs, nextStep must be an empty string.
- nextStep must never be null.
- Escape any newline inside JSON string values as \\n.
- Do not include markdown fences or prose outside JSON.`

export interface LlmSettings {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  meetingExtractionPrompt: string
  defaultMeetingExtractionPrompt: string
  taskSummaryPrompt: string
  defaultTaskSummaryPrompt: string
}

export interface LlmCallLog {
  id: string
  feature: string
  promptVersion: string
  model: string | null
  baseUrl: string | null
  requestInput: unknown
  requestMessages: unknown
  rawProviderResponse: string | null
  rawResponse: string | null
  parsedOutput: unknown
  status: string
  errorMessage: string | null
  latencyMs: number | null
  createdAt: number
  linkedTaskId: string | null
  linkedEntryId: string | null
}

const extractionSchema = z.object({
  title: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  content: z.string().optional(),
  participants: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
})

class LlmProviderResponseError extends Error {
  constructor(message: string, readonly providerResponse: string) {
    super(message)
    this.name = 'LlmProviderResponseError'
  }
}

export function getLlmSettings(): LlmSettings {
  const config = getConfig().llm
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30000,
    meetingExtractionPrompt: config.meetingExtractionPrompt,
    defaultMeetingExtractionPrompt: DEFAULT_MEETING_EXTRACTION_PROMPT,
    taskSummaryPrompt: config.taskSummaryPrompt,
    defaultTaskSummaryPrompt: DEFAULT_TASK_SUMMARY_PROMPT,
  }
}

export function saveLlmSettings(input: Partial<LlmSettings>): LlmSettings {
  const current = getLlmSettings()
  const timeoutMs = input.timeoutMs === undefined ? current.timeoutMs : Math.max(1000, Math.min(300000, Number(input.timeoutMs) || 30000))
  updateConfig({
    llm: {
      baseUrl: input.baseUrl ?? current.baseUrl,
      model: input.model ?? current.model,
      apiKey: input.apiKey ?? current.apiKey,
      timeoutMs,
      meetingExtractionPrompt: input.meetingExtractionPrompt ?? current.meetingExtractionPrompt,
      taskSummaryPrompt: input.taskSummaryPrompt ?? current.taskSummaryPrompt,
    },
  } as any)
  return getLlmSettings()
}

export async function testLlmConnection(): Promise<{ ok: boolean; latencyMs: number; model: string }> {
  const settings = getLlmSettings()
  const started = Date.now()
  await callChatCompletions(settings, [
    { role: 'system', content: 'Reply with JSON only.' },
    { role: 'user', content: '{"ping":true}' },
  ], 16)
  return { ok: true, latencyMs: Date.now() - started, model: settings.model }
}

export interface MeetingExtractionResult {
  llmCallLogId: string
  title: string | null
  startedAt: number | null
  endedAt: number | null
  content: string
  participants: string[]
  tags: string[]
  rawContent: string
  warnings: string[]
}

export async function extractMeeting(rawContent: string, mode: 'record' | 'test' = 'record'): Promise<MeetingExtractionResult> {
  const settings = getLlmSettings()
  const prompt = settings.meetingExtractionPrompt.trim() || DEFAULT_MEETING_EXTRACTION_PROMPT
  const promptVersion = settings.meetingExtractionPrompt.trim() ? 'meeting_extract_custom' : 'meeting_extract_default_v1'
  const rawContentText = htmlToPlainText(rawContent)
  const requestInput = { rawContent, rawContentText, mode }
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify({ rawContentHtml: rawContent, rawContentText, today: new Date().toISOString().slice(0, 10) }) },
  ]
  const logId = crypto.randomUUID()
  const started = Date.now()
  let rawProviderResponse: string | null = null
  let rawResponse: string | null = null
  let parsedOutput: any = null
  let status = 'success'
  let errorMessage: string | null = null

  try {
    const response = await callChatCompletionsWithRaw(settings, messages, 1200)
    rawProviderResponse = response.providerResponse
    rawResponse = response.content
    const parsedJson = parseJsonObject(rawResponse)
    const validated = extractionSchema.parse(parsedJson)
    parsedOutput = normalizeExtraction(validated, rawContent)
  } catch (err: any) {
    if (err?.providerResponse && !rawProviderResponse) rawProviderResponse = err.providerResponse
    status = err?.name === 'ZodError' || rawResponse || rawProviderResponse ? 'parse_error' : 'error'
    errorMessage = err?.message ?? 'LLM extraction failed'
    parsedOutput = fallbackExtraction(rawContent, [`LLM extraction failed: ${errorMessage}`])
  } finally {
    insertLlmCallLog({
      id: logId,
      feature: 'meeting_extract',
      promptVersion,
      model: settings.model,
      baseUrl: settings.baseUrl,
      requestInput,
      requestMessages: messages,
      rawProviderResponse,
      rawResponse,
      parsedOutput,
      status,
      errorMessage,
      latencyMs: Date.now() - started,
    })
  }

  return {
    llmCallLogId: logId,
    ...parsedOutput,
    rawContent,
  }
}

async function callChatCompletions(settings: LlmSettings, messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<string> {
  return (await callChatCompletionsWithRaw(settings, messages, maxTokens)).content
}

async function callChatCompletionsWithRaw(settings: LlmSettings, messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<{ content: string; providerResponse: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs)
  try {
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`)
    let json: any
    try {
      json = JSON.parse(text)
    } catch (err: any) {
      throw new LlmProviderResponseError(err?.message ?? 'Provider returned invalid JSON', text)
    }
    return {
      content: json.choices?.[0]?.message?.content ?? text,
      providerResponse: text,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error('No JSON object found in LLM response')
  }
}

function normalizeExtraction(input: z.infer<typeof extractionSchema>, rawContent: string): Omit<MeetingExtractionResult, 'llmCallLogId' | 'rawContent'> {
  const rawText = htmlToPlainText(rawContent)
  const fallback = parseTimeRangeFromRaw(rawText)
  const startedAt = parseMaybeDate(input.startedAt) ?? fallback.startedAt
  const endedAt = parseMaybeDate(input.endedAt) ?? fallback.endedAt
  const tags = ensureMeetingTag(input.tags ?? [])
  const warnings = [...(input.warnings ?? [])]
  if (!startedAt || !endedAt) warnings.push('Meeting start or end time is missing.')
  if (startedAt && endedAt && endedAt <= startedAt) warnings.push('Meeting end time is not after start time.')
  return {
    title: input.title?.trim() || null,
    startedAt,
    endedAt,
    content: ensureHtmlContent(input.content?.trim() || rawContent.trim()),
    participants: uniqueClean(input.participants ?? []),
    tags,
    warnings: uniqueClean(warnings),
  }
}

function fallbackExtraction(rawContent: string, warnings: string[]): Omit<MeetingExtractionResult, 'llmCallLogId' | 'rawContent'> {
  const times = parseTimeRangeFromRaw(htmlToPlainText(rawContent))
  return {
    title: null,
    startedAt: times.startedAt,
    endedAt: times.endedAt,
    content: ensureHtmlContent(rawContent.trim()),
    participants: [],
    tags: ['meeting'],
    warnings,
  }
}

function ensureHtmlContent(value: string): string {
  if (!value.trim()) return ''
  if (/<[a-z][\s\S]*>/i.test(value)) return value
  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseMaybeDate(value: string | null | undefined): number | null {
  if (!value) return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

function parseTimeRangeFromRaw(rawContent: string): { startedAt: number | null; endedAt: number | null } {
  const match = rawContent.match(/(\d{1,2}):(\d{2})\s*(?:-|~|–|—|到|至)\s*(\d{1,2}):(\d{2})/)
  if (!match) return { startedAt: null, endedAt: null }
  const now = new Date()
  const start = new Date(now)
  start.setHours(Number(match[1]), Number(match[2]), 0, 0)
  const end = new Date(now)
  end.setHours(Number(match[3]), Number(match[4]), 0, 0)
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1)
  return { startedAt: start.getTime(), endedAt: end.getTime() }
}

export function ensureMeetingTag(tags: string[]): string[] {
  const cleaned = uniqueClean(tags)
  if (!cleaned.some((tag) => tag.toLowerCase() === 'meeting')) cleaned.unshift('meeting')
  return cleaned
}

function uniqueClean(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const clean = String(value).trim()
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(clean)
  }
  return result
}

export function insertLlmCallLog(data: {
  id: string
  feature: string
  promptVersion: string
  model: string | null
  baseUrl: string | null
  requestInput: unknown
  requestMessages: unknown
  rawProviderResponse?: string | null
  rawResponse: string | null
  parsedOutput: unknown
  status: string
  errorMessage: string | null
  latencyMs: number | null
}): void {
  getDb().prepare(`
    INSERT INTO llm_call_logs (
      id, feature, prompt_version, model, base_url, request_input, request_messages,
      raw_provider_response, raw_response, parsed_output, status, error_message, latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    data.feature,
    data.promptVersion,
    data.model,
    data.baseUrl,
    JSON.stringify(data.requestInput),
    JSON.stringify(data.requestMessages),
    data.rawProviderResponse ?? null,
    data.rawResponse,
    JSON.stringify(data.parsedOutput),
    data.status,
    data.errorMessage,
    data.latencyMs,
    Date.now(),
  )
}

export function linkLlmCallLogToTask(logId: string, taskId: string): void {
  getDb().prepare('UPDATE llm_call_logs SET linked_task_id = ? WHERE id = ?').run(taskId, logId)
}

export function listLlmCallLogs(feature?: string, limit = 50): LlmCallLog[] {
  const boundedLimit = Math.max(1, Math.min(200, limit))
  const rows = feature
    ? getDb().prepare('SELECT * FROM llm_call_logs WHERE feature = ? ORDER BY created_at DESC LIMIT ?').all(feature, boundedLimit)
    : getDb().prepare('SELECT * FROM llm_call_logs ORDER BY created_at DESC LIMIT ?').all(boundedLimit)
  return rows.map(rowToLog)
}

export function getLlmCallLog(id: string): LlmCallLog | null {
  const row = getDb().prepare('SELECT * FROM llm_call_logs WHERE id = ?').get(id)
  return row ? rowToLog(row) : null
}

function rowToLog(row: any): LlmCallLog {
  return {
    id: row.id,
    feature: row.feature,
    promptVersion: row.prompt_version,
    model: row.model,
    baseUrl: row.base_url,
    requestInput: safeJson(row.request_input),
    requestMessages: safeJson(row.request_messages),
    rawProviderResponse: row.raw_provider_response,
    rawResponse: row.raw_response,
    parsedOutput: safeJson(row.parsed_output),
    status: row.status,
    errorMessage: row.error_message,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    linkedTaskId: row.linked_task_id,
    linkedEntryId: row.linked_entry_id,
  }
}

function safeJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
