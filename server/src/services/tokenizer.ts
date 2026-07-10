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
  const technicalTokens = normalized.match(/[a-z0-9]+(?:[._:/@+-][a-z0-9]+)*/g) || []
  const chineseOnly = normalized.replace(/[a-z0-9]+(?:[._:/@+-][a-z0-9]+)*/g, ' ')
  const jieba = getJieba()
  const chineseTokens = jieba.cutForSearch(chineseOnly) as string[]
  const words = [...technicalTokens, ...chineseTokens]
    .map((token) => token.trim())
    .filter((token) => {
      if (!token) return false
      if (!/[\p{L}\p{N}]/u.test(token)) return false
      return true
    })
  const seen = new Set<string>()
  const result: string[] = []
  for (const word of words) {
    if (!seen.has(word)) {
      seen.add(word)
      result.push(word)
    }
  }
  return result.join(' ')
}
