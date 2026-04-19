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
  // Extract English words first (including numbers with letters)
  const englishWords = text.match(/[a-zA-Z]+/g) || []
  // Replace English words with spaces, then tokenize remaining Chinese text
  const chineseOnly = text.replace(/[a-zA-Z]+/g, ' ')
  const jieba = getJieba()
  const chineseTokens = jieba.cut(chineseOnly) as string[]
  // Filter empty tokens and combine
  const words = [
    ...englishWords,
    ...chineseTokens.filter(t => t.trim()),
  ]
  return words.join(' ')
}
