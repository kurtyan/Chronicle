import { create } from 'zustand'
import type { GlobalSearchResponse } from '@/types'

interface SearchPersistState {
  query: string
  results: GlobalSearchResponse | null
  selectedIndex: number
  timestamp: number
}

interface SearchPersistStore {
  lastSearch: SearchPersistState | null
  setLastSearch: (s: SearchPersistState) => void
  clear: () => void
}

const SEARCH_PERSIST_TTL_MS = 5 * 60 * 1000

export function isSearchPersistValid(state: SearchPersistState | null): state is SearchPersistState {
  if (!state) return false
  return Date.now() - state.timestamp < SEARCH_PERSIST_TTL_MS
}

export const useSearchPersistStore = create<SearchPersistStore>((set) => ({
  lastSearch: null,
  setLastSearch: (s) => set({ lastSearch: s }),
  clear: () => set({ lastSearch: null }),
}))
