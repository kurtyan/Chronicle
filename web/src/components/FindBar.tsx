import { useEffect, useRef, useState, useCallback } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

interface FindBarProps {
  open: boolean
  onClose: () => void
  containerRef: React.RefObject<HTMLElement | null>
  onTokensChange: (tokens: string[]) => void
  onCurrentMatchChange?: (index: number) => void
}

export function FindBar({ open, onClose, containerRef, onTokensChange, onCurrentMatchChange }: FindBarProps) {
  const [query, setQuery] = useState('')
  const [currentMatch, setCurrentMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusRestoreRef = useRef<HTMLElement | null>(null)
  const currentMatchRef = useRef(0)
  const currentTargetRef = useRef<HTMLElement | null>(null)
  const totalMatchesRef = useRef(0)
  const pendingScrollRef = useRef<number | null>(null)

  const updateMatches = useCallback((targetIdx: number) => {
    const container = containerRef.current
    if (!container) return
    const marks = container.querySelectorAll('.search-highlight')
    totalMatchesRef.current = marks.length
    setTotalMatches(marks.length)
    if (marks.length === 0) {
      setCurrentMatch(0)
      currentMatchRef.current = 0
      currentTargetRef.current = null
      onCurrentMatchChange?.(-1)
      return
    }
    const idx = ((targetIdx % marks.length) + marks.length) % marks.length
    setCurrentMatch(idx)
    currentMatchRef.current = idx
    const target = marks[idx] as HTMLElement
    currentTargetRef.current = target
    if (onCurrentMatchChange) {
      onCurrentMatchChange(idx)
    } else {
      marks.forEach((m) => m.classList.remove('search-highlight-current'))
      target.classList.add('search-highlight-current')
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [containerRef, onCurrentMatchChange])

  // Sync tokens with parent and trigger a match scan after the DOM updates
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : []
    onTokensChange(tokens)

    // Wait for the next paint + a small buffer for child highlights to render
    const raf = requestAnimationFrame(() => {
      pendingScrollRef.current = window.setTimeout(() => {
        updateMatches(0)
      }, 120)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (pendingScrollRef.current) window.clearTimeout(pendingScrollRef.current)
    }
  }, [open, query, onTokensChange, updateMatches])

  // Watch for DOM changes that add/remove highlights (e.g. parent re-render, content loading)
  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return

    const observer = new MutationObserver(() => {
      const marks = container.querySelectorAll('.search-highlight')
      // React can replace every mark while keeping the same count. Re-select when
      // the actual current node disappeared, not only when the count changed.
      if (marks.length !== totalMatchesRef.current || !currentTargetRef.current || !container.contains(currentTargetRef.current)) {
        updateMatches(currentMatchRef.current)
      }
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [open, containerRef, updateMatches])

  // Restore focus and clear state on open/close
  useEffect(() => {
    if (!open) return
    focusRestoreRef.current = document.activeElement as HTMLElement
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  function nextMatch() {
    updateMatches(currentMatchRef.current + 1)
  }

  function prevMatch() {
    updateMatches(currentMatchRef.current - 1)
  }

  function handleClose() {
    onTokensChange([])
    const container = containerRef.current
    if (onCurrentMatchChange) {
      onCurrentMatchChange(-1)
    } else if (container) {
      container.querySelectorAll('.search-highlight-current').forEach((m) => m.classList.remove('search-highlight-current'))
    }
    setQuery('')
    setCurrentMatch(0)
    setTotalMatches(0)
    currentMatchRef.current = 0
    currentTargetRef.current = null
    totalMatchesRef.current = 0
    onClose()
    focusRestoreRef.current?.focus()
    focusRestoreRef.current = null
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) prevMatch()
      else nextMatch()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      handleClose()
    }
  }

  if (!open) return null

  return (
    <div data-find-bar="true" className="absolute right-4 top-4 z-30 flex items-center gap-1 rounded-lg border border-border bg-background/95 px-2 py-1 shadow-md backdrop-blur-sm">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-7 w-40 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder="Find..."
      />
      {totalMatches > 0 && (
        <span className="text-xs text-muted-foreground whitespace-nowrap px-1">
          {currentMatch + 1}/{totalMatches}
        </span>
      )}
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        onClick={prevMatch}
        disabled={totalMatches === 0}
        title="Previous (Shift+Enter)"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        onClick={nextMatch}
        disabled={totalMatches === 0}
        title="Next (Enter)"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={handleClose}
        title="Close (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
