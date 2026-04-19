import { createElement } from 'react'

/**
 * Highlight tokens in plain text by wrapping matches in <mark> elements.
 * Returns ReactNode array.
 */
export function highlightText(text: string, tokens: string[]): React.ReactNode {
  if (!text || tokens.length === 0) return text

  const sorted = [...tokens].filter(Boolean).sort((a, b) => b.length - a.length)
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  while (remaining.length > 0) {
    let bestIdx = -1
    let bestLen = 0
    for (const token of sorted) {
      if (!token) continue
      const idx = remaining.toLowerCase().indexOf(token.toLowerCase())
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx
        bestLen = token.length
      }
    }

    if (bestIdx < 0) {
      parts.push(remaining)
      break
    }

    if (bestIdx > 0) {
      parts.push(remaining.slice(0, bestIdx))
    }
    parts.push(
      createElement('mark', { key: key++, className: 'search-highlight' }, remaining.slice(bestIdx, bestIdx + bestLen))
    )
    remaining = remaining.slice(bestIdx + bestLen)
  }

  return parts.length === 1 ? parts[0] : parts
}

/**
 * Highlight tokens inside HTML content.
 * Splits HTML into tag/text segments, highlights only text nodes, reassembles.
 * Returns the modified HTML string.
 */
export function highlightHtml(html: string, tokens: string[]): string {
  if (!html || tokens.length === 0) return html

  // Split HTML into tags and text segments
  const segments: Array<{ type: 'tag' | 'text'; content: string }> = []
  const parts = html.split(/(<[^>]*>)/g)
  for (const part of parts) {
    if (part === '') continue
    if (part.startsWith('<') && !part.startsWith('&')) {
      segments.push({ type: 'tag', content: part })
    } else {
      segments.push({ type: 'text', content: part })
    }
  }

  const sorted = [...tokens].filter(Boolean).sort((a, b) => b.length - a.length)

  function highlightPlainText(text: string): string {
    let result = ''
    let remaining = text
    while (remaining.length > 0) {
      let bestIdx = -1
      let bestLen = 0
      for (const token of sorted) {
        if (!token) continue
        const idx = remaining.toLowerCase().indexOf(token.toLowerCase())
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          bestIdx = idx
          bestLen = token.length
        }
      }
      if (bestIdx < 0) {
        result += remaining
        break
      }
      result += remaining.slice(0, bestIdx)
      result += `<mark class="search-highlight">${remaining.slice(bestIdx, bestIdx + bestLen)}</mark>`
      remaining = remaining.slice(bestIdx + bestLen)
    }
    return result
  }

  return segments.map(s =>
    s.type === 'tag' ? s.content : highlightPlainText(s.content)
  ).join('')
}
