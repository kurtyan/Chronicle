import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { BoardPage } from './pages/BoardPage'
import { ReportPage } from './pages/ReportPage'
import { SettingsPage } from './pages/SettingsPage'
import { TodayPage } from './pages/TodayPage'
import { AlertCircle, BarChart3, Calendar, CheckCircle2, ClipboardList, ListTodo, Loader2, Settings, X } from 'lucide-react'
import { useI18n } from './i18n/context'
import { useEffect, useState, useRef, useCallback } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { useSSE } from './hooks/useSSE'
import { isTauriEnv, apiBase } from './services/httpApi'
import { dispatchShortcut, registerShortcut } from '@/shortcuts/registry'
import '@/styles/prose-display.css'
import DOMPurify from 'dompurify'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BACKGROUND_TASK_TOAST_TTL_MS, useBackgroundTaskStore, type BackgroundTask } from '@/stores/backgroundTaskStore'
import { MarkdownView } from '@/components/MarkdownView'
import { MeetingExtractionDialog } from '@/components/MeetingExtractionDialog'
import type { MeetingExtractionResult } from '@/types'
import { fetchBackgroundTask } from '@/services/api'

// Open links in system browser when running in Tauri
function useSystemBrowserLinks() {
  useEffect(() => {
    if (!(window as any).__TAURI__) return
    const handler = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a')
      console.log('[useSystemBrowserLinks] click on:', link, link?.href)
      if (link?.href) {
        // Skip attachment links — let TaskEntryBlock handle them
        if (link.href.startsWith('file://') && link.href.includes('chronicle_attachment')) {
          console.log('[useSystemBrowserLinks] Skipping attachment link')
          return
        }
        console.log('[useSystemBrowserLinks] Opening link in system browser:', link.href)
        e.preventDefault()
        e.stopPropagation()
        import('@tauri-apps/plugin-shell').then(m => m.open(link.href))
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [])
}

// Cmd+Plus/Minus/0 zoom in Tauri
function useTauriZoom() {
  useEffect(() => {
    if (!(window as any).__TAURI__) return

    const savedZoom = localStorage.getItem('chronicle_zoom_level')
    const zoomLevelRef = { current: savedZoom ? parseInt(savedZoom, 10) : 100 }

    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        if (zoomLevelRef.current !== 100) {
          await invoke('set_zoom', { scale: zoomLevelRef.current / 100 })
        }
      } catch { /* ignore */ }
    })()

    const handler = async (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod) return
      const { invoke } = await import('@tauri-apps/api/core')
      let newZoom = zoomLevelRef.current
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        newZoom = Math.min(300, zoomLevelRef.current + 10)
        await invoke('set_zoom', { scale: newZoom / 100 })
      } else if (e.key === '-') {
        e.preventDefault()
        newZoom = Math.max(50, zoomLevelRef.current - 10)
        await invoke('set_zoom', { scale: newZoom / 100 })
      } else if (e.key === '0') {
        e.preventDefault()
        newZoom = 100
        await invoke('set_zoom', { scale: 1.0 })
      }
      zoomLevelRef.current = newZoom
      localStorage.setItem('chronicle_zoom_level', String(newZoom))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}

function SseStatusDot() {
  const { state: connState, url: sseUrl, error: sseError } = useSSE()
  const [showBubble, setShowBubble] = useState(false)
  const dotRef = useRef<HTMLDivElement>(null)
  const [bubblePos, setBubblePos] = useState({ bottom: 0, left: 0 })

  useEffect(() => {
    if (!showBubble || !dotRef.current) return
    const rect = dotRef.current.getBoundingClientRect()
    setBubblePos({ bottom: window.innerHeight - rect.top + 8, left: rect.left })
  }, [showBubble])

  useEffect(() => {
    if (!showBubble) return
    const handler = (e: MouseEvent) => {
      // Don't dismiss if clicking inside the bubble (e.g., text selection)
      const bubble = document.querySelector('.sse-bubble')
      if (bubble?.contains(e.target as Node)) return
      if (!dotRef.current?.contains(e.target as Node)) {
        setShowBubble(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showBubble])

  const dotClass = connState === 'connected'
    ? 'bg-green-500'
    : (connState === 'connecting' || connState === 'reconnecting')
      ? 'bg-yellow-500 animate-pulse'
      : 'bg-red-500'

  const displayUrl = sseUrl
    ? (isTauriEnv && apiBase
        ? `${apiBase}/api/events?clientId=${sseUrl.split('clientId=')[1] ?? ''}`
        : sseUrl.startsWith('http')
          ? sseUrl
          : `${window.location.origin}${sseUrl}`)
    : 'unknown'

  return (
    <>
      <div className="relative flex h-8 w-8 items-center justify-center">
        <div
          ref={dotRef}
          className={`w-2 h-2 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${dotClass}`}
          onClick={() => setShowBubble(v => !v)}
          title={connState}
        />
      </div>
      {showBubble && createPortal(
        <div
          className="sse-bubble fixed p-2 w-72 rounded border bg-white text-gray-900 shadow-lg text-[10px] font-mono leading-snug"
          style={{ bottom: bubblePos.bottom, left: bubblePos.left, zIndex: 99999 }}
        >
          <div className="font-bold text-[11px] mb-1">{connState}</div>
          <div className="mb-1">
            <span className="text-gray-500">URL:</span> {displayUrl}
          </div>
          {sseError && (
            <div className="text-red-600">
              <span className="text-gray-500">Err:</span> {sseError}
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()
  const tasks = useBackgroundTaskStore((s) => s.tasks)
  const panelOpen = useBackgroundTaskStore((s) => s.panelOpen)
  const setPanelOpen = useBackgroundTaskStore((s) => s.setPanelOpen)
  const runningCount = tasks.filter((task) => task.status === 'running').length
  const hasErrors = tasks.some((task) => task.status === 'error')

  const navItems = [
    { path: '/', icon: <ListTodo className="w-5 h-5" />, label: t('sidebar.board') },
    { path: '/today', icon: <Calendar className="w-5 h-5" />, label: t('sidebar.today') },
    { path: '/report', icon: <BarChart3 className="w-5 h-5" />, label: t('sidebar.report') },
    { path: '/settings', icon: <Settings className="w-5 h-5" />, label: t('sidebar.settings') },
  ]

  return (
    <aside className="w-16 border-r bg-card h-screen flex flex-col items-center py-4 gap-1 flex-shrink-0">
      <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
        <svg viewBox="0 0 24 24" className="w-6 h-6 text-primary" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <line x1="12" y1="2" x2="12" y2="22" />
          <line x1="7" y1="7" x2="10" y2="7" />
          <line x1="7" y1="10" x2="10" y2="10" />
          <line x1="7" y1="13" x2="9" y2="13" />
          <line x1="14" y1="7" x2="17" y2="7" />
          <line x1="14" y1="10" x2="17" y2="10" />
          <line x1="14" y1="13" x2="16" y2="13" />
        </svg>
      </div>
      <nav className="flex flex-col gap-3">
        {navItems.map((item) => (
          <button
            key={item.path}
            className={`w-8 h-8 rounded-md flex items-center justify-center transition ${
              location.pathname === item.path
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-muted-foreground'
            }`}
            onClick={() => navigate(item.path)}
            title={item.label}
          >
            {item.icon}
          </button>
        ))}
      </nav>
      <div className="mt-auto flex flex-col items-center gap-3">
        <button
          data-background-tasks-trigger="true"
          className={`relative w-8 h-8 rounded-md flex items-center justify-center transition ${
            panelOpen
              ? 'bg-primary text-primary-foreground'
              : hasErrors
                ? 'text-red-600 hover:bg-red-500/10'
                : runningCount > 0
                  ? 'text-blue-600 hover:bg-blue-500/10'
                  : 'hover:bg-muted text-muted-foreground'
          }`}
          onClick={() => setPanelOpen(!panelOpen)}
          title={panelOpen ? 'Hide Background Tasks' : 'Show Background Tasks'}
        >
          <ClipboardList className="w-5 h-5" />
          {runningCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white">
              {runningCount}
            </span>
          )}
        </button>
        <SseStatusDot />
      </div>
    </aside>
  )
}

function BackgroundTasksPanel() {
  const navigate = useNavigate()
  const tasks = useBackgroundTaskStore((s) => s.tasks)
  const panelOpen = useBackgroundTaskStore((s) => s.panelOpen)
  const selectedTaskId = useBackgroundTaskStore((s) => s.selectedTaskId)
  const statusFilter = useBackgroundTaskStore((s) => s.statusFilter)
  const loading = useBackgroundTaskStore((s) => s.loading)
  const loadTasks = useBackgroundTaskStore((s) => s.loadTasks)
  const setPanelOpen = useBackgroundTaskStore((s) => s.setPanelOpen)
  const setStatusFilter = useBackgroundTaskStore((s) => s.setStatusFilter)
  const selectTask = useBackgroundTaskStore((s) => s.selectTask)
  const markRead = useBackgroundTaskStore((s) => s.markRead)
  const dismissTask = useBackgroundTaskStore((s) => s.dismissTask)
  const toasts = useBackgroundTaskStore((s) => s.toasts)
  const removeToast = useBackgroundTaskStore((s) => s.removeToast)
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null
  const visibleTasks = statusFilter === 'all'
    ? tasks
    : tasks.filter((task) => task.status === statusFilter)
  const [meetingRoute, setMeetingRoute] = useState<{
    mode: 'record' | 'test'
    taskId: string
    result?: MeetingExtractionResult | null
    rawContent?: string
    error?: string
    extracting?: boolean
  } | null>(null)

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  useEffect(() => {
    if (panelOpen) void loadTasks()
  }, [loadTasks, panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-background-tasks-panel="true"]')) return
      if (target?.closest('[data-background-tasks-trigger="true"]')) return
      if (target?.closest('[role="dialog"]')) return
      setPanelOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true)
  }, [panelOpen, setPanelOpen])

  async function routeDailySummaryTask(task: BackgroundTask) {
    const date = typeof task.meta?.date === 'string'
      ? task.meta.date
      : task.sourceKey.replace(/^daily_summary:/, '')
    if (!date) {
      selectTask(task.id)
      return
    }
    selectTask(null)
    setPanelOpen(false)
    navigate(`/today?date=${encodeURIComponent(date)}&dailySummary=${Date.now()}`)
  }

  async function routeTaskSummaryTask(task: BackgroundTask) {
    const result = task.result as { taskId?: unknown } | null
    const taskId = typeof task.meta?.taskId === 'string'
      ? task.meta.taskId
      : typeof result?.taskId === 'string'
        ? result.taskId
        : task.sourceKey.replace(/^task_summary:/, '')
    if (!taskId) {
      selectTask(task.id)
      return
    }
    selectTask(null)
    setPanelOpen(false)
    navigate('/')
    await useTaskStore.getState().setActiveTask(taskId)
  }

  async function routeMeetingExtractTask(task: BackgroundTask) {
    const detail = await fetchBackgroundTask(task.id).catch(() => task)
    const targetTaskIds = Array.isArray(detail.meta?.targetTaskIds) ? detail.meta.targetTaskIds : []
    const targetTaskId = targetTaskIds.find((id): id is string => typeof id === 'string')
    if (detail.status === 'success' && detail.meta?.consumedAt && targetTaskId) {
      selectTask(null)
      setPanelOpen(false)
      navigate('/')
      await useTaskStore.getState().setActiveTask(targetTaskId)
      return
    }

    const mode = detail.meta?.mode === 'test' ? 'test' : 'record'
    if (detail.status === 'success' && detail.result && 'rawContent' in detail.result) {
      setMeetingRoute({ mode, taskId: detail.id, result: detail.result as MeetingExtractionResult })
      selectTask(null)
      return
    }

    const rawContent = typeof detail.meta?.rawContent === 'string' ? detail.meta.rawContent : ''
    if (rawContent) {
      setMeetingRoute({
        mode,
        taskId: detail.id,
        rawContent,
        error: detail.status === 'error' ? (detail.error || 'Extraction failed') : '',
        extracting: detail.status === 'running',
      })
      selectTask(null)
      return
    }

    selectTask(detail.id)
  }

  async function openTask(task: BackgroundTask) {
    if (task.type === 'daily_summary') await routeDailySummaryTask(task)
    else if (task.type === 'task_summary') await routeTaskSummaryTask(task)
    else await routeMeetingExtractTask(task)
    if (!task.readAt && task.status !== 'running') await markRead(task.id)
  }

  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.map((toast) => window.setTimeout(
      () => removeToast(toast.id),
      Math.max(0, toast.createdAt + BACKGROUND_TASK_TOAST_TTL_MS - Date.now())
    ))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [removeToast, toasts])

  return createPortal(
    <>
      {panelOpen && <div
          data-background-tasks-panel="true"
          className="fixed bottom-0 left-16 right-0 z-40 border-t border-border bg-background shadow-[0_-18px_55px_-36px_hsl(var(--foreground)/0.55)]"
        >
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            <div className="text-sm font-semibold">Background Tasks</div>
            <div className="text-xs text-muted-foreground">{visibleTasks.length}</div>
          </div>
          <div className="flex items-center gap-2">
            {(['all', 'running', 'success', 'error'] as const).map((status) => (
              <button
                key={status}
                className={`rounded-md px-2 py-1 text-xs ${statusFilter === status ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                onClick={() => setStatusFilter(status)}
              >
                {status[0].toUpperCase() + status.slice(1)}
              </button>
            ))}
            <button className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setPanelOpen(false)} title="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="h-80 overflow-y-auto">
          {loading && visibleTasks.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading background tasks...</div>
          ) : visibleTasks.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">No background tasks in the last 30 days.</div>
          ) : (
            <div className="divide-y divide-border/60">
              {visibleTasks.map((task) => {
                return (
                  <div key={task.id} className="grid grid-cols-[24px_minmax(0,1fr)_120px_170px_36px] items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50">
                    <TaskStatusIcon status={task.status} />
                    <button className="min-w-0 text-left" onClick={() => openTask(task)}>
                      <div className="truncate font-medium">{task.title}</div>
                      {task.error && <div className="mt-0.5 truncate text-xs text-red-600">{task.error}</div>}
                    </button>
                    <div className="text-xs text-muted-foreground">{formatTaskType(task.type)}</div>
                    <div className="text-right text-xs text-muted-foreground">{new Date(task.updatedAt).toLocaleString()}</div>
                    <button className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Dismiss" onClick={() => dismissTask(task.id)}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        </div>}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="rounded-lg border border-border bg-background p-3 text-left text-sm shadow-lg"
            >
              <div className="flex items-start gap-2">
                <TaskStatusIcon status={toast.status} />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    const task = tasks.find((item) => item.id === toast.taskId)
                    if (task) void openTask(task)
                    else {
                      setPanelOpen(true)
                      selectTask(toast.taskId)
                      void markRead(toast.taskId)
                    }
                    removeToast(toast.id)
                  }}
                >
                  <div className="font-medium">{toast.status === 'success' ? 'Background task completed' : 'Background task failed'}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{toast.title}</div>
                </button>
                <button
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation()
                    removeToast(toast.id)
                  }}
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <BackgroundTaskResultDialog
        task={selectedTask}
        onOpenChange={(open) => !open && selectTask(null)}
      />
      <MeetingExtractionDialog
        open={Boolean(meetingRoute)}
        mode={meetingRoute?.mode ?? 'record'}
        initialResult={meetingRoute?.result ?? null}
        initialRawContent={meetingRoute?.rawContent}
        initialError={meetingRoute?.error}
        initialExtracting={meetingRoute?.extracting}
        backgroundTaskId={meetingRoute?.taskId ?? null}
        onSaved={async (task) => {
          setPanelOpen(false)
          navigate('/')
          await useTaskStore.getState().setActiveTask(task.id)
        }}
        onOpenChange={(open) => { if (!open) setMeetingRoute(null) }}
      />
    </>,
    document.body
  )
}

function TaskStatusIcon({ status }: { status: BackgroundTask['status'] }) {
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-green-600" />
  return <AlertCircle className="h-4 w-4 text-red-600" />
}

function formatTaskType(type: BackgroundTask['type']): string {
  if (type === 'daily_summary') return 'Daily Summary'
  if (type === 'task_summary') return 'Task Summary'
  return 'Meeting Extract'
}

function BackgroundTaskResultDialog({ task, onOpenChange }: {
  task: BackgroundTask | null
  onOpenChange: (open: boolean) => void
}) {
  const result = task?.result
  const [showSource, setShowSource] = useState(false)

  return (
    <Dialog open={Boolean(task)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{task?.title ?? 'Background Task'}</DialogTitle>
          <DialogDescription>{task ? formatTaskType(task.type) : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!result ? null : 'summaryMarkdown' in result ? (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => setShowSource((value) => !value)}>
                  {showSource ? 'Show Rendered' : 'Show Source'}
                </button>
              </div>
              {showSource ? (
                <pre className="whitespace-pre-wrap rounded-md border border-border/70 bg-muted/20 p-4 text-sm leading-6">{result.summaryMarkdown}</pre>
              ) : (
                <MarkdownView markdown={result.summaryMarkdown} className="rounded-md border border-border/70 bg-background p-4 text-sm leading-6" />
              )}
            </div>
          ) : 'latestProgress' in result ? (
            <div className="space-y-4">
              <ResultField label="Task">{task?.meta?.taskTitle ?? result.taskId}</ResultField>
              <ResultField label="Latest Progress">{result.latestProgress}</ResultField>
              {result.nextStep && <ResultField label="Next Step">{result.nextStep}</ResultField>}
              {!result.nextStep && result.recommendedNextStep && <ResultField label="Recommendation">{result.recommendedNextStep}</ResultField>}
            </div>
          ) : (
            <div className="space-y-4">
              <ResultField label="Title">{result.title || 'Untitled'}</ResultField>
              <ResultField label="Time">{formatMeetingTime(result.startedAt, result.endedAt)}</ResultField>
              <ResultField label="Participants">{result.participants.join(', ') || 'None'}</ResultField>
              <ResultField label="Tags">{result.tags.join(', ') || 'None'}</ResultField>
              {result.warnings.length > 0 && <ResultField label="Warnings">{result.warnings.join('\n')}</ResultField>}
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-normal text-muted-foreground">Content</div>
                <div
                  className="prose-mirror-display rounded-md border border-border/70 bg-muted/10 p-3 text-sm"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.content, { ALLOW_UNKNOWN_PROTOCOLS: true }) }}
                />
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ResultField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="whitespace-pre-wrap text-sm leading-6">{children}</div>
    </div>
  )
}

function formatMeetingTime(startedAt: number | null, endedAt: number | null): string {
  if (!startedAt && !endedAt) return 'Not set'
  const start = startedAt ? new Date(startedAt).toLocaleString() : '?'
  const end = endedAt ? new Date(endedAt).toLocaleString() : '?'
  return `${start} - ${end}`
}

// Global version badge — fixed bottom-right, z-index on top of all components
// Shows both frontend and server version in dev mode
function DevVersionBadge() {
  const [serverVersion, setServerVersion] = useState('')

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(data => setServerVersion(data.version))
      .catch(() => {})
  }, [])

  return createPortal(
    <div
      className="fixed bottom-2 right-2 flex flex-col items-end gap-1 pointer-events-none"
      style={{ zIndex: 999999 }}
    >
      <div className="bg-amber-500/20 text-amber-500 text-[9px] font-bold px-2 py-0.5 rounded pointer-events-auto">
        DEV
      </div>
      <div className="bg-black/60 text-white text-[9px] font-mono px-2 py-0.5 rounded pointer-events-auto">
        UI {__CHRONICLE_VERSION__}
      </div>
      {serverVersion && (
        <div className="bg-black/60 text-white text-[9px] font-mono px-2 py-0.5 rounded pointer-events-auto">
          API {serverVersion}
        </div>
      )}
    </div>,
    document.body
  )
}

import { useTaskStore } from '@/stores/taskStore'
import { AutoAfkDialog } from '@/components/AutoAfkDialog'

// Listen for auto-AFK events from Tauri backend
// Returns dialog state for rendering in Layout
function useAutoAfk() {
  const [afkDialog, setAfkDialog] = useState<{ open: boolean; reason: string; triggeredAt: number }>({
    open: false, reason: '', triggeredAt: 0,
  })
  const afkInProgressRef = useRef(false)

  useEffect(() => {
    const p = (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen('auto-afk-triggered', async (event) => {
          const reason = event.payload as string
          if (afkInProgressRef.current) {
            console.log('[Auto-AFK] skipped: AFK already in progress')
            return
          }
          console.log('[Auto-AFK] event received:', reason)
          afkInProgressRef.current = true
          // End the session (calls server API + clears local state) then show dialog
          useTaskStore.getState().doAfk()
          setAfkDialog({ open: true, reason, triggeredAt: Date.now() })
        })
        console.log('[Auto-AFK] listener registered')
        return unlisten
      } catch (e) {
        console.log('[Auto-AFK] failed to register listener:', e)
        return null
      }
    })()
    return () => { p.then(fn => fn?.()) }
  }, [])

  const onClose = useCallback(() => {
    afkInProgressRef.current = false
    setAfkDialog(prev => ({ ...prev, open: false }))
  }, [])

  return {
    open: afkDialog.open,
    reason: afkDialog.reason,
    triggeredAt: afkDialog.triggeredAt,
    onClose,
  }
}

function Layout() {
  useSystemBrowserLinks()
  useTauriZoom()
  const afkDialog = useAutoAfk()
  const navigate = useNavigate()

  const { setSearchMode } = useTaskStore()
  const navigateRef = useRef(navigate)
  const setSearchModeRef = useRef(setSearchMode)

  // Keep refs updated
  useEffect(() => {
    navigateRef.current = navigate
  })
  useEffect(() => {
    setSearchModeRef.current = setSearchMode
  })

  // Central keyboard shortcut dispatcher
  // Registered once on mount — uses refs for navigate and setSearchMode
  useEffect(() => {
    // Register app-level shortcuts
    const unregisters: (() => void)[] = []

    // Cmd+Q: AFK (prevent app quit on all pages)
    unregisters.push(registerShortcut({
      id: 'afk-session',
      combo: 'mod+q',
      label: 'AFK session',
      scope: 'app',
      handler: () => {
        const { doAfk, currentSession } = useTaskStore.getState()
        if (currentSession) doAfk()
      },
    }))

    // Cmd+W: Prevent window close (always intercepts, blurs editor if focused)
    unregisters.push(registerShortcut({
      id: 'prevent-close',
      combo: 'mod+w',
      label: 'Prevent window close',
      scope: 'page',
      handler: () => {
        const editorEl = document.activeElement?.closest('[data-rich-editor="true"] .ProseMirror') as HTMLElement | null
        if (editorEl) editorEl?.blur()
      },
    }))

    // Cmd+R: Refresh tasks (prevent page reload on all pages)
    unregisters.push(registerShortcut({
      id: 'refresh',
      combo: 'mod+r',
      label: 'Refresh tasks',
      scope: 'app',
      handler: async () => {
        const s = useTaskStore.getState()
        s.loadTodos()
        s.loadCurrentSession()
      },
    }))

    // Cmd+Shift+F: Toggle search mode (works even in inputs, matching original)
    unregisters.push(registerShortcut({
      id: 'toggle-search',
      combo: 'mod+shift+f',
      label: 'Toggle search',
      scope: 'app',
      handler: () => setSearchModeRef.current(true),
    }))

    // Cmd+1/2/3/4: Sidebar navigation
    unregisters.push(registerShortcut({
      id: 'nav-board',
      combo: 'mod+1',
      label: 'Go to Board',
      scope: 'app',
      handler: () => navigateRef.current('/'),
    }))
    unregisters.push(registerShortcut({
      id: 'nav-today',
      combo: 'mod+2',
      label: 'Go to Today',
      scope: 'app',
      handler: () => navigateRef.current('/today'),
    }))
    unregisters.push(registerShortcut({
      id: 'nav-report',
      combo: 'mod+3',
      label: 'Go to Report',
      scope: 'app',
      handler: () => navigateRef.current('/report'),
    }))
    unregisters.push(registerShortcut({
      id: 'nav-settings',
      combo: 'mod+4',
      label: 'Go to Settings',
      scope: 'app',
      handler: () => navigateRef.current('/settings'),
    }))

    // Escape: Exit search mode (immediate, no registry — needs latest searchMode)
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useTaskStore.getState().searchMode) {
        e.preventDefault()
        e.stopPropagation()
        setSearchModeRef.current(false)
      }
    }
    document.addEventListener('keydown', escapeHandler, true)

    // Main dispatcher for registered shortcuts
    // NOTE: no global isInput check — original code only blocked Arrow/N in inputs,
    // while modifier shortcuts (Cmd+Q, Cmd+T, etc.) worked everywhere
    const dispatcher = (e: KeyboardEvent) => {
      // Skip zoom shortcuts (handled by useTauriZoom)
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && ['+', '-', '=', '0'].includes(e.key)) return

      // Dispatch to registry
      if (dispatchShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', dispatcher, true)

    return () => {
      for (const unregister of unregisters) unregister()
      document.removeEventListener('keydown', escapeHandler, true)
      window.removeEventListener('keydown', dispatcher, true)
    }
  }, []) // Empty deps — registered once on mount

  // Prevent file drag from navigating to file content outside the editor
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
      }
    }
    const handleDrop = (e: DragEvent) => {
      // Only prevent default if not dropping inside the rich editor
      const editorEl = (e.target as HTMLElement)?.closest('[data-rich-editor="true"]')
      if (e.dataTransfer?.types.includes('Files') && !editorEl) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', handleDragOver, true)
    window.addEventListener('drop', handleDrop, true)
    return () => {
      window.removeEventListener('dragover', handleDragOver, true)
      window.removeEventListener('drop', handleDrop, true)
    }
  }, [])
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/report" element={<ReportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <BackgroundTasksPanel />
      {import.meta.env.DEV && <DevVersionBadge />}
      <AutoAfkDialog
        open={afkDialog.open}
        reason={afkDialog.reason}
        triggeredAt={afkDialog.triggeredAt}
        onClose={afkDialog.onClose}
      />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}
