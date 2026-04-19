type Listener = (data: string) => void

let listeners: Set<Listener> = new Set()

export function broadcastEvent(event: string, data: unknown, source?: string) {
  const payload = JSON.stringify({ event, data, source })
  for (const fn of listeners) {
    fn(payload)
  }
}

export function createSSEStream(clientId: string): ReadableStream {
  const encoder = new TextEncoder()
  const queue: string[] = []
  let controller: ReadableStreamDefaultController

  const listener = (payload: string) => {
    const parsed = JSON.parse(payload)
    if (parsed.source === clientId) return
    const sseMessage = `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`
    queue.push(sseMessage)
    controller?.enqueue(encoder.encode(sseMessage))
  }

  const heartbeatTimer = setInterval(() => {
    try {
      const hbMessage = `event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`
      queue.push(hbMessage)
      controller?.enqueue(encoder.encode(hbMessage))
    } catch { /* stream may be closed */ }
  }, 5000)

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl
      listeners.add(listener)
    },
    cancel() {
      listeners.delete(listener)
      clearInterval(heartbeatTimer)
    },
  })

  return stream
}
