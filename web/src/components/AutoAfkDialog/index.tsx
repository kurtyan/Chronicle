import { useState, useEffect, useRef } from 'react'
import { Clock3, PauseCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
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
            <PauseCircle className="h-5 w-5 text-amber-500" />
            AutoAFK
          </DialogTitle>
          <DialogDescription>
            Chronicle detected inactivity. Review the reason, optionally add context, then save the AFK record.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="dialog-section text-center">
            <div className="text-4xl font-mono font-bold tabular-nums tracking-tight">
              {formatElapsed(elapsed)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {t('afk.timeaway')}
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">{t('afk.reason')}:</span>
            <span className="dialog-badge">
              {reason === 'screen-lock' ? 'Screen Lock' : reason === 'idle' ? 'Idle' : reason}
            </span>
          </div>

          <textarea
            className="dialog-textarea"
            placeholder={t('afk.notePlaceholder')}
            value={userNote}
            onChange={(e) => setUserNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />
          <div className="text-xs text-muted-foreground text-right">
            Ctrl+Enter {t('afk.submit')}
          </div>
        </DialogBody>

        <DialogFooter>
          <button
            className="dialog-button-secondary"
            onClick={onClose}
          >
            {t('afk.dismiss')}
          </button>
          <button
            className="dialog-button-primary"
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
