import { useEffect, useState } from 'react'
import type React from 'react'
import { CalendarClock, Check, Loader2, X } from 'lucide-react'
import DOMPurify from 'dompurify'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { createMeeting, extractMeeting } from '@/services/api'
import type { MeetingExtractionResult, Task } from '@/types'
import { RichEditor } from '@/components/RichEditor'

type Mode = 'record' | 'test'
const RECORD_DRAFT_KEY = 'chronicle_meeting_record_draft_html'
const TEST_DRAFT_KEY = 'chronicle_meeting_test_draft_html'

interface Props {
  open: boolean
  mode: Mode
  onOpenChange: (open: boolean) => void
  onSaved?: (task: Task) => void
}

export function MeetingExtractionDialog({ open, mode, onOpenChange, onSaved }: Props) {
  const [step, setStep] = useState<'input' | 'confirm'>('input')
  const [rawContent, setRawContent] = useState(() => getStoredDraft(mode))
  const [result, setResult] = useState<MeetingExtractionResult | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [startedAtInput, setStartedAtInput] = useState('')
  const [endedAtInput, setEndedAtInput] = useState('')

  useEffect(() => {
    if (!open) {
      setStep('input')
      setRawContent(getStoredDraft(mode))
      setResult(null)
      setExtracting(false)
      setSaving(false)
      setError('')
      setStartedAtInput('')
      setEndedAtInput('')
    }
  }, [open, mode])

  useEffect(() => {
    if (!open) return
    localStorage.setItem(draftKey(mode), rawContent)
  }, [rawContent, mode, open])

  const runExtraction = async () => {
    if (isHtmlEmpty(rawContent)) return
    setExtracting(true)
    setError('')
    try {
      const extracted = await extractMeeting(rawContent.trim(), mode)
      setResult(extracted)
      setStep('confirm')
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Extraction failed')
    } finally {
      setExtracting(false)
    }
  }

  const updateResult = (patch: Partial<MeetingExtractionResult>) => {
    if (!result) return
    setResult({ ...result, ...patch })
  }

  useEffect(() => {
    if (!result || step !== 'confirm') return
    setStartedAtInput(formatDateTime(result.startedAt))
    setEndedAtInput(formatDateTime(result.endedAt))
  }, [result?.llmCallLogId, step])

  const saveMeeting = async () => {
    if (!result || !result.title?.trim() || !result.startedAt || !result.endedAt) return
    setSaving(true)
    setError('')
    try {
      const task = await createMeeting({
        title: result.title.trim(),
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        content: result.content,
        participants: result.participants,
        tags: result.tags,
        rawContent: result.rawContent,
        llmCallLogId: result.llmCallLogId,
      })
      onSaved?.(task)
      localStorage.removeItem(draftKey(mode))
      onOpenChange(false)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const isTest = mode === 'test'
  const canSave = result?.title?.trim() && result.startedAt && result.endedAt && result.endedAt > result.startedAt
  const canExtract = !isHtmlEmpty(rawContent)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-muted-foreground" />
            <DialogTitle>{isTest ? 'Test Meeting Extraction Prompt' : 'Record Meeting'}</DialogTitle>
          </div>
          <DialogDescription>
            {step === 'input' ? 'Paste raw meeting notes for extraction.' : 'Review extracted fields before finishing.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0">
          {step === 'input' ? (
            <div className="space-y-3">
              <RichEditor
                content={rawContent}
                onChange={setRawContent}
                minHeight="320px"
                placeholder="10:00-11:00 Project sync&#10;Participants: Alice, Bob&#10;Discussed..."
                autoFocus
                onKeyDown={() => {
                  if (canExtract && !extracting) runExtraction()
                }}
              />
              {error && <div className="text-sm text-destructive">{error}</div>}
            </div>
          ) : result ? (
            <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-3 overflow-y-auto pr-1">
                {result.warnings.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    {result.warnings.map((warning) => <div key={warning}>{warning}</div>)}
                  </div>
                )}
                {error && <div className="text-sm text-destructive">{error}</div>}
                <Field label="Title">
                  <input className="field-input" value={result.title ?? ''} onChange={(e) => updateResult({ title: e.target.value })} />
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Started At">
                    <input
                      className="field-input"
                      value={startedAtInput}
                      onChange={(e) => {
                        const value = e.target.value
                        setStartedAtInput(value)
                        const parsed = parseDateTime(value)
                        if (parsed) updateResult({ startedAt: parsed })
                      }}
                      placeholder="yyyy-MM-dd HH:mm"
                    />
                  </Field>
                  <Field label="Ended At">
                    <input
                      className="field-input"
                      value={endedAtInput}
                      onChange={(e) => {
                        const value = e.target.value
                        setEndedAtInput(value)
                        const parsed = parseDateTime(value)
                        if (parsed) updateResult({ endedAt: parsed })
                      }}
                      placeholder="yyyy-MM-dd HH:mm"
                    />
                  </Field>
                </div>
                <Field label="Participants">
                  <input className="field-input" value={result.participants.join(', ')} onChange={(e) => updateResult({ participants: splitList(e.target.value) })} />
                </Field>
                <Field label="Tags">
                  <input className="field-input" value={result.tags.join(', ')} onChange={(e) => updateResult({ tags: ensureMeetingTag(splitList(e.target.value)) })} />
                </Field>
                <Field label="Content">
                  <div className="rounded-md border border-border/70 overflow-hidden">
                    <RichEditor
                      content={result.content}
                      onChange={(content) => updateResult({ content })}
                      minHeight="160px"
                    />
                  </div>
                </Field>
              </div>
              <div className="space-y-2 min-w-0 overflow-y-auto">
                <div className="text-xs font-medium text-muted-foreground">Raw Content</div>
                <div
                  className="prose prose-sm max-w-none rounded-2xl border border-border/60 bg-muted/20 p-4 text-xs leading-5 min-h-[360px] overflow-auto"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.rawContent, { ALLOW_UNKNOWN_PROTOCOLS: true }) }}
                />
              </div>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {step === 'confirm' && (
            <button className="dialog-button-secondary" onClick={() => setStep('input')} disabled={saving}>
              Back
            </button>
          )}
          <button className="dialog-button-secondary" onClick={() => onOpenChange(false)} disabled={extracting || saving}>
            <X className="w-4 h-4" />
            Close
          </button>
          {step === 'input' ? (
            <button
              onClick={runExtraction}
              disabled={!canExtract || extracting}
              className="dialog-button-primary"
            >
              {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
              Extract
            </button>
          ) : isTest ? (
            <button className="dialog-button-primary" onClick={() => onOpenChange(false)}>
              <Check className="w-4 h-4" />
              Done
            </button>
          ) : (
            <button
              onClick={saveMeeting}
              disabled={!canSave || saving}
              className="dialog-button-primary"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save Meeting
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function ensureMeetingTag(tags: string[]): string[] {
  const cleaned = Array.from(new Map(tags.map((tag) => [tag.toLowerCase(), tag])).values()).filter(Boolean)
  if (!cleaned.some((tag) => tag.toLowerCase() === 'meeting')) cleaned.unshift('meeting')
  return cleaned
}

function formatDateTime(ts: number | null): string {
  if (!ts) return ''
  const date = new Date(ts)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function parseDateTime(value: string): number | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0)
  const ts = date.getTime()
  return Number.isFinite(ts) ? ts : null
}

function draftKey(mode: Mode): string {
  return mode === 'test' ? TEST_DRAFT_KEY : RECORD_DRAFT_KEY
}

function getStoredDraft(mode: Mode): string {
  return localStorage.getItem(draftKey(mode)) ?? ''
}

function isHtmlEmpty(html: string): boolean {
  if (!html) return true
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, '')
  return text.length === 0
}
