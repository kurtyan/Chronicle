import { create } from 'zustand'
import type { CreateTaskRequest } from '@/types'
import type { WorkOutline } from '../../../shared/workOutlineTypes'
import { workOutlineApi, outlineError, type OutlineDocument, type CreateOutlineTaskResult } from '@/services/workOutlineApi'
import { bindOutlineTask, normalizeOutlineDocument, outlineTaskId } from '@/lib/workOutline'
import { translateCurrent as tr } from '@/i18n/runtime'

interface OutlineState {
  outline: WorkOutline | null
  document: OutlineDocument | null
  status: 'loading' | 'saved' | 'saving' | 'error' | 'conflict'
  error: string
  dirty: boolean
  remote: WorkOutline | null
  creating: boolean
  load: () => Promise<void>
  edit: (document: OutlineDocument) => void
  save: () => Promise<void>
  checkRemote: () => Promise<void>
  reloadRemote: () => Promise<void>
  keepLocal: () => Promise<void>
  createLinkedTask: (rowId: string, task: CreateTaskRequest, idempotencyKey: string) => Promise<CreateOutlineTaskResult & { linked: boolean }>
  /** Gives up an unconfirmed creation request so autosave resumes; a lost server-side success surfaces as a version conflict. */
  abandonCreation: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let saveFlight: Promise<void> | null = null
let loadFlight: Promise<void> | null = null
let createFlight: Promise<CreateOutlineTaskResult & { linked: boolean }> | null = null
let activeCreateKey: string | null = null
let editVersion = 0
let paused = false
let pendingSave: { document: OutlineDocument; expectedRevision: number; expectedEpoch: string; mutationId: string; version: number } | null = null
const recoveryKey = (id: string) => `chronicle:work_outline:${id}`
const creationKey = 'chronicle:work_outline:pending_creation'
function readCache(key: string) { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
function cache(key: string, value: unknown) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)) } catch { /* The in-memory draft remains usable. */ } }
function remember() {
  const state = useWorkOutlineStore.getState()
  if (state.outline && state.document) cache(recoveryKey(state.outline.id), state.dirty ? {
    document: state.document, baseRevision: state.outline.revision, baseEpoch: state.outline.epoch, pendingSave,
  } : null)
}
function schedule() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void useWorkOutlineStore.getState().save().catch(() => {}) }, 800)
}

export const useWorkOutlineStore = create<OutlineState>((set, get) => ({
  outline: null, document: null, status: 'loading', error: '', dirty: false, remote: null, creating: false,
  load: async () => {
    if (loadFlight) return loadFlight
    loadFlight = (async () => {
      try {
        const outline = await workOutlineApi.load()
        if (get().outline && get().dirty) return get().checkRemote()
        const restored = readCache(recoveryKey(outline.id))
        const pendingCreation = readCache(creationKey)
        if (pendingCreation && pendingCreation.expectedEpoch !== outline.epoch) cache(creationKey, null)
        paused = !!readCache(creationKey)
        const document = restored?.document ? normalizeOutlineDocument(restored.document) : outline.document
        const dirty = !!restored?.document && JSON.stringify(document) !== JSON.stringify(outline.document)
        const replaced = !!restored?.document && restored.baseEpoch !== outline.epoch
        pendingSave = replaced ? null : restored?.pendingSave ?? null
        if (pendingSave) pendingSave.version = ++editVersion
        // A lost acknowledged write is reconciled through its persisted mutation ID.
        const conflict = dirty && (replaced || restored.baseRevision !== outline.revision && !pendingSave)
        set({ outline: dirty ? { ...outline, revision: restored.baseRevision, epoch: restored.baseEpoch } : outline, document, dirty, status: conflict ? 'conflict' : 'saved', remote: conflict ? outline : null, error: replaced ? tr('outline.error.replaced') : '' })
        if (dirty && !conflict) schedule()
      } catch (error) { set({ status: 'error', error: outlineError(error) }) }
    })().finally(() => { loadFlight = null })
    return loadFlight
  },
  edit: (document) => {
    editVersion++
    set({ document, dirty: true, status: get().status === 'conflict' ? 'conflict' : 'saving' })
    remember()
    if (get().status !== 'conflict') schedule()
  },
  save: async () => {
    if (saveTimer) clearTimeout(saveTimer)
    if (paused) return
    if (get().status === 'conflict') throw new Error(tr('outline.error.conflict'))
    if (saveFlight) return saveFlight
    saveFlight = Promise.resolve().then(async () => {
      while (get().dirty && !paused) {
        const state = get()
        if (!state.outline || !state.document) return
        pendingSave ??= { document: state.document, expectedRevision: state.outline.revision, expectedEpoch: state.outline.epoch, mutationId: crypto.randomUUID(), version: editVersion }
        remember()
        const request = pendingSave
        set({ status: 'saving', error: '' })
        try {
          const saved = await workOutlineApi.save(state.outline.id, request.document, request.expectedRevision, request.mutationId, request.expectedEpoch)
          pendingSave = null
          const unchanged = request.version === editVersion && JSON.stringify(get().document) === JSON.stringify(request.document)
          set({ outline: { ...state.outline, document: request.document, revision: saved.revision, updatedAt: saved.updatedAt }, dirty: !unchanged, status: unchanged ? 'saved' : 'saving' })
          remember()
        } catch (error) {
          const conflict = (error as { response?: { status?: number } }).response?.status === 409
          if (conflict) pendingSave = null
          set({ status: conflict ? 'conflict' : 'error', error: outlineError(error), dirty: true })
          remember()
          if (conflict) {
            try { set({ remote: await workOutlineApi.load() }) } catch { /* retain the local copy */ }
          }
          throw error
        }
      }
    }).finally(() => {
      saveFlight = null
      // An SSE invalidation can arrive while a receipt is replaying. Check the
      // authoritative revision once the local queue is clean, so it is not lost.
      if (!get().dirty && !paused) queueMicrotask(() => { void get().checkRemote() })
    })
    return saveFlight
  },
  checkRemote: async () => {
    if (saveFlight || createFlight) return
    const requestedRevision = get().outline?.revision
    const requestedEpoch = get().outline?.epoch
    const requestedVersion = editVersion
    try {
      const remote = await workOutlineApi.load()
      const state = get()
      if (saveFlight || createFlight || !state.outline || remote.epoch === state.outline.epoch && remote.revision <= state.outline.revision) return
      if (state.outline.revision !== requestedRevision || state.outline.epoch !== requestedEpoch || editVersion !== requestedVersion) return
      const replaced = remote.epoch !== state.outline.epoch
      if (replaced) {
        pendingSave = null
        cache(creationKey, null)
        paused = false
      }
      if (state.dirty) { set({ remote, status: 'conflict', error: replaced ? tr('outline.error.replaced') : '' }); remember() }
      else set({ outline: remote, document: remote.document, status: 'saved', error: '' })
    } catch { /* transient refresh errors do not discard a working document */ }
  },
  reloadRemote: async () => {
    const remote = await workOutlineApi.load()
    pendingSave = null
    editVersion++
    set({ outline: remote, document: remote.document, dirty: false, remote: null, status: 'saved', error: '' })
    remember()
  },
  keepLocal: async () => {
    const remote = await workOutlineApi.load()
    pendingSave = null
    set({ outline: remote, remote: null, dirty: true, status: 'saving', error: '' })
    remember()
    await get().save()
  },
  createLinkedTask: async (rowId, task, idempotencyKey) => {
    if (createFlight) {
      if (activeCreateKey !== idempotencyKey) throw new Error(tr('outline.error.recoverCreation'))
      return createFlight
    }
    const existingCreation = readCache(creationKey)
    if (existingCreation && existingCreation.idempotencyKey !== idempotencyKey) throw new Error(tr('outline.error.recoverCreation'))
    activeCreateKey = idempotencyKey
    createFlight = (async () => {
      set({ creating: true })
      try {
        const cached = readCache(creationKey)
        const recovery = cached?.idempotencyKey === idempotencyKey ? cached : null
        // Recover an uncertain committed request before any ordinary PUT: the
        // server may already have advanced the outline revision for this task.
        if (!recovery) await get().save()
        const state = get()
        if (!state.outline || !state.document) throw new Error(tr('outline.error.notLoaded'))
        const row = state.document.content.find(line => line.attrs.id === rowId)
        if (!recovery && (!row || outlineTaskId(row))) throw new Error(tr('outline.error.rowGone'))
        paused = true
        const request = recovery ?? {
          outlineId: state.outline.id, rowId, task, expectedRevision: state.outline.revision, expectedEpoch: state.outline.epoch, idempotencyKey,
        }
        cache(creationKey, request)
        const result = await workOutlineApi.createTask(request.outlineId, request.rowId, request.task, request.expectedRevision, request.idempotencyKey, request.expectedEpoch)
        cache(creationKey, null)
        const current = get().document!
        const target = current.content.find(line => line.attrs.id === rowId)
        const linked = !!target && (!outlineTaskId(target) || outlineTaskId(target) === result.task.id)
        const document = linked && !outlineTaskId(target!) ? bindOutlineTask(current, rowId, result.task.id, result.task.title) : current
        editVersion++
        pendingSave = null
        set({ document, outline: { ...state.outline, revision: Math.max(state.outline.revision, result.outlineRevision), updatedAt: result.updatedAt }, dirty: true, status: 'saving', remote: null, error: '' })
        remember()
        return { ...result, linked }
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status
        if (status && status >= 400 && status < 500) cache(creationKey, null)
        if (status === 409) {
          try { set({ remote: await workOutlineApi.load(), status: 'conflict' }) } catch { /* keep draft */ }
        }
        throw error
      } finally {
        paused = !!readCache(creationKey)
        set({ creating: false })
        if (!paused && get().dirty && get().status !== 'conflict') schedule()
      }
    })().finally(() => { createFlight = null; activeCreateKey = null })
    return createFlight
  },
  abandonCreation: () => {
    if (createFlight) return
    cache(creationKey, null)
    paused = false
    set({ error: '' })
    if (get().dirty && get().status !== 'conflict') schedule()
    void get().checkRemote()
  },
}))

export function pendingOutlineCreation(): { rowId: string; task: CreateTaskRequest; idempotencyKey: string } | null {
  return readCache(creationKey)
}
