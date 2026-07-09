import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, FilePlus2, FileText, ListTodo, Pin, PinOff, Search } from 'lucide-react'
import { RichEditor } from '@/components/RichEditor'
import { registerShortcut } from '@/shortcuts/registry'
import { useNoteStore } from '@/stores/noteStore'
import { useTaskStore } from '@/stores/taskStore'
import * as api from '@/services/api'
import { cn } from '@/lib/utils'
import { formatTaskTime } from '@/lib/time'
import { consumeSearchJumpIntent } from '@/lib/searchJump'
import type { Note } from '@/types'

const NOTES_LIST_PERCENT_KEY = 'chronicle_notes_list_pct'
const NOTES_LIST_MIN_WIDTH = 180
const NOTES_DETAIL_MIN_WIDTH = 320

function isEditing(): boolean {
  const active = document.activeElement as HTMLElement | null
  if (!active) return false
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || Boolean(active.closest('[data-rich-editor="true"]'))
}

function stripLeadingEmptyParagraphs(html: string): string {
  return html.replace(/^(?:\s*<p(?:\s[^>]*)?>(?:\s|&nbsp;|<br\s*\/?>|<br[^>]*>)<\/p>)+/i, '')
}

export function NotesPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    notes, activeNote, linkedTasks, loading, saveStatus, includeArchived,
    loadNotes, setActiveNote, createNote, updateActiveNote, archiveActiveNote, unarchiveActiveNote,
  } = useNoteStore()
  const tasks = useTaskStore((state) => state.tasks)
  const loadTodos = useTaskStore((state) => state.loadTodos)
  const setTaskActive = useTaskStore((state) => state.setActiveTask)
  const [query, setQuery] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [jumpHighlightTokens, setJumpHighlightTokens] = useState<string[]>([])
  const [jumpHighlightTitle, setJumpHighlightTitle] = useState(false)
  const [jumpScrollKey, setJumpScrollKey] = useState(0)
  const [jumpSignal, setJumpSignal] = useState(0)
  const [localSaveStatus, setLocalSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [notesListWidth, setNotesListWidth] = useState(() => {
    const saved = localStorage.getItem(NOTES_LIST_PERCENT_KEY)
    const pct = saved ? parseFloat(saved) : 0.3
    return Math.round(window.innerWidth * pct)
  })
  const notesContainerRef = useRef<HTMLDivElement | null>(null)
  const isResizingRef = useRef(false)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(0)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const latestDraftRef = useRef({ title: '', contentHtml: '', tags: [] as string[] })
  const activeNoteIdRef = useRef<string | null>(null)
  const draftNoteIdRef = useRef<string | null>(null)
  const draftTitleRef = useRef('')
  const draftTagsRef = useRef('')
  const flushSaveRef = useRef<() => Promise<void>>(async () => {})
  const noteSwitchRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    draftTitleRef.current = draftTitle
  }, [draftTitle])

  useEffect(() => {
    draftTagsRef.current = draftTags
  }, [draftTags])

  useEffect(() => {
    void loadNotes()
    void loadTodos()
  }, [loadNotes, loadTodos])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadNotes({ includeArchived, query: query.trim() || undefined })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [includeArchived, loadNotes, query])

  useEffect(() => {
    const id = new URLSearchParams(location.search).get('id')
    if (id) void setActiveNote(id)
  }, [location.search, setActiveNote])

  useEffect(() => {
    const handler = () => setJumpSignal((value) => value + 1)
    window.addEventListener('chronicle:search-jump', handler)
    return () => window.removeEventListener('chronicle:search-jump', handler)
  }, [])

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
      return
    }
    activeNoteIdRef.current = note.id
    draftNoteIdRef.current = note.id
    const stored = localStorage.getItem(`chronicle:note_draft:${note.id}`)
    let restored: { title?: string; contentHtml?: string; tags?: string[] } | null = null
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
    setLocalSaveStatus(restored ? 'error' : 'idle')
  }, [])

  useEffect(() => {
    applyNoteDraft(activeNote)
  }, [activeNote?.id, jumpSignal])

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
  }, [activeNote?.id])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      void flushSaveRef.current()
    }
  }, [])

  const visibleNotes = useMemo(() => {
    return notes
  }, [notes])

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
    if (!noteId) return
    const item = document.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`) as HTMLButtonElement | null
    item?.focus()
  }, [])

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
    latestDraftRef.current = {
      title: next.title ?? latestDraftRef.current.title,
      contentHtml: next.contentHtml ?? latestDraftRef.current.contentHtml,
      tags: next.tags ?? latestDraftRef.current.tags,
    }
    setLocalSaveStatus('saving')
    localStorage.setItem(`chronicle:note_draft:${noteId}`, JSON.stringify(latestDraftRef.current))
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => { void flushSave() }, 800)
  }

  async function flushSave() {
    const noteId = draftNoteIdRef.current
    if (!noteId) return
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setLocalSaveStatus('saving')
    const liveDraft = {
      title: draftTitleRef.current || latestDraftRef.current.title,
      contentHtml: stripLeadingEmptyParagraphs(latestDraftRef.current.contentHtml),
      tags: draftTagsRef.current.split(',').map((tag) => tag.trim()).filter(Boolean),
    }
    latestDraftRef.current = liveDraft
    localStorage.setItem(`chronicle:note_draft:${noteId}`, JSON.stringify(liveDraft))
    const saved = useNoteStore.getState().activeNote?.id === noteId
      ? await updateActiveNote(liveDraft)
      : await api.updateNote(noteId, liveDraft)
    if (saved) {
      localStorage.removeItem(`chronicle:note_draft:${saved.id}`)
      setLocalSaveStatus('saved')
    } else {
      setLocalSaveStatus('error')
    }
  }

  useEffect(() => {
    flushSaveRef.current = flushSave
  })

  async function handleCreateNote() {
    const run = noteSwitchRef.current.then(async () => {
      await flushSave()
      const note = await createNote({ title: 'Untitled note' })
      navigate(`/notes?id=${encodeURIComponent(note.id)}`)
      applyNoteDraft(note)
    })
    noteSwitchRef.current = run.catch(() => {})
    await run
  }

  async function handleSelectNote(id: string) {
    const run = noteSwitchRef.current.then(async () => {
      await flushSave()
      navigate(`/notes?id=${encodeURIComponent(id)}`)
      await setActiveNote(id)
      const next = useNoteStore.getState().activeNote
      if (next?.id === id) applyNoteDraft(next)
    })
    noteSwitchRef.current = run.catch(() => {})
    await run
  }

  async function handleArchive() {
    if (!activeNote) return
    await flushSave()
    if (activeNote.archived) await unarchiveActiveNote()
    else await archiveActiveNote()
    await loadNotes({ includeArchived, query: query.trim() || undefined })
  }

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
        id: 'notes-focus-editor',
        combo: 'ArrowRight',
        label: 'Focus note editor',
        scope: 'page',
        context: () => location.pathname === '/notes' && Boolean(activeNote) && !isEditing(),
        handler: focusEditor,
      }),
      registerShortcut({
        id: 'notes-list-up',
        combo: 'ArrowUp',
        label: 'Previous note',
        scope: 'page',
        context: () => location.pathname === '/notes' && !isEditing(),
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
        context: () => location.pathname === '/notes' && !isEditing(),
        handler: () => {
          const index = visibleNotes.findIndex((note) => note.id === activeNote?.id)
          const next = visibleNotes[Math.min(visibleNotes.length - 1, index + 1)]
          if (next) void handleSelectNote(next.id)
        },
      }),
    ]
    return () => unregisters.forEach((unregister) => unregister())
  }, [activeNote, activeNote?.id, focusEditor, location.pathname, visibleNotes])

  useEffect(() => {
    if (location.pathname !== '/notes') return

    const handleEscapeFromEditing = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"]')) return
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
          <div className="flex items-center gap-2 rounded-md border border-border px-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder="Search notes..."
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => void loadNotes({ includeArchived: event.target.checked, query: query.trim() || undefined })}
            />
            Archived
          </label>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {loading && notes.length === 0 ? (
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
        {!activeNote ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select or create a note.
          </div>
        ) : (
          <>
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
                  onClick={() => void updateActiveNote({ pinned: !activeNote.pinned })}
                  title={activeNote.pinned ? 'Unpin' : 'Pin'}
                >
                  {activeNote.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                </button>
                <button
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void handleArchive()}
                  title={activeNote.archived ? 'Unarchive' : 'Archive'}
                >
                  {activeNote.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="flex shrink-0 items-start gap-3 border-b border-border bg-background px-[30px] py-2">
	              <input
	                ref={titleInputRef}
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value)
                  scheduleSave({ title: event.target.value })
                }}
                onKeyDown={handleTitleKeyDown}
	                className={`w-full border-b border-primary bg-transparent text-xl font-bold outline-none ${jumpHighlightTitle ? 'rounded bg-primary/10 ring-1 ring-primary animate-highlight-flash' : ''}`}
                placeholder="Untitled note"
              />
            </div>
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
	                  searchTokens={jumpHighlightTokens}
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
