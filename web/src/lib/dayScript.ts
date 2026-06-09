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
}

export interface ParsedDayScriptBlock extends Omit<DayScriptBlock, 'id'> {
  lineStart: number
  lineEnd: number
}

const TIME_HEADER_RE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s+|$)(.*)$/

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

export function extractDayScriptLines(document: JsonNode | null | undefined): ParsedDayScriptLine[] {
  const lines: ParsedDayScriptLine[] = []
  const visit = (node: JsonNode) => {
    const type = node.type ?? ''
    if (type === 'paragraph' || type === 'heading' || type === 'blockquote' || type === 'listItem') {
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
    const match = visible.match(TIME_HEADER_RE)
    if (match) {
      current = {
        sortOrder: blocks.length,
        startTime: match[1],
        endTime: match[2],
        headerText: match[3].replace(/\s*✅\s*/g, ' ').trim(),
        progressText: '',
        completed: match[3].includes('✅'),
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
