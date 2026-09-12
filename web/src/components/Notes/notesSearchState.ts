export type NotesSearchValue = { input: string; filters: string[] }

const STORAGE_KEY = 'chronicle:notes-search'
const isProjectFilter = (value: string) => /^(area|milestone):[^:]+$/.test(value)

export function normalizeNotesFilters(filters: string[]) {
  return [...new Set(filters.filter(isProjectFilter))]
}

export function readNotesSearch(search: string): NotesSearchValue {
  const params = new URLSearchParams(search)
  if (params.has('projectFilter') || params.has('q')) {
    return { input: params.get('q') || '', filters: normalizeNotesFilters(params.getAll('projectFilter')) }
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
    if (saved && typeof saved.input === 'string' && Array.isArray(saved.filters)) {
      return { input: saved.input, filters: normalizeNotesFilters(saved.filters.filter((item: unknown): item is string => typeof item === 'string')) }
    }
  } catch { /* A previous browser session must never block Notes. */ }
  return { input: '', filters: [] }
}

export function rememberNotesSearch(value: NotesSearchValue) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* URL still retains the filters. */ }
}

export function notesSearchParams(search: string, value: NotesSearchValue, noteId?: string) {
  const previous = new URLSearchParams(search)
  const params = new URLSearchParams()
  const activeId = noteId ?? previous.get('id')
  if (activeId) params.set('id', activeId)
  for (const [key, field] of previous) if (key !== 'id') params.append(key, field)
  params.set('q', value.input)
  params.delete('projectFilter')
  for (const filter of value.filters) params.append('projectFilter', filter)
  return params.toString()
}

export function parseNotesSearchInput(input: string) {
  const match = /(?:^|\s)#([^#]*)$/.exec(input)
  if (!match) return { text: input.trim(), tagQuery: null as string | null, prefix: input }
  const prefix = input.slice(0, match.index).trimEnd()
  return { text: prefix.trim(), tagQuery: match[1].trim(), prefix }
}
