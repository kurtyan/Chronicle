export type SearchJumpTarget = 'task' | 'note'

export interface SearchJumpIntent {
  target: SearchJumpTarget
  taskId?: string
  noteId?: string
  entryId?: string | null
  tokens: string[]
  query: string
  matchedSource?: string
  createdAt: number
}

const SEARCH_JUMP_KEY = 'chronicle:search_jump'
const SEARCH_JUMP_TTL_MS = 10_000

function parseIntent(): SearchJumpIntent | null {
  const raw = sessionStorage.getItem(SEARCH_JUMP_KEY)
  if (!raw) return null
  try {
    const intent = JSON.parse(raw) as SearchJumpIntent
    if (!intent.createdAt || Date.now() - intent.createdAt > SEARCH_JUMP_TTL_MS) {
      sessionStorage.removeItem(SEARCH_JUMP_KEY)
      return null
    }
    return intent
  } catch {
    sessionStorage.removeItem(SEARCH_JUMP_KEY)
    return null
  }
}

export function setSearchJumpIntent(intent: Omit<SearchJumpIntent, 'createdAt'>): void {
  sessionStorage.setItem(SEARCH_JUMP_KEY, JSON.stringify({ ...intent, createdAt: Date.now() }))
  window.dispatchEvent(new Event('chronicle:search-jump'))
}

export function hasSearchJumpIntent(target: SearchJumpTarget, id: string): boolean {
  const intent = parseIntent()
  if (!intent || intent.target !== target) return false
  return target === 'task' ? intent.taskId === id : intent.noteId === id
}

export function consumeSearchJumpIntent(target: SearchJumpTarget, id: string): SearchJumpIntent | null {
  const intent = parseIntent()
  if (!intent || intent.target !== target) return null
  const matches = target === 'task' ? intent.taskId === id : intent.noteId === id
  if (!matches) return null
  sessionStorage.removeItem(SEARCH_JUMP_KEY)
  return intent
}
