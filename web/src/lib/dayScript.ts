import type { DayScriptBlock } from '@/types'

type JsonNode = {
  type?: string
  text?: string
  attrs?: Record<string, any>
  marks?: Array<{ type?: string; attrs?: Record<string, any> }>
  content?: JsonNode[]
}

export interface ParsedDayScriptLine {
  text: string
  taskIds: string[]
  separator?: boolean
}

export interface ParsedDayScriptBlock extends Omit<DayScriptBlock, 'id'> {
  lineStart: number
  lineEnd: number
}

const TIME_VALUE_PATTERN = '(?:\\d{1,2}:\\d{2}|\\d{3,4})'
const TIME_HEADER_RE = new RegExp(`^(${TIME_VALUE_PATTERN})\\s*-\\s*(${TIME_VALUE_PATTERN})(?:\\s+|$)(.*)$`)
const SEPARATOR_RE = /^-{4,}$/

export function buildDayScriptActivityKey(block: Pick<DayScriptBlock, 'sortOrder' | 'startTime' | 'endTime' | 'headerText'>, taskId: string): string {
  return [
    block.sortOrder,
    block.startTime,
    block.endTime,
    block.headerText.replace(/\s+/g, ' ').trim(),
    taskId,
  ].join('|')
}

function extractTaskId(mark?: { type?: string; attrs?: Record<string, any> }): string | null {
  if (!mark || mark.type !== 'link') return null
  if (typeof mark.attrs?.taskId === 'string' && mark.attrs.taskId) return mark.attrs.taskId
  const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : ''
  const match = href.match(/[?&]task=([^&]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function collectInline(nodes: JsonNode[]): ParsedDayScriptLine {
  let text = ''
  const taskIds = new Set<string>()

  const visit = (node: JsonNode) => {
    if (node.type === 'hardBreak') {
      text += '\n'
      return
    }
    if (node.type === 'text') {
      text += node.text ?? ''
      for (const mark of node.marks ?? []) {
        const taskId = extractTaskId(mark)
        if (taskId) taskIds.add(taskId)
      }
      return
    }
    for (const child of node.content ?? []) visit(child)
  }

  nodes.forEach(visit)
  return { text: text.replace(/\u00a0/g, ' '), taskIds: [...taskIds] }
}

function parseTimeValue(value: string): string | null {
  const trimmed = value.trim()
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  const compactMatch = trimmed.match(/^(\d{3,4})$/)
  const hours = colonMatch ? Number(colonMatch[1]) : compactMatch ? Number(trimmed.slice(0, -2)) : NaN
  const minutes = colonMatch ? Number(colonMatch[2]) : compactMatch ? Number(trimmed.slice(-2)) : NaN
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function parseTimeHeader(text: string): { startTime: string; endTime: string; bodyText: string } | null {
  const match = text.match(TIME_HEADER_RE)
  if (!match) return null
  const startTime = parseTimeValue(match[1])
  const endTime = parseTimeValue(match[2])
  if (!startTime || !endTime) return null
  return { startTime, endTime, bodyText: match[3] }
}

export function extractDayScriptLines(document: JsonNode | null | undefined): ParsedDayScriptLine[] {
  const lines: ParsedDayScriptLine[] = []
  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'horizontalRule') {
      lines.push({ text: '----', taskIds: [], separator: true })
      return
    }
    if (type === 'image' || type === 'imageResize') {
      lines.push({ text: '', taskIds: [] })
      return
    }
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem' || type === 'codeBlock') {
      lines.push(collectInline(node.content ?? []))
      return
    }
    for (const child of node.content ?? []) visit(child)
  }

  if (!document?.content) return [{ text: '', taskIds: [] }]
  document.content.forEach(visit)
  return lines.length > 0 ? lines : [{ text: '', taskIds: [] }]
}

export function parseDayScriptDocument(document: JsonNode | null | undefined): ParsedDayScriptBlock[] {
  const lines = extractDayScriptLines(document)
  const blocks: ParsedDayScriptBlock[] = []
  let current: ParsedDayScriptBlock | null = null

  lines.forEach((line, index) => {
    const visible = line.text.trimEnd()
    if (line.separator || SEPARATOR_RE.test(visible.trim())) {
      current = null
      return
    }

    const header = parseTimeHeader(visible)
    if (header) {
      current = {
        sortOrder: blocks.length,
        startTime: header.startTime,
        endTime: header.endTime,
        headerText: header.bodyText.replace(/\s*✅\s*/g, ' ').trim(),
        progressText: '',
        completed: header.bodyText.includes('✅'),
        taskIds: line.taskIds,
        lineStart: index,
        lineEnd: index,
      }
      blocks.push(current)
      return
    }

    if (!current) return
    current.lineEnd = index
    current.progressText = current.progressText ? `${current.progressText}\n${line.text}` : line.text
  })

  return blocks
}

export function findActiveBlock(blocks: Array<Pick<DayScriptBlock, 'startTime' | 'endTime'>>, now: Date): number {
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  return blocks.findIndex((block) => {
    const [startH, startM] = block.startTime.split(':').map(Number)
    const [endH, endM] = block.endTime.split(':').map(Number)
    const start = startH * 60 + startM
    const end = endH * 60 + endM
    return currentMinutes >= start && currentMinutes < end
  })
}
