import { useState, useEffect, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useI18n } from '@/i18n/context'

interface AutoAfkDialogProps {
  open: boolean
  reason: string
  triggeredAt: number
  onClose: () => void
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function AutoAfkDialog({ open, reason, triggeredAt, onClose }: AutoAfkDialogProps) {
  const { t } = useI18n()
  const [elapsed, setElapsed] = useState(0)
  const [userNote, setUserNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (open) {
      setUserNote('')
      setElapsed(0)
      setSubmitting(false)
      intervalRef.current = setInterval(() => {
        setElapsed(Date.now() - triggeredAt)
      }, 1000)
      setElapsed(Date.now() - triggeredAt)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [open, triggeredAt])

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const { createAfkEvent } = await import('@/services/api')
      await createAfkEvent(reason, triggeredAt, userNote.trim() || undefined)
    } catch (err) {
      console.error('Failed to submit AFK event:', err)
    } finally {
      setSubmitting(false)
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="text-amber-500">⏸</span>
            AutoAFK
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Timer */}
          <div className="text-center">
            <div className="text-4xl font-mono font-bold tabular-nums">
              {formatElapsed(elapsed)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {t('afk.timeaway')}
            </div>
          </div>

          {/* Reason */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('afk.reason')}:</span>
            <span className="font-medium px-2 py-0.5 bg-muted rounded">
              {reason === 'screen-lock' ? 'Screen Lock' : reason === 'idle' ? 'Idle' : reason}
            </span>
          </div>

          {/* Note */}
          <textarea
            className="w-full h-20 px-3 py-2 text-sm rounded-md border border-input bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            placeholder={t('afk.notePlaceholder')}
            value={userNote}
            onChange={(e) => setUserNote(e.target.value)}
          />
        </div>

        <DialogFooter>
          <button
            className="px-4 py-2 text-sm border rounded-md hover:bg-muted transition"
            onClick={onClose}
          >
            {t('afk.dismiss')}
          </button>
          <button
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:opacity-90 transition disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? t('afk.submitting') : t('afk.submit')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
