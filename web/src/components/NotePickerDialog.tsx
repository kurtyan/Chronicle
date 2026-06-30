import { useEffect, useState } from 'react'
import { FilePlus2, Search } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Note } from '@/types'
import { createNote, fetchNotes } from '@/services/api'

interface NotePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (note: Note) => Promise<void> | void
  defaultTitle?: string
}

export function NotePickerDialog({ open, onOpenChange, onPick, defaultTitle = 'Untitled note' }: NotePickerDialogProps) {
  const [notes, setNotes] = useState<Note[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      fetchNotes({ query: query.trim() || undefined, limit: 200 })
        .then((next) => { if (!cancelled) setNotes(next) })
        .catch(() => { if (!cancelled) setNotes([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, query.trim() ? 180 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setNotes([])
  }, [open])

  async function choose(note: Note) {
    setSubmitting(true)
    try {
      await onPick(note)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  async function createAndChoose() {
    setSubmitting(true)
    try {
      const note = await createNote({ title: query.trim() || defaultTitle, contentHtml: '<p></p>' })
      await onPick(note)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to note</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-border px-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes..."
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading notes...</div>
            ) : notes.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No matching notes.</div>
            ) : (
              notes.map((note) => (
                <button
                  key={note.id}
                  className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted"
                  onClick={() => choose(note)}
                  disabled={submitting}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{note.title}</span>
                    <span className="block text-xs text-muted-foreground">{note.id}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <button className="dialog-button-secondary" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</button>
          <button className="dialog-button-primary inline-flex items-center gap-2" onClick={createAndChoose} disabled={submitting}>
            <FilePlus2 className="h-4 w-4" />
            New note
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
