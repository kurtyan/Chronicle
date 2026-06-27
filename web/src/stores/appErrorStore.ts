import { create } from 'zustand'

export const APP_ERROR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const APP_ERROR_TOAST_TTL_MS = 3000
export const APP_ERROR_MAX_TOASTS = 5
const APP_ERRORS_STORAGE_KEY = 'chronicle:app_errors'

export interface AppErrorRecord {
  id: string
  endpoint: string
  message: string
  stack: string
  createdAt: number
}

export interface AppErrorToast {
  id: string
  errorId: string
  endpoint: string
  message: string
  createdAt: number
}

interface AppErrorState {
  errors: AppErrorRecord[]
  toasts: AppErrorToast[]
  panelOpen: boolean
  recordError: (input: { endpoint: string; message: string; stack?: string }) => AppErrorRecord
  dismissError: (id: string) => void
  clearErrors: () => void
  removeToast: (id: string) => void
  setPanelOpen: (open: boolean) => void
}

function nowId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `err-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function prune(errors: AppErrorRecord[], now = Date.now()): AppErrorRecord[] {
  return errors
    .filter((error) => now - error.createdAt < APP_ERROR_RETENTION_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function loadStoredErrors(): AppErrorRecord[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(APP_ERRORS_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return prune(parsed.filter((item): item is AppErrorRecord =>
      typeof item?.id === 'string'
      && typeof item.endpoint === 'string'
      && typeof item.message === 'string'
      && typeof item.stack === 'string'
      && typeof item.createdAt === 'number'
    ))
  } catch {
    return []
  }
}

function saveStoredErrors(errors: AppErrorRecord[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(APP_ERRORS_STORAGE_KEY, JSON.stringify(prune(errors)))
}

function addToast(toasts: AppErrorToast[], toast: AppErrorToast): AppErrorToast[] {
  const now = Date.now()
  return [toast, ...toasts.filter((item) => now - item.createdAt < APP_ERROR_TOAST_TTL_MS)]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, APP_ERROR_MAX_TOASTS)
}

export const useAppErrorStore = create<AppErrorState>((set) => ({
  errors: loadStoredErrors(),
  toasts: [],
  panelOpen: false,

  recordError: (input) => {
    const error: AppErrorRecord = {
      id: nowId(),
      endpoint: input.endpoint,
      message: input.message || 'Unknown error',
      stack: input.stack || '',
      createdAt: Date.now(),
    }
    set((state) => {
      const errors = prune([error, ...state.errors])
      saveStoredErrors(errors)
      return {
        errors,
        toasts: addToast(state.toasts, {
          id: `${error.id}:toast`,
          errorId: error.id,
          endpoint: error.endpoint,
          message: error.message,
          createdAt: error.createdAt,
        }),
      }
    })
    return error
  },

  dismissError: (id) => set((state) => {
    const errors = state.errors.filter((error) => error.id !== id)
    saveStoredErrors(errors)
    return {
      errors,
      toasts: state.toasts.filter((toast) => toast.errorId !== id),
    }
  }),

  clearErrors: () => {
    saveStoredErrors([])
    set({ errors: [], toasts: [] })
  },

  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  setPanelOpen: (open) => set({ panelOpen: open }),
}))

export function recordAppError(input: { endpoint: string; message: string; stack?: string }): AppErrorRecord {
  return useAppErrorStore.getState().recordError(input)
}
