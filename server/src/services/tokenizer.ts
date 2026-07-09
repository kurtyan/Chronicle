import { getLogger } from '../logging'

let jieba: typeof import('nodejieba') | null = null

function getJieba(): typeof import('nodejieba') {
  if (!jieba) {
    const mod = require('nodejieba')
    mod.load()
    jieba = mod
    getLogger().info('nodejieba loaded')
  }
  return jieba!
}

export function tokenize(text: string): string {
  if (!text) return ''
  const normalized = text.toLowerCase()
  // Extract technical ASCII tokens before jieba sees them. nodejieba splits
  // Latin text into letters, while Chronicle needs IDs, URLs, package names,
  // and words-with-digits to remain searchable as meaningful units.
  const technicalTokens = normalized.match(/[a-z0-9]+(?:[._:/@+-][a-z0-9]+)*/g) || []
  const chineseOnly = normalized.replace(/[a-z0-9]+(?:[._:/@+-][a-z0-9]+)*/g, ' ')
  const jieba = getJieba()
  const chineseTokens = jieba.cut(chineseOnly) as string[]
  const shortAsciiAllowlist = new Set(['ai', 'go', 'ui', 'ux', 'id'])
  const words = [...technicalTokens, ...chineseTokens]
    .map((token) => token.trim())
    .filter((token) => {
      if (!token) return false
      if (!/[\p{L}\p{N}]/u.test(token)) return false
      if (/^[a-z0-9]$/i.test(token)) return false
      if (/^[a-z]{2}$/i.test(token) && !shortAsciiAllowlist.has(token)) return false
      return true
    })
  return [...new Set(words)].join(' ')
}
