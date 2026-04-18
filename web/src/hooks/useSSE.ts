import { useEffect, useRef, useState } from 'react'
import { useTaskStore } from '@/stores/taskStore'
import { clientId, isTauriEnv, apiBase, ensureApiReady } from '@/services/httpApi'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

let globalState: ConnectionState = 'disconnected'
let globalUrl = ''
let globalError: string | null = null

export function getConnectionState(): ConnectionState {
  return globalState
}

export function getConnectionInfo(): { url: string; state: ConnectionState; error: string | null } {
  return { url: globalUrl, state: globalState, error: globalError }
}

async function getEventUrl(): Promise<string> {
  // Always use relative path - Tauri's custom protocol handler
  // routes tauri://localhost/api/* to the actual server
  return `/api/events?clientId=${encodeURIComponent(clientId)}`
}

function createFetchSSE(
  url: string,
  handlers: Record<string, (data: string) => void>,
  onConnected: () => void,
  onError: (error: string) => void,
): AbortController {
  const controller = new AbortController()

  ;(async () => {
    let retryCount = 0
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Client-Id': clientId,
          },
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`SSE HTTP ${response.status}`)
        }

        retryCount = 0
        onConnected()

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('ReadableStream not supported')
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (controller.signal.aborted) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let currentEvent = 'message'
          let currentData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6)
            } else if (line === '') {
              if (currentData) {
                const handler = handlers[currentEvent] || handlers['message']
                if (handler) handler(currentData)
                currentEvent = 'message'
                currentData = ''
              }
            }
          }
        }
      } catch (err: any) {
        if (controller.signal.aborted) return
        const errorMsg = err.message || String(err)
        console.error('[SSE] Connection error:', errorMsg, err)
        onError(errorMsg)

        const delay = Math.min(1000 * 2 ** retryCount, 30000)
        retryCount++
        console.log('[SSE] Reconnecting in', delay, 'ms')

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          const checkAbort = () => {
            if (controller.signal.aborted) {
              clearTimeout(timer)
              resolve()
            }
          }
          const interval = setInterval(checkAbort, 100)
          timer.finally(() => clearInterval(interval))
        })
      }
    }
  })()

  return controller
}

export function useSSE() {
  const [state, setState] = useState<ConnectionState>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  const loadTodos = useTaskStore((s) => s.loadTodos)
  const setActiveTask = useTaskStore((s) => s.setActiveTask)
  const loadCurrentSession = useTaskStore((s) => s.loadCurrentSession)

  const activeTaskIdRef = useRef(activeTaskId)
  const sseRef = useRef<AbortController | null>(null)
  const retryRef = useRef(0)

  activeTaskIdRef.current = activeTaskId

  useEffect(() => {
    let destroyed = false

    async function connect() {
      if (destroyed) return
      setState('connecting')
      globalState = 'connecting'
      setError(null)
      globalError = null

      const resolvedUrl = await getEventUrl()
      if (destroyed) return
      setUrl(resolvedUrl)
      globalUrl = resolvedUrl

      console.log('[SSE] Connecting to:', resolvedUrl)

      const handlers: Record<string, (data: string) => void> = {
        task_created: () => {
          console.log('[SSE] task_created, calling loadTodos')
          loadTodos()
          if (activeTaskIdRef.current) setActiveTask(activeTaskIdRef.current)
        },
        task_updated: () => {
          console.log('[SSE] task_updated, calling loadTodos')
          loadTodos()
          if (activeTaskIdRef.current) setActiveTask(activeTaskIdRef.current)
        },
        task_deleted: () => {
          console.log('[SSE] task_deleted, calling loadTodos')
          loadTodos()
        },
        entry_created: () => {
          console.log('[SSE] entry_created')
          if (activeTaskIdRef.current) setActiveTask(activeTaskIdRef.current)
        },
        entry_updated: () => {
          console.log('[SSE] entry_updated')
          if (activeTaskIdRef.current) setActiveTask(activeTaskIdRef.current)
        },
        session_started: () => {
          console.log('[SSE] session_started')
          loadCurrentSession()
        },
        session_ended: () => {
          console.log('[SSE] session_ended')
          loadCurrentSession()
        },
        db_imported: () => {
          console.log('[SSE] db_imported')
          loadTodos()
          loadCurrentSession()
          if (activeTaskIdRef.current) setActiveTask(activeTaskIdRef.current)
        },
      }

      sseRef.current = createFetchSSE(
        resolvedUrl,
        handlers,
        () => {
          if (destroyed) return
          console.log('[SSE] Connected')
          setState('connected')
          globalState = 'connected'
          setError(null)
          globalError = null
          retryRef.current = 0
        },
        (errMsg) => {
          if (destroyed) return
          console.log('[SSE] Reconnecting')
          setState('reconnecting')
          globalState = 'reconnecting'
          setError(errMsg)
          globalError = errMsg
        },
      )
    }

    connect()

    return () => {
      console.log('[SSE] Cleaning up connection')
      destroyed = true
      sseRef.current?.abort()
      sseRef.current = null
    }
  }, []) // Empty deps — store actions are stable in Zustand

  return { state, url, error }
}
