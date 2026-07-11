import { create } from 'zustand'
import type { Note, Task, UpdateNoteRequest } from '@/types'
import * as api from '@/services/api'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface NoteState {
  notes: Note[]
  activeNote: Note | null
  linkedTasks: Task[]
  loading: boolean
  saveStatus: SaveStatus
  error: string | null
  includeArchived: boolean
  loadNotes: (options?: { includeArchived?: boolean; query?: string }) => Promise<Note[]>
  setActiveNote: (id: string | null) => Promise<void>
  createNote: (data?: { title?: string; contentHtml?: string; tags?: string[]; linkedTaskIds?: string[] }) => Promise<Note>
  updateActiveNote: (data: UpdateNoteRequest) => Promise<Note | null>
  archiveActiveNote: () => Promise<void>
  unarchiveActiveNote: () => Promise<void>
  loadLinkedTasks: (noteId: string) => Promise<Task[]>
}

export const useNoteStore = create<NoteState>((set, get) => ({
  notes: [],
  activeNote: null,
  linkedTasks: [],
  loading: false,
  saveStatus: 'idle',
  error: null,
  includeArchived: false,

  loadNotes: async (options) => {
    const includeArchived = options?.includeArchived ?? get().includeArchived
    set({ loading: true, error: null, includeArchived })
    try {
      const notes = await api.fetchNotes({ includeArchived, query: options?.query, limit: 300 })
      set({ notes, loading: false, includeArchived })
      return notes
    } catch (error: any) {
      set({ error: error?.message || 'Failed to load notes', loading: false })
      return []
    }
  },

  setActiveNote: async (id) => {
    if (!id) {
      set({ activeNote: null, linkedTasks: [] })
      return
    }
    const existing = get().notes.find((note) => note.id === id)
    set({ activeNote: existing ?? null })
    const note = await api.getNoteById(id)
    if (!note) {
      if (get().activeNote?.id === id) set({ activeNote: null, linkedTasks: [] })
      return
    }
    if (!get().activeNote || get().activeNote?.id === id) {
      set({ activeNote: note })
      await get().loadLinkedTasks(note.id)
    }
  },

  createNote: async (data) => {
    const note = await api.createNote({
      title: data?.title || 'Untitled note',
      contentHtml: data?.contentHtml || '<p></p>',
      tags: data?.tags || [],
      linkedTaskIds: data?.linkedTaskIds || [],
    })
    set((state) => ({ notes: [note, ...state.notes], activeNote: note, linkedTasks: [] }))
    return note
  },

  updateActiveNote: async (data) => {
    const active = get().activeNote
    if (!active) return null
    set({ saveStatus: 'saving' })
    try {
      const note = await api.updateNote(active.id, data)
      if (!note) {
        set({ saveStatus: 'error' })
        return null
      }
      set((state) => ({
        activeNote: note,
        notes: state.notes.map((item) => item.id === note.id ? note : item),
        saveStatus: 'saved',
      }))
      await get().loadLinkedTasks(note.id)
      return note
    } catch (error: any) {
      set({ saveStatus: 'error', error: error?.message || 'Failed to save note' })
      return null
    }
  },

  archiveActiveNote: async () => {
    const active = get().activeNote
    if (!active) return
    const note = await api.archiveNote(active.id)
    set((state) => ({
      activeNote: note,
      notes: state.notes.filter((item) => item.id !== active.id),
    }))
  },

  unarchiveActiveNote: async () => {
    const active = get().activeNote
    if (!active) return
    const note = await api.unarchiveNote(active.id)
    if (note) set((state) => ({ activeNote: note, notes: [note, ...state.notes.filter((item) => item.id !== note.id)] }))
  },

  loadLinkedTasks: async (noteId) => {
    const linkedTasks = await api.fetchNoteTasks(noteId)
    set({ linkedTasks })
    return linkedTasks
  },
}))
