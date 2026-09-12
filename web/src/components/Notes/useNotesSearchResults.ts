import { useCallback, useEffect, useRef, useState } from 'react'
import { projectError, projectRequest } from '@/services/projectApi'
import { useProjectRefresh } from '@/components/Projects/common'
import type { Note } from '@/types'

/** Read-only list requests never activate a cached Note or alter the editor's revision. */
export function useNotesSearchResults(filters: string[], query: string, includeArchived: boolean, storedNotes: Note[]) {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const version = useRef(0)
  const refresh = useProjectRefresh()
  const filterKey = JSON.stringify(filters)
  const loadNotes = useCallback(async () => {
    const requestVersion = ++version.current
    setLoading(true)
    setError(null)
    try {
      const result = await projectRequest<Note[]>('get', '/api/notes', { includeArchived, query: query || undefined, limit: 300, projectFilters: filterKey })
      if (version.current === requestVersion) { setNotes(result); setLoading(false) }
      return result
    } catch (failure) {
      if (version.current === requestVersion) { setError(projectError(failure)); setNotes([]); setLoading(false) }
      return []
    }
  }, [filterKey, query, includeArchived])
  useEffect(() => {
    // Invalidate immediately, including a response that arrives during the debounce.
    ++version.current
    setLoading(true)
    const timer = window.setTimeout(() => { void loadNotes() }, 180)
    return () => { ++version.current; window.clearTimeout(timer) }
  }, [loadNotes, storedNotes, refresh])
  return { notes, loading, error, loadNotes }
}
