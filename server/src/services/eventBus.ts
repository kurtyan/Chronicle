type Listener = (data: string) => void

let listeners: Set<Listener> = new Set()

export function broadcastEvent(event: string, data: unknown, source?: string) {
  const payload = JSON.stringify({ event, data, source })
  console.log(`[SSE broadcast] ${event} (source: ${source || '-'}) → ${listeners.size} listener(s)`)
  for (const fn of listeners) {
    fn(payload)
  }
}

export function createSSEStream(clientId: string): ReadableStream {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController | null = null
  let closed = false
  let needsResync = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let listener: Listener | null = null

  const cleanup = () => {
    if (closed) return
    closed = true
    if (listener) listeners.delete(listener)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }

  const enqueue = (message: string) => {
    if (!controller || closed) return
    // Do not let a paused browser connection create an unbounded in-memory
    // event history. Its next readable slot receives one resync signal instead.
    if (controller.desiredSize !== null && controller.desiredSize <= 0) {
      needsResync = true
      return
    }
    try {
      if (needsResync) {
        controller.enqueue(encoder.encode(`event: resync\ndata: {"reason":"backpressure"}\n\n`))
        needsResync = false
      }
      controller.enqueue(encoder.encode(message))
    } catch {
      cleanup()
    }
  }

  listener = (payload: string) => {
    const parsed = JSON.parse(payload)
    if (parsed.source === clientId) return
    const sseMessage = `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`
    enqueue(sseMessage)
  }

  heartbeatTimer = setInterval(() => {
    enqueue(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`)
  }, 5000)

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl
      if (listener) listeners.add(listener)
    },
    pull() {
      // A heartbeat will normally deliver this within five seconds. Flush a
      // missed-event marker immediately when the browser becomes readable.
      if (needsResync) enqueue(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`)
    },
    cancel() {
      cleanup()
    },
  })

  return stream
}
