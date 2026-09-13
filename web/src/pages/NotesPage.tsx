import { ProjectReviewContext } from '@/components/Projects/ProjectReviewContext'
import { readProjectNavigation } from '@/lib/projectNavigation'
import { NotesTagSearch } from '@/components/Notes/NotesTagSearch'
import { notesSearchParams, parseNotesSearchInput, readNotesSearch, rememberNotesSearch, type NotesSearchValue } from '@/components/Notes/notesSearchState'
import { useNotesSearchResults } from '@/components/Notes/useNotesSearchResults'
import { ProjectRelations } from '@/components/Projects/ProjectRelations'
import { ProjectFeatureBoundary } from '@/components/Projects/ProjectFeatureBoundary'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, FilePlus2, FileText, ListTodo, Pin, PinOff } from 'lucide-react'
import { RichEditor } from '@/components/RichEditor'
import { FindBar } from '@/components/FindBar'
import { registerShortcut } from '@/shortcuts/registry'
import { useNoteStore } from '@/stores/noteStore'
import { useTaskStore } from '@/stores/taskStore'
import * as api from '@/services/api'
import { cn } from '@/lib/utils'
import { formatTaskTime } from '@/lib/time'
import { consumeSearchJumpIntent } from '@/lib/searchJump'
import type { Note } from '@/types'
import { useI18n } from '@/i18n/context'

const NOTES_LIST_PERCENT_KEY = 'chronicle_notes_list_pct'
const NOTES_LIST_MIN_WIDTH = 180
const NOTES_DETAIL_MIN_WIDTH = 320

type NoteDraftSnapshot = { title: string; contentHtml: string; tags: string[] }

function isEditing(allowFindBarInput = false): boolean {
  const active = document.activeElement as HTMLElement | null
  if (!active) return false
  if (allowFindBarInput && active.closest('[data-find-bar="true"]')) return false
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || Boolean(active.closest('[data-rich-editor="true"]'))
}

function stripLeadingEmptyParagraphs(html: string): string {
  return html.replace(/^(?:\s*<p(?:\s[^>]*)?>(?:\s|&nbsp;|<br\s*\/?>|<br[^>]*>)<\/p>)+/i, '')
}

export function NotesPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const {
    notes: storedNotes, activeNote, linkedTasks, saveStatus, includeArchived,
    setActiveNote, createNote, updateActiveNote, archiveActiveNote, unarchiveActiveNote,
  } = useNoteStore()
  const tasks = useTaskStore((state) => state.tasks)
  const loadTodos = useTaskStore((state) => state.loadTodos)
  const setTaskActive = useTaskStore((state) => state.setActiveTask)
  const [notesSearch, setNotesSearch] = useState(() => readNotesSearch(location.search))
  const query = parseNotesSearchInput(notesSearch.input).text
  const { notes, loading, error: searchError, loadNotes } = useNotesSearchResults(notesSearch.filters, query, includeArchived, storedNotes)
  const urlNoteId = new URLSearchParams(location.search).get('id')
  const reviewId = new URLSearchParams(location.search).get('projectReview')
  const projectNavigation = useMemo(() => readProjectNavigation(location.state, location.search), [location.state, location.search])
  const updateNotesSearch = useCallback((value: NotesSearchValue) => {
    setNotesSearch(value)
    rememberNotesSearch(value)
    navigate(`/notes?${notesSearchParams(location.search, value)}`, { replace: true })
  }, [location.search, navigate])
  const noteUrl = useCallback((id: string) => {
    const params = new URLSearchParams(notesSearchParams(location.search, notesSearch, id))
    // A review belongs to one Note. Selecting another Note must not carry its confirmation action along.
    if (id !== urlNoteId) params.delete('projectReview')
    return `/notes?${params}`
  }, [location.search, notesSearch, urlNoteId])
  useEffect(() => { setNotesSearch(readNotesSearch(location.search)) }, [location.search])
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [jumpHighlightTokens, setJumpHighlightTokens] = useState<string[]>([])
  const [jumpHighlightTitle, setJumpHighlightTitle] = useState(false)
  const [jumpScrollKey, setJumpScrollKey] = useState(0)
  const [jumpSignal, setJumpSignal] = useState(0)
  const [showFindBar, setShowFindBar] = useState(false)
  const [findTokens, setFindTokens] = useState<string[]>([])
  const [findCurrentMatchIndex, setFindCurrentMatchIndex] = useState(-1)
  const [localSaveStatus, setLocalSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveConflict, setSaveConflict] = useState<{ noteId: string; draft: NoteDraftSnapshot } | null>(null)
  const [notesListWidth, setNotesListWidth] = useState(() => {
    const saved = localStorage.getItem(NOTES_LIST_PERCENT_KEY)
    const pct = saved ? parseFloat(saved) : 0.3
    return Math.round(window.innerWidth * pct)
  })
  const notesContainerRef = useRef<HTMLDivElement | null>(null)
  const notesListRef = useRef<HTMLDivElement | null>(null)
  const pendingListFocusRef = useRef<string | null>(null)
  const isResizingRef = useRef(false)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(0)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const latestDraftRef = useRef({ title: '', contentHtml: '', tags: [] as string[] })
  const activeNoteIdRef = useRef<string | null>(null)
  const draftNoteIdRef = useRef<string | null>(null)
  const draftServerRevisionRef = useRef(0)
  const draftTitleRef = useRef('')
  const draftTagsRef = useRef('')
  const flushSaveRef = useRef<() => Promise<void>>(async () => {})
  const noteSwitchRef = useRef<Promise<void>>(Promise.resolve())
  const localRevisionRef = useRef(0)
  const saveInFlightRef = useRef<Promise<void> | null>(null)
  const saveRequestedRef = useRef(false)
  const draftDirtyRef = useRef(false)

  useEffect(() => {
    draftTitleRef.current = draftTitle
  }, [draftTitle])

  useEffect(() => {
    draftTagsRef.current = draftTags
  }, [draftTags])

  useEffect(() => {
    void loadTodos()
  }, [loadTodos])

  useEffect(() => {
    if (urlNoteId) void setActiveNote(urlNoteId)
  }, [urlNoteId, setActiveNote])

  useEffect(() => {
    const handler = () => setJumpSignal((value) => value + 1)
    window.addEventListener('chronicle:search-jump', handler)
    return () => window.removeEventListener('chronicle:search-jump', handler)
  }, [])

  const toggleFindBar = useCallback(() => {
    setShowFindBar((open) => !open)
  }, [])

  useEffect(() => {
    if (!showFindBar) {
      setFindTokens([])
      setFindCurrentMatchIndex(-1)
    }
  }, [showFindBar])

  useEffect(() => {
    const id = new URLSearchParams(location.search).get('id')
    if (!id && !activeNote && notes.length > 0) {
      void setActiveNote(notes[0].id)
    }
  }, [activeNote, location.search, notes, setActiveNote])

  const applyNoteDraft = useCallback((note: Note | null) => {
    if (!note) {
      activeNoteIdRef.current = null
      draftNoteIdRef.current = null
      setDraftTitle('')
      setDraftContent('')
      setDraftTags('')
      draftTitleRef.current = ''
      draftTagsRef.current = ''
      latestDraftRef.current = { title: '', contentHtml: '', tags: [] }
      draftServerRevisionRef.current = 0
      draftDirtyRef.current = false
      return
    }
    if (note.id === draftNoteIdRef.current) return
    activeNoteIdRef.current = note.id
    draftNoteIdRef.current = note.id
    const stored = localStorage.getItem(`chronicle:note_draft:${note.id}`)
    let restored: { title?: string; contentHtml?: string; tags?: string[]; baseRevision?: number } | null = null
    if (stored) {
      try {
        restored = JSON.parse(stored) as { title?: string; contentHtml?: string; tags?: string[] }
      } catch {
        localStorage.removeItem(`chronicle:note_draft:${note.id}`)
      }
    }
    const next = {
      title: restored?.title ?? note.title,
      contentHtml: restored?.contentHtml ?? note.contentHtml,
      tags: restored?.tags ?? note.tags,
    }
    setDraftTitle(next.title)
    setDraftContent(next.contentHtml)
    setDraftTags(next.tags.join(', '))
    draftTitleRef.current = next.title
    draftTagsRef.current = next.tags.join(', ')
    latestDraftRef.current = next
    draftServerRevisionRef.current = restored?.baseRevision ?? note.revision
    draftDirtyRef.current = Boolean(restored)
    setLocalSaveStatus(restored ? 'error' : 'idle')
  }, [])

  useEffect(() => {
    applyNoteDraft(activeNote)
  }, [activeNote?.id])

  useEffect(() => {
    if (!activeNote) return
    const intent = consumeSearchJumpIntent('note', activeNote.id)
    if (!intent) return

    const titleMatch = intent.matchedSource === 'note_title' || intent.matchedSource === 'note_tags'
    setJumpHighlightTokens(titleMatch ? [] : intent.tokens)
    setJumpHighlightTitle(titleMatch)
    setJumpScrollKey((key) => key + 1)

    const frame = window.requestAnimationFrame(() => {
      if (titleMatch) titleInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    const clearTimer = window.setTimeout(() => {
      setJumpHighlightTokens([])
      setJumpHighlightTitle(false)
    }, 3000)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(clearTimer)
    }
  }, [activeNote?.id, jumpSignal])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      void flushSaveRef.current()
    }
  }, [])

  const visibleNotes = notes

  const parsedTags = useMemo(() => draftTags.split(',').map((tag) => tag.trim()).filter(Boolean), [draftTags])

  const clampNotesListWidth = useCallback((width: number, containerWidth = notesContainerRef.current?.clientWidth ?? window.innerWidth) => {
    const maxWidth = Math.max(NOTES_LIST_MIN_WIDTH, containerWidth - NOTES_DETAIL_MIN_WIDTH)
    return Math.min(maxWidth, Math.max(NOTES_LIST_MIN_WIDTH, width))
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      setNotesListWidth((width) => clampNotesListWidth(width))
    }
    handleWindowResize()
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [clampNotesListWidth])

  const handleResizeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    isResizingRef.current = true
    resizeStartXRef.current = event.clientX
    resizeStartWidthRef.current = notesListWidth
    const containerWidth = notesContainerRef.current?.clientWidth ?? window.innerWidth
    document.body.style.userSelect = 'none'

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return
      const diff = moveEvent.clientX - resizeStartXRef.current
      setNotesListWidth(clampNotesListWidth(resizeStartWidthRef.current + diff, containerWidth))
    }

    const onMouseUp = () => {
      isResizingRef.current = false
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setNotesListWidth((width) => {
        const clamped = clampNotesListWidth(width, containerWidth)
        localStorage.setItem(NOTES_LIST_PERCENT_KEY, String(clamped / containerWidth))
        return clamped
      })
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampNotesListWidth, notesListWidth])

  const focusEditor = useCallback(() => {
    const proseMirror = document.querySelector('[data-rich-editor="true"] .ProseMirror') as HTMLElement | null
    proseMirror?.focus()
  }, [])

  const focusActiveNoteListItem = useCallback(() => {
    const noteId = activeNoteIdRef.current
    pendingListFocusRef.current = null
    if (!noteId) return
    const item = document.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`) as HTMLButtonElement | null
    if (item) { item.focus(); return }
    // The editor may become usable before the debounced list request finishes.
    // Keep keyboard focus in a stable list container until its item mounts.
    notesListRef.current?.focus()
    if (loading) pendingListFocusRef.current = noteId
  }, [loading])

  useEffect(() => {
    const noteId = pendingListFocusRef.current
    if (!noteId || loading) return
    pendingListFocusRef.current = null
    // A late response must not steal focus after the user resumes editing or
    // moves to another control. An excluded Note leaves focus on the list.
    if (document.activeElement !== notesListRef.current || activeNoteIdRef.current !== noteId) return
    const item = notesListRef.current?.querySelector<HTMLButtonElement>(`[data-note-id="${CSS.escape(noteId)}"]`)
    item?.focus()
  }, [visibleNotes, loading])

  const handleTitleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'Tab') {
      event.preventDefault()
      focusEditor()
    }
  }, [focusEditor])

  function scheduleSave(next: { title?: string; contentHtml?: string; tags?: string[] }) {
    const noteId = draftNoteIdRef.current
    if (!noteId) return
    localRevisionRef.current += 1
    latestDraftRef.current = {
      title: next.title ?? latestDraftRef.current.title,
      contentHtml: next.contentHtml ?? latestDraftRef.current.contentHtml,
      tags: next.tags ?? latestDraftRef.current.tags,
    }
    draftDirtyRef.current = true
    setLocalSaveStatus('saving')
    localStorage.setItem(`chronicle:note_draft:${noteId}`, JSON.stringify({ ...latestDraftRef.current, baseRevision: draftServerRevisionRef.current }))
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => { void flushSave() }, 800)
  }

  async function flushSave() {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (!draftNoteIdRef.current) return
    if (!draftDirtyRef.current) return

    saveRequestedRef.current = true
    if (saveInFlightRef.current) return saveInFlightRef.current

    // Register the in-flight promise before any save work begins. Deferring the
    // drain to a microtask closes the re-entrancy window created by synchronous
    // store updates at the start of updateActiveNote().
    const run = Promise.resolve().then(async () => {
      while (saveRequestedRef.current) {
        saveRequestedRef.current = false
        const noteId = draftNoteIdRef.current
        if (!noteId) return
        if (!draftDirtyRef.current) return

        setLocalSaveStatus('saving')
        const liveDraft = {
          title: draftTitleRef.current || latestDraftRef.current.title,
          contentHtml: stripLeadingEmptyParagraphs(latestDraftRef.current.contentHtml),
          tags: draftTagsRef.current.split(',').map((tag) => tag.trim()).filter(Boolean),
        }
        latestDraftRef.current = liveDraft
        const expectedRevision = draftServerRevisionRef.current
        localStorage.setItem(`chronicle:note_draft:${noteId}`, JSON.stringify({ ...liveDraft, baseRevision: expectedRevision }))
        const revAtFlush = localRevisionRef.current
        let failed = false

        try {
          const saved = useNoteStore.getState().activeNote?.id === noteId
            ? await updateActiveNote({ ...liveDraft, expectedRevision })
            : await api.updateNote(noteId, { ...liveDraft, expectedRevision })

          if (saved) {
            // A successful save advances the server revision even when the user
            // continued typing while the request was in flight. Newer edits must
            // be saved against this acknowledged revision, not the stale one.
            draftServerRevisionRef.current = saved.revision
            draftDirtyRef.current = localRevisionRef.current !== revAtFlush
          }

          if (!saved && useNoteStore.getState().lastSaveConflict) {
            setSaveConflict({ noteId, draft: {
              title: draftTitleRef.current || latestDraftRef.current.title,
              contentHtml: latestDraftRef.current.contentHtml,
              tags: draftTagsRef.current.split(',').map((tag) => tag.trim()).filter(Boolean),
            } })
          }
          if (!saved) failed = true

          if (localRevisionRef.current === revAtFlush && draftNoteIdRef.current === noteId) {
            if (saved) {
              localStorage.removeItem(`chronicle:note_draft:${saved.id}`)
              setSaveConflict((current) => current?.noteId === saved.id ? null : current)
              setLocalSaveStatus('saved')
            } else {
              setLocalSaveStatus('error')
            }
          }
        } catch (error: any) {
          failed = true
          const isConflict = error?.response?.status === 409 || error?.code === 'NOTE_REVISION_CONFLICT'
          if (isConflict) {
            setSaveConflict({ noteId, draft: {
              title: draftTitleRef.current || latestDraftRef.current.title,
              contentHtml: latestDraftRef.current.contentHtml,
              tags: draftTagsRef.current.split(',').map((tag) => tag.trim()).filter(Boolean),
            } })
          }
          if (localRevisionRef.current === revAtFlush && draftNoteIdRef.current === noteId) {
            setLocalSaveStatus('error')
          }
        }

        if (failed) {
          draftDirtyRef.current = true
          saveRequestedRef.current = false
          return
        }
        if (localRevisionRef.current !== revAtFlush && draftNoteIdRef.current === noteId) {
          saveRequestedRef.current = true
        }
      }
    })

    saveInFlightRef.current = run
    try {
      await run
    } finally {
      if (saveInFlightRef.current === run) saveInFlightRef.current = null
    }
  }

  useEffect(() => {
    flushSaveRef.current = flushSave
  })

  const isCurrentProjectNote = (note: Note) => note.id === draftNoteIdRef.current
    && note.id === activeNoteIdRef.current && !draftDirtyRef.current
    && note.revision === draftServerRevisionRef.current

  async function saveProjectNote(): Promise<Note> {
    const noteId = draftNoteIdRef.current
    if (!noteId || noteId !== activeNoteIdRef.current) throw new Error(t('project.reviewWorkflow.switchedNote'))
    // Use the existing serialized Note drain, including edits typed during an in-flight save.
    for (;;) {
      await flushSaveRef.current()
      if (saveInFlightRef.current) await saveInFlightRef.current
      if (draftNoteIdRef.current !== noteId || activeNoteIdRef.current !== noteId) throw new Error(t('project.reviewWorkflow.switchedNote'))
      // The dirty flag belongs to this draft and is retained after every failed
      // save. The store's global conflict flag may refer to a previously opened
      // Note, or remain set after the user explicitly reloads the server version.
      if (draftDirtyRef.current) throw new Error(t('project.reviewWorkflow.saveFailed'))
      const localVersion = localRevisionRef.current
      const saved = await api.getNoteById(noteId)
      if (draftNoteIdRef.current !== noteId || activeNoteIdRef.current !== noteId) throw new Error(t('project.reviewWorkflow.switchedNote'))
      if (localRevisionRef.current !== localVersion || draftDirtyRef.current) continue
      if (!saved || saved.revision !== draftServerRevisionRef.current) {
        setSaveConflict({ noteId, draft: { ...latestDraftRef.current } })
        throw new Error(t('project.reviewWorkflow.changedElsewhere'))
      }
      return saved
    }
  }

  const handleCreateNote = useCallback(async () => {
    const run = noteSwitchRef.current.then(async () => {
      await flushSaveRef.current()
      const note = await createNote({ title: 'Untitled note' })
      navigate(noteUrl(note.id))
      applyNoteDraft(note)
    })
    noteSwitchRef.current = run.catch(() => {})
    await run
  }, [applyNoteDraft, createNote, navigate, noteUrl])

  const handleSelectNote = useCallback(async (id: string) => {
    const run = noteSwitchRef.current.then(async () => {
      await flushSaveRef.current()
      navigate(noteUrl(id))
      await setActiveNote(id)
      const next = useNoteStore.getState().activeNote
      if (next?.id === id) applyNoteDraft(next)
    })
    noteSwitchRef.current = run.catch(() => {})
    await run
  }, [applyNoteDraft, navigate, noteUrl, setActiveNote])

  const handleArchive = useCallback(async () => {
    if (!activeNote) return
    await flushSaveRef.current()
    if (activeNote.archived) await unarchiveActiveNote()
    else await archiveActiveNote()
    await loadNotes()
  }, [activeNote, archiveActiveNote, loadNotes, unarchiveActiveNote])

  function handleArchiveWrapper() {
    void handleArchive()
  }

  const handleTogglePin = useCallback(async () => {
    await flushSaveRef.current()
    if (useNoteStore.getState().lastSaveConflict) return
    const current = useNoteStore.getState().activeNote
    if (!current) return
    const saved = await updateActiveNote({
      pinned: !current.pinned,
      expectedRevision: draftServerRevisionRef.current,
    })
    if (saved && draftNoteIdRef.current === saved.id) {
      draftServerRevisionRef.current = saved.revision
    }
  }, [updateActiveNote])

  const handleReloadConflict = useCallback(async () => {
    const conflict = saveConflict
    if (!conflict) return
    const fresh = await api.getNoteById(conflict.noteId)
    if (!fresh) return
    localStorage.removeItem(`chronicle:note_draft:${conflict.noteId}`)
    draftNoteIdRef.current = null
    navigate(reviewId ? noteUrl(conflict.noteId) : `/notes?id=${encodeURIComponent(conflict.noteId)}`)
    await setActiveNote(conflict.noteId)
    const active = useNoteStore.getState().activeNote
    if (active?.id === conflict.noteId) applyNoteDraft(active)
    setSaveConflict(null)
  }, [applyNoteDraft, navigate, noteUrl, reviewId, saveConflict, setActiveNote])

  const handleKeepConflictCopy = useCallback(async () => {
    const conflict = saveConflict
    if (!conflict) return
    const copy = await createNote({
      title: `${conflict.draft.title || 'Untitled note'} (conflict copy)`,
      contentHtml: conflict.draft.contentHtml,
      tags: conflict.draft.tags,
    })
    draftDirtyRef.current = false
    saveRequestedRef.current = false
    localStorage.removeItem(`chronicle:note_draft:${conflict.noteId}`)
    useNoteStore.setState({ lastSaveConflict: false, saveStatus: 'idle', error: null })
    setSaveConflict(null)
    navigate(noteUrl(copy.id))
    applyNoteDraft(copy)
  }, [applyNoteDraft, createNote, navigate, noteUrl, saveConflict])

  useEffect(() => {
    const unregisters = [
      registerShortcut({
        id: 'notes-new-note',
        combo: 'mod+n',
        label: 'New note',
        scope: 'page',
        context: () => location.pathname === '/notes',
        handler: () => { void handleCreateNote() },
      }),
      registerShortcut({
        id: 'notes-save-note',
        combo: 'mod+s',
        label: 'Save note',
        scope: 'page',
        context: () => location.pathname === '/notes',
        handler: () => { void flushSave() },
      }),
      registerShortcut({
        id: 'notes-submit-save',
        combo: 'ctrl+enter',
        label: 'Save note',
        scope: 'page',
        context: () => location.pathname === '/notes',
        handler: () => { void flushSave() },
      }),
      registerShortcut({
        id: 'notes-find',
        combo: 'mod+f',
        label: 'Find in note',
        scope: 'page',
        context: () => location.pathname === '/notes' && Boolean(activeNote) && !isEditing(),
        handler: () => { toggleFindBar() },
      }),
      registerShortcut({
        id: 'notes-list-up',
        combo: 'ArrowUp',
        label: 'Previous note',
        scope: 'page',
        context: () => location.pathname === '/notes' && !isEditing(true),
        handler: () => {
          const index = visibleNotes.findIndex((note) => note.id === activeNote?.id)
          const next = visibleNotes[Math.max(0, index - 1)]
          if (next) void handleSelectNote(next.id)
        },
      }),
      registerShortcut({
        id: 'notes-list-down',
        combo: 'ArrowDown',
        label: 'Next note',
        scope: 'page',
        context: () => location.pathname === '/notes' && !isEditing(true),
        handler: () => {
          const index = visibleNotes.findIndex((note) => note.id === activeNote?.id)
          const next = visibleNotes[Math.min(visibleNotes.length - 1, index + 1)]
          if (next) void handleSelectNote(next.id)
        },
      }),
    ]
    return () => unregisters.forEach((unregister) => unregister())
  }, [activeNote, activeNote?.id, handleCreateNote, handleSelectNote, location.pathname, toggleFindBar, visibleNotes])

  useEffect(() => {
    if (location.pathname !== '/notes') return

    const handleEscapeFromEditing = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"]')) return
      if (target?.closest('[data-notes-tag-search="true"]')) return
      if (!isEditing()) return

      event.preventDefault()
      event.stopPropagation()
      ;(document.activeElement as HTMLElement | null)?.blur()
      focusActiveNoteListItem()
    }

    window.addEventListener('keydown', handleEscapeFromEditing, true)
    return () => window.removeEventListener('keydown', handleEscapeFromEditing, true)
  }, [focusActiveNoteListItem, location.pathname])

  const displaySaveStatus = localSaveStatus === 'idle' ? saveStatus : localSaveStatus

  return (
    <div ref={notesContainerRef} className="flex h-full bg-background">
      <aside
        style={{ width: notesListWidth, minWidth: NOTES_LIST_MIN_WIDTH }}
        className="relative flex shrink-0 flex-col border-r border-border bg-card"
      >
        <div
          className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize rounded-l hover:bg-primary/5"
          onMouseDown={handleResizeMouseDown}
        />
        <div className="border-b border-border p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h1 className="text-base font-semibold">Notes</h1>
              <div className="text-xs text-muted-foreground">{notes.length} notes</div>
            </div>
            <button className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={handleCreateNote} title="New note">
              <FilePlus2 className="h-4 w-4" />
            </button>
          </div>
          <ProjectFeatureBoundary label={t('projectShell.tagFilters')} fallback={<div className="space-y-2">
            <p role="alert" className="text-xs text-muted-foreground">{t('projectShell.tagFiltersUnavailable')}</p>
            <input aria-label={t('projectShell.notesSearch')} className="w-full rounded border border-border bg-background p-2 text-sm" placeholder={t('projectShell.searchNoteText')} value={notesSearch.input} onChange={event => updateNotesSearch({ ...notesSearch, input: event.target.value })} />
            {notesSearch.filters.length > 0 && <button type="button" className="text-xs underline" onClick={() => updateNotesSearch({ ...notesSearch, filters: [] })}>{t('projectShell.clearTagFilters')}</button>}
          </div>}><NotesTagSearch value={notesSearch} onChange={updateNotesSearch} /></ProjectFeatureBoundary>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => useNoteStore.setState({ includeArchived: event.target.checked })}
            />
            Archived
          </label>
        </div>
        <div ref={notesListRef} role="region" aria-label="Notes list" tabIndex={-1} className="flex-1 space-y-1 overflow-y-auto p-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40">
          {searchError ? (
            <div role="alert" className="p-4 text-sm text-red-600">{searchError}<button className="ml-2 underline" onClick={() => void loadNotes()}>重试</button></div>
          ) : loading && notes.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">Loading notes...</div>
          ) : visibleNotes.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No notes.</div>
          ) : visibleNotes.map((note) => (
            <button
              key={note.id}
              data-note-id={note.id}
              className={cn(
                'group relative w-full rounded-lg border p-3 text-left transition',
                activeNote?.id === note.id
                  ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/30'
                  : 'border-border bg-card hover:bg-muted/50'
              )}
              onClick={() => void handleSelectNote(note.id)}
            >
              <div className="flex items-start gap-2">
                {note.pinned && <Pin className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />}
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <h4 className="truncate text-sm font-medium">{note.title}</h4>
                  <div className="mt-1 flex items-center gap-2 truncate text-xs text-muted-foreground">
                    <span className="truncate">{note.id}</span>
                    {note.archived && (
                      <>
                        <span>·</span>
                        <span>Archived</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="ml-2 shrink-0 whitespace-nowrap text-xs text-muted-foreground" title={new Date(note.updatedAt).toLocaleString()}>
                  {formatTaskTime(note.updatedAt)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
            {saveConflict && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-[30px] py-2 text-xs text-amber-950 dark:text-amber-100">
                <span>This note changed elsewhere. Your local draft is safe; choose how to resolve it.</span>
                <div className="flex shrink-0 gap-2">
                  <button className="rounded border border-amber-600/40 px-2 py-1 hover:bg-amber-500/10" onClick={() => void handleReloadConflict()}>Reload server version</button>
                  <button className="rounded border border-amber-600/40 px-2 py-1 hover:bg-amber-500/10" onClick={() => void handleKeepConflictCopy()}>Keep as new note</button>
                </div>
              </div>
            )}
            {!activeNote ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select or create a note.
              </div>
            ) : (
              <>
                <FindBar
                  key={activeNote.id}
                  open={showFindBar}
                  onClose={() => { setShowFindBar(false); setFindTokens([]); setFindCurrentMatchIndex(-1) }}
                  containerRef={notesContainerRef}
                  onTokensChange={setFindTokens}
                  onCurrentMatchChange={setFindCurrentMatchIndex}
                />
                <div data-testid="workspace-info-bar" className="flex h-10 shrink-0 items-center justify-between border-b bg-card px-[30px] text-xs text-muted-foreground">
              <div className="flex min-w-0 items-center gap-2">
                <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal">Note</span>
                {activeNote.archived && <span className="rounded border border-border px-1.5 py-0.5 text-[10px]">Archived</span>}
                <span className="truncate">{activeNote.id}</span>
                <span>·</span>
                <span>{displaySaveStatus}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void handleTogglePin()}
                  title={activeNote.pinned ? 'Unpin' : 'Pin'}
                >
                  {activeNote.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                </button>
                <button
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void handleArchiveWrapper()}
                  title={activeNote.archived ? 'Unarchive' : 'Archive'}
                >
                  {activeNote.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {(reviewId || projectNavigation) && activeNote.id === urlNoteId && <ProjectFeatureBoundary resetKey={`${activeNote.id}:${reviewId || ''}`} label={t('project.reviewWorkflow.context')}><ProjectReviewContext key={`${activeNote.id}:${reviewId || ''}`} noteId={activeNote.id} reviewId={reviewId} navigation={projectNavigation} onSave={saveProjectNote} isCurrent={isCurrentProjectNote} dirty={draftDirtyRef.current} currentRevision={draftServerRevisionRef.current} /></ProjectFeatureBoundary>}
            <div className="flex shrink-0 items-start gap-3 border-b border-border bg-background px-[30px] py-2">
	              <input
	                ref={titleInputRef}
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value)
                  draftTitleRef.current = event.target.value
                  scheduleSave({ title: event.target.value })
                }}
                onKeyDown={handleTitleKeyDown}
	                className={`w-full border-b border-primary bg-transparent text-xl font-bold outline-none ${jumpHighlightTitle ? 'rounded bg-primary/10 ring-1 ring-primary animate-highlight-flash' : ''}`}
                placeholder="Untitled note"
              />
            </div>
            <div className="px-[30px] pb-2"><ProjectFeatureBoundary resetKey={activeNote.id} label={t('projectShell.references')}><ProjectRelations key={activeNote.id} sourceType="note" sourceId={activeNote.id} /></ProjectFeatureBoundary></div>
            {linkedTasks.length > 0 && (
              <div className="px-[30px] pb-2">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 text-xs">
                  <span className="font-semibold uppercase tracking-normal text-muted-foreground">Linked tasks</span>
                  {linkedTasks.map((task) => (
                    <button
                      key={task.id}
                      className="inline-flex max-w-60 items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground hover:bg-primary/10"
                      onClick={async () => {
                        navigate('/')
                        await setTaskActive(task.id)
                      }}
                    >
                      <ListTodo className="h-3 w-3 shrink-0" />
                      <span className="truncate">{task.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <section className="min-h-0 flex-1 overflow-y-auto px-[30px] pb-[10px]">
              <div className="space-y-3 pt-2">
                <RichEditor
                  key={activeNote.id}
                  content={draftContent}
                  onChange={(html) => {
                    const normalized = stripLeadingEmptyParagraphs(html)
                    setDraftContent(normalized)
                    scheduleSave({ contentHtml: normalized, tags: parsedTags })
                  }}
                  placeholder="Write a long-term note..."
                  minHeight="calc(100vh - 210px)"
                  taskId={activeNote.id}
                  taskMentionTasks={tasks}
                  searchTokens={jumpHighlightTokens.length ? jumpHighlightTokens : findTokens}
                  searchCurrentMatchIndex={jumpHighlightTokens.length ? -1 : findCurrentMatchIndex}
                  searchScrollKey={jumpScrollKey}
                />
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
