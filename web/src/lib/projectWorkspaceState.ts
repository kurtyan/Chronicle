import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/** A project URL identifies the working view, not just the page. */
export function useProjectViewQuery() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const update = useCallback((changes: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    const search = next.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true, state: location.state })
  }, [navigate, location.pathname, location.state])
  return { params, update, location }
}

const scrollPositions = new Map<string, { left: number; top: number }>()
export function projectScrollKey(view: string, search: string) {
  const params = new URLSearchParams(search)
  for (const key of ['selected', 'lang', 'view']) params.delete(key)
  params.sort()
  return `chronicle:project-scroll:${view}:${params}`
}
export function readProjectScroll(key: string) {
  const memory = scrollPositions.get(key)
  if (memory) return memory
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null')
    if (Number.isFinite(value?.left) && Number.isFinite(value?.top)) return value as { left: number; top: number }
  } catch { /* Reading is optional; scrolling remains available. */ }
  return { left: 0, top: 0 }
}
export function saveProjectScroll(key: string, element: HTMLElement) {
  const value = { left: element.scrollLeft, top: element.scrollTop }
  scrollPositions.set(key, value)
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Keep the current-session copy. */ }
}
