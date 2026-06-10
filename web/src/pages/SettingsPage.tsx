import { useMemo, useState, useEffect } from 'react'
import { useI18n } from '../i18n/context'
import DOMPurify from 'dompurify'
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle,
  Clock,
  Database,
  Download,
  FileText,
  FlaskConical,
  Info,
  Languages,
  Loader2,
  RefreshCw,
  Save,
  Terminal,
  Upload,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { isTauriEnv, ensureApiReady, clientId } from '@/services/httpApi'
import { fetchLlmSettings, fetchStartOfDayOffset, fetchTaskEntries, fetchTodos, saveLlmSettings, setStartOfDayOffset, testLlmConnection, testTaskSummaryPrompt } from '@/services/api'
import { MeetingExtractionDialog } from '@/components/MeetingExtractionDialog'
import type { LlmSettings, Task, TaskEntry, TaskSummaryTestResult } from '@/types'

interface SettingsInfo {
  dbPath: string
  dbSize: number
  lastBackupAt: number | null
}

interface LlmCallLogSummary {
  id: string
  feature: string
  promptVersion: string
  model: string | null
  baseUrl: string | null
  requestInput: any
  requestMessages: any
  rawProviderResponse: string | null
  rawResponse: string | null
  parsedOutput: any
  status: string
  errorMessage: string | null
  latencyMs: number | null
  createdAt: number
  linkedTaskId: string | null
  linkedEntryId: string | null
}

type SettingsMessage = { type: 'success' | 'error'; text: string } | null

type SettingsSectionId =
  | 'general.language'
  | 'general.workday'
  | 'automation.autoAfk'
  | 'ai.provider'
  | 'ai.meetingExtraction'
  | 'ai.taskSummary'
  | 'data.database'
  | 'data.importExport'
  | 'diagnostics.clientLog'
  | 'diagnostics.version'

interface SettingsTreeGroup {
  id: string
  label: string
  items: Array<{
    id: SettingsSectionId
    label: string
    description: string
  }>
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString()
}

function LogJsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <textarea
        readOnly
        value={JSON.stringify(value, null, 2)}
        className="max-h-64 min-h-[120px] w-full resize-y rounded-md border border-border/60 bg-background/70 p-2 font-mono text-[11px] leading-4 outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  )
}

function LogTextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <textarea
        readOnly
        value={value}
        className="max-h-64 min-h-[120px] w-full resize-y rounded-md border border-border/60 bg-background/70 p-2 font-mono text-[11px] leading-4 outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  )
}

function displayLlmSettings(settings: LlmSettings): LlmSettings {
  return {
    ...settings,
    meetingExtractionPrompt: settings.meetingExtractionPrompt || settings.defaultMeetingExtractionPrompt,
    taskSummaryPrompt: settings.taskSummaryPrompt || settings.defaultTaskSummaryPrompt,
  }
}

function serializeLlmSettings(settings: LlmSettings): Partial<LlmSettings> {
  const meetingPrompt = settings.meetingExtractionPrompt.trim()
  const defaultMeetingPrompt = settings.defaultMeetingExtractionPrompt.trim()
  const taskSummaryPrompt = settings.taskSummaryPrompt.trim()
  const defaultTaskSummaryPrompt = settings.defaultTaskSummaryPrompt.trim()
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs,
    meetingExtractionPrompt: meetingPrompt === defaultMeetingPrompt ? '' : settings.meetingExtractionPrompt,
    taskSummaryPrompt: taskSummaryPrompt === defaultTaskSummaryPrompt ? '' : settings.taskSummaryPrompt,
  }
}

// API base URL helper for Tauri vs non-Tauri
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = isTauriEnv ? await ensureApiReady() : ''
  const url = `${base}${path}`
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      'X-Client-Id': clientId,
    },
  })
}

function SettingsMessageBanner({ message }: { message: SettingsMessage }) {
  if (!message) return null
  return (
    <div className={`flex items-center gap-2 rounded-md p-3 text-sm ${
      message.type === 'success'
        ? 'bg-green-500/10 text-green-500'
        : 'bg-red-500/10 text-red-500'
    }`}>
      {message.type === 'success' ? (
        <CheckCircle className="h-4 w-4 shrink-0" />
      ) : (
        <AlertCircle className="h-4 w-4 shrink-0" />
      )}
      {message.text}
    </div>
  )
}

function SectionPanel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border/70 bg-card p-4">
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-medium">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function SettingsTree({
  groups,
  activeSection,
  onSelect,
}: {
  groups: SettingsTreeGroup[]
  activeSection: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
}) {
  return (
    <aside className="w-full shrink-0 border-b border-border/70 bg-card/40 p-3 md:h-full md:w-56 md:border-b-0 md:border-r">
      <div className="md:hidden">
        <select
          value={activeSection}
          onChange={(e) => onSelect(e.target.value as SettingsSectionId)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {groups.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.items.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <nav className="hidden space-y-5 md:block">
        {groups.map((group) => (
          <div key={group.id}>
            <div className="mb-1 px-2 text-sm font-semibold text-foreground">
              {group.label}
            </div>
            <div className="space-y-0.5 pl-3">
              {group.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition ${
                    activeSection === item.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  )
}

function WorkdaySettingsSection({
  dayOffset,
  setDayOffset,
}: {
  dayOffset: number
  setDayOffset: (offset: number) => void
}) {
  const saveOffset = () => setStartOfDayOffset(dayOffset).catch(() => {})
  return (
    <SectionPanel icon={<Clock className="h-5 w-5 text-muted-foreground" />} title="Workday">
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={23}
          value={dayOffset}
          onChange={(e) => setDayOffset(parseInt(e.target.value, 10))}
          onMouseUp={saveOffset}
          onTouchEnd={saveOffset}
          className="flex-1"
        />
        <span className="w-16 text-right font-mono text-sm">+{dayOffset}h</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Hours to shift the day boundary. Times before this hour count as the previous day in Today and Report.
      </p>
    </SectionPanel>
  )
}

function LanguageSettingsSection({
  t,
  uiLanguage,
  onSaveLanguage,
}: {
  t: (key: string) => string
  uiLanguage: string
  onSaveLanguage: (lang: string) => void
}) {
  return (
    <SectionPanel icon={<Languages className="h-5 w-5 text-muted-foreground" />} title={t('settings.language')}>
      <div className="flex flex-wrap gap-2">
        {[
          { value: 'auto', label: t('settings.languageAuto') },
          { value: 'zh-CN', label: t('settings.languageZh') },
          { value: 'en', label: t('settings.languageEn') },
        ].map(({ value, label }) => (
          <button
            key={value}
            className={`rounded-md border px-4 py-2 text-sm transition ${
              uiLanguage === value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border hover:bg-muted'
            }`}
            onClick={() => onSaveLanguage(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
    </SectionPanel>
  )
}

function AutoAfkSettingsSection({
  t,
  autoAfkEnabled,
  screenLockEnabled,
  idleEnabled,
  idleTimeoutMinutes,
  setAutoAfkEnabled,
  setScreenLockEnabled,
  setIdleEnabled,
  setIdleTimeoutMinutes,
  onSave,
}: {
  t: (key: string) => string
  autoAfkEnabled: boolean
  screenLockEnabled: boolean
  idleEnabled: boolean
  idleTimeoutMinutes: number
  setAutoAfkEnabled: (value: boolean) => void
  setScreenLockEnabled: (value: boolean) => void
  setIdleEnabled: (value: boolean) => void
  setIdleTimeoutMinutes: (value: number) => void
  onSave: () => void
}) {
  return (
    <SectionPanel icon={<Clock className="h-5 w-5 text-muted-foreground" />} title={t('settings.autoAfkTitle')}>
      <div className="space-y-4">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={autoAfkEnabled}
            onChange={(e) => setAutoAfkEnabled(e.target.checked)}
            className="h-4 w-4 rounded"
          />
          <span className="text-sm font-medium">{t('settings.autoAfkEnabled')}</span>
        </label>

        {autoAfkEnabled && (
          <div className="space-y-4 border-l-2 border-muted pb-2 pl-4">
            <div>
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={screenLockEnabled}
                  onChange={(e) => setScreenLockEnabled(e.target.checked)}
                  className="h-4 w-4 rounded"
                />
                <span className="text-sm font-medium">{t('settings.screenLockAfk')}</span>
              </label>
              <p className="ml-7 mt-1 text-xs text-muted-foreground">{t('settings.screenLockAfkDesc')}</p>
            </div>

            <div>
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={idleEnabled}
                  onChange={(e) => setIdleEnabled(e.target.checked)}
                  className="h-4 w-4 rounded"
                />
                <span className="text-sm font-medium">{t('settings.idleAfk')}</span>
              </label>
              <p className="ml-7 mt-1 text-xs text-muted-foreground">{t('settings.idleAfkDesc')}</p>

              {idleEnabled && (
                <div className="ml-7 mt-2 flex items-center gap-2">
                  <label className="text-sm text-muted-foreground">{t('settings.idleTimeout')}:</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={idleTimeoutMinutes}
                    onChange={(e) => setIdleTimeoutMinutes(Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 1)))}
                    className="w-16 rounded border bg-background px-2 py-1 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">{t('settings.idleTimeoutMinutes')}</span>
                </div>
              )}
            </div>

            <button onClick={onSave} className="dialog-button-primary">
              {t('settings.saveAutoAfk')}
            </button>
          </div>
        )}
      </div>
    </SectionPanel>
  )
}

function LlmProviderSettingsSection({
  settings,
  saving,
  testing,
  onUpdate,
  onSave,
  onTest,
}: {
  settings: LlmSettings
  saving: boolean
  testing: boolean
  onUpdate: (patch: Partial<LlmSettings>) => void
  onSave: () => void
  onTest: () => void
}) {
  return (
    <SectionPanel icon={<Bot className="h-5 w-5 text-muted-foreground" />} title="Provider">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Base URL</span>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            value={settings.baseUrl}
            onChange={(e) => onUpdate({ baseUrl: e.target.value })}
            placeholder="http://localhost:11434/v1"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Model</span>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            value={settings.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            placeholder="qwen2.5:7b"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">API Key</span>
          <input
            type="password"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            value={settings.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder="Optional"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Timeout</span>
          <input
            type="number"
            min={1000}
            step={1000}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            value={settings.timeoutMs}
            onChange={(e) => onUpdate({ timeoutMs: parseInt(e.target.value, 10) || 30000 })}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={onSave} disabled={saving} className="dialog-button-primary">
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save Provider'}
        </button>
        <button onClick={onTest} disabled={testing} className="dialog-button-secondary">
          <FlaskConical className="h-4 w-4" />
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
      </div>
    </SectionPanel>
  )
}

function LlmCallLogsSection({
  featureLabel,
  logs,
  loading,
  expandedLogId,
  onLoad,
  onToggleExpanded,
}: {
  featureLabel: string
  logs: LlmCallLogSummary[]
  loading: boolean
  expandedLogId: string | null
  onLoad: () => void
  onToggleExpanded: (id: string | null) => void
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-card p-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-medium">Call Logs</h2>
        </div>
        <button onClick={onLoad} disabled={loading} className="dialog-button-secondary">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {logs.length === 0 ? 'Load Logs' : 'Refresh'}
        </button>
      </div>
      {logs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No logs loaded. Click Load Logs to inspect recent {featureLabel} calls.
        </p>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => {
            const mode = log.requestInput?.mode ?? 'unknown'
            const expanded = expandedLogId === log.id
            return (
              <div key={log.id} className="rounded-md border border-border/70 bg-muted/10">
                <button
                  className="w-full px-3 py-2 text-left transition hover:bg-muted/40"
                  onClick={() => onToggleExpanded(expanded ? null : log.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          log.status === 'success'
                            ? 'bg-green-500/10 text-green-600'
                            : log.status === 'parse_error'
                              ? 'bg-amber-500/10 text-amber-600'
                              : 'bg-red-500/10 text-red-600'
                        }`}>
                          {log.status}
                        </span>
                        <span className="text-xs text-muted-foreground">{mode}</span>
                        <span className="truncate text-xs text-muted-foreground">{log.promptVersion}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {log.id}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <div>{formatTimestamp(log.createdAt)}</div>
                      <div>{log.latencyMs ?? 0} ms{log.linkedTaskId ? ` · ${log.linkedTaskId}` : ''}</div>
                    </div>
                  </div>
                </button>
                {expanded && (
                  <div className="space-y-3 border-t border-border/70 p-3">
                    <LogJsonBlock label="Request Input" value={log.requestInput} />
                    <LogJsonBlock label="Request Messages" value={log.requestMessages} />
                    <LogJsonBlock label="Parsed Output" value={log.parsedOutput} />
                    {log.rawProviderResponse && <LogTextBlock label="Provider Raw Response" value={log.rawProviderResponse} />}
                    {log.rawResponse && <LogTextBlock label="Assistant Message Content" value={log.rawResponse} />}
                    {log.errorMessage && <LogTextBlock label="Error" value={log.errorMessage} />}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function MeetingExtractionSettingsSection({
  settings,
  saving,
  logs,
  logsLoading,
  expandedLogId,
  onUpdate,
  onSave,
  onTestPrompt,
  onLoadLogs,
  onToggleExpandedLog,
}: {
  settings: LlmSettings
  saving: boolean
  logs: LlmCallLogSummary[]
  logsLoading: boolean
  expandedLogId: string | null
  onUpdate: (patch: Partial<LlmSettings>) => void
  onSave: () => void
  onTestPrompt: () => void
  onLoadLogs: () => void
  onToggleExpandedLog: (id: string | null) => void
}) {
  return (
    <div className="space-y-4">
      <SectionPanel icon={<Bot className="h-5 w-5 text-muted-foreground" />} title="Meeting Extraction">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Prompt</span>
          <textarea
            className="min-h-[390px] w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-1 focus:ring-primary"
            value={settings.meetingExtractionPrompt}
            onChange={(e) => onUpdate({ meetingExtractionPrompt: e.target.value })}
            placeholder="Meeting extraction prompt"
          />
          <span className="text-[11px] text-muted-foreground">
            The default prompt is shown when no custom prompt is saved. Editing it makes this scene use a custom prompt.
          </span>
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={onSave} disabled={saving} className="dialog-button-primary">
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Prompt'}
          </button>
          <button
            onClick={() => onUpdate({ meetingExtractionPrompt: settings.defaultMeetingExtractionPrompt })}
            className="dialog-button-secondary"
          >
            Restore Default
          </button>
          <button onClick={onTestPrompt} className="dialog-button-secondary">
            <FlaskConical className="h-4 w-4" />
            Test Prompt
          </button>
        </div>
      </SectionPanel>
      <LlmCallLogsSection
        featureLabel="meeting extraction"
        logs={logs}
        loading={logsLoading}
        expandedLogId={expandedLogId}
        onLoad={onLoadLogs}
        onToggleExpanded={onToggleExpandedLog}
      />
    </div>
  )
}

function TaskSummarySettingsSection({
  settings,
  saving,
  logs,
  logsLoading,
  expandedLogId,
  onUpdate,
  onSave,
  onTestPrompt,
  onLoadLogs,
  onToggleExpandedLog,
}: {
  settings: LlmSettings
  saving: boolean
  logs: LlmCallLogSummary[]
  logsLoading: boolean
  expandedLogId: string | null
  onUpdate: (patch: Partial<LlmSettings>) => void
  onSave: () => void
  onTestPrompt: () => void
  onLoadLogs: () => void
  onToggleExpandedLog: (id: string | null) => void
}) {
  return (
    <div className="space-y-4">
      <SectionPanel icon={<Bot className="h-5 w-5 text-muted-foreground" />} title="Task Summary">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Prompt</span>
          <textarea
            className="min-h-[390px] w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-1 focus:ring-primary"
            value={settings.taskSummaryPrompt}
            onChange={(e) => onUpdate({ taskSummaryPrompt: e.target.value })}
            placeholder="Task summary prompt"
          />
          <span className="text-[11px] text-muted-foreground">
            The prompt must return JSON with latestProgress and nextStep. Leave nextStep empty unless the logs explicitly mention a next step.
          </span>
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={onSave} disabled={saving} className="dialog-button-primary">
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Prompt'}
          </button>
          <button
            onClick={() => onUpdate({ taskSummaryPrompt: settings.defaultTaskSummaryPrompt })}
            className="dialog-button-secondary"
          >
            Restore Default
          </button>
          <button onClick={onTestPrompt} className="dialog-button-secondary">
            <FlaskConical className="h-4 w-4" />
            Test Prompt
          </button>
        </div>
      </SectionPanel>
      <LlmCallLogsSection
        featureLabel="task summary"
        logs={logs}
        loading={logsLoading}
        expandedLogId={expandedLogId}
        onLoad={onLoadLogs}
        onToggleExpanded={onToggleExpandedLog}
      />
    </div>
  )
}

function TaskSummaryPromptTestDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [entries, setEntries] = useState<TaskEntry[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [loadingEntries, setLoadingEntries] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [result, setResult] = useState<TaskSummaryTestResult | null>(null)
  const [error, setError] = useState('')

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingTasks(true)
    setError('')
    fetchTodos(undefined, 'PENDING,DOING')
      .then((nextTasks) => {
        if (cancelled) return
        setTasks(nextTasks)
        setSelectedTaskId((current) => current ?? nextTasks[0]?.id ?? null)
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Failed to load tasks')
      })
      .finally(() => {
        if (!cancelled) setLoadingTasks(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !selectedTaskId) {
      setEntries([])
      return
    }
    let cancelled = false
    setLoadingEntries(true)
    setResult(null)
    setError('')
    fetchTaskEntries(selectedTaskId)
      .then((nextEntries) => {
        if (!cancelled) setEntries(nextEntries)
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Failed to load task detail')
      })
      .finally(() => {
        if (!cancelled) setLoadingEntries(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selectedTaskId])

  useEffect(() => {
    if (open) return
    setTasks([])
    setEntries([])
    setSelectedTaskId(null)
    setResult(null)
    setError('')
    setSummarizing(false)
  }, [open])

  const runSummary = async () => {
    if (!selectedTaskId) return
    setSummarizing(true)
    setError('')
    setResult(null)
    try {
      setResult(await testTaskSummaryPrompt(selectedTaskId))
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Task summary test failed')
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] sm:max-w-6xl flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-muted-foreground" />
            <DialogTitle>Test Task Summary Prompt</DialogTitle>
          </div>
          <DialogDescription>Select a task, inspect its read-only detail, then run the current task summary prompt.</DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-0">
          <div className="grid min-h-[520px] grid-cols-1 overflow-hidden rounded-lg border border-border lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="min-h-0 border-b border-border bg-card/60 lg:border-b-0 lg:border-r">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">Tasks</div>
              <div className="max-h-[520px] overflow-y-auto p-2">
                {loadingTasks ? (
                  <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading tasks...
                  </div>
                ) : tasks.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">No pending or doing tasks.</div>
                ) : (
                  <div className="space-y-1">
                    {tasks.map((task) => (
                      <button
                        key={task.id}
                        className={`w-full rounded-md px-3 py-2 text-left transition ${
                          selectedTaskId === task.id
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted'
                        }`}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <div className="truncate text-sm font-medium">{task.title}</div>
                        <div className="mt-0.5 text-xs opacity-75">{task.status} · {task.id}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </aside>
            <section className="min-h-0 overflow-y-auto p-4">
              {selectedTask ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-semibold">{selectedTask.title}</h3>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{selectedTask.status}</span>
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{selectedTask.id}</div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Recent Entries</div>
                    {loadingEntries ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading detail...
                      </div>
                    ) : entries.length === 0 ? (
                      <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">No entries recorded.</div>
                    ) : (
                      <div className="space-y-2">
                        {entries.slice(-10).map((entry) => (
                          <div key={entry.id} className="rounded-md border border-border/70 bg-muted/10 p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span className="rounded bg-muted px-1.5 py-0.5">{entry.type}</span>
                              <span>{formatTimestamp(entry.createdAt)}</span>
                            </div>
                            <div
                              className="prose-mirror-display text-sm"
                              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(entry.content, { ALLOW_UNKNOWN_PROTOCOLS: true }) }}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {result && (
                    <div className="space-y-3 rounded-md border border-border bg-card p-3">
                      <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Result</div>
                      <div>
                        <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Summary</div>
                        <div className="mt-1 whitespace-pre-wrap text-sm">{result.latestProgress}</div>
                      </div>
                      {result.nextStep && (
                        <div>
                          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Next Step</div>
                          <div className="mt-1 whitespace-pre-wrap text-sm">{result.nextStep}</div>
                        </div>
                      )}
                      {result.llmCallLogId && <div className="font-mono text-xs text-muted-foreground">Log: {result.llmCallLogId}</div>}
                    </div>
                  )}
                  {error && <div className="text-sm text-destructive">{error}</div>}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Select a task to inspect.</div>
              )}
            </section>
          </div>
        </DialogBody>
        <DialogFooter>
          <button className="dialog-button-secondary" onClick={() => onOpenChange(false)} disabled={summarizing}>
            Close
          </button>
          <button className="dialog-button-primary" onClick={runSummary} disabled={!selectedTaskId || summarizing}>
            {summarizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            Summarize
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DatabaseSettingsSection({ t, info }: { t: (key: string) => string; info: SettingsInfo | null }) {
  return (
    <SectionPanel icon={<Database className="h-5 w-5 text-muted-foreground" />} title={t('settings.databaseInfo')}>
      {info ? (
        <div className="space-y-2 text-sm">
          <div className="grid gap-1 sm:grid-cols-[140px_minmax(0,1fr)]">
            <span className="text-muted-foreground">{t('settings.dbPath')}</span>
            <span className="break-all font-mono text-xs sm:text-right">{info.dbPath}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('settings.dbSize')}</span>
            <span>{formatBytes(info.dbSize)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('settings.lastBackup')}</span>
            <span>{info.lastBackupAt ? formatTimestamp(info.lastBackupAt) : t('settings.never')}</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading...</p>
      )}
    </SectionPanel>
  )
}

function ImportExportSettingsSection({
  t,
  exporting,
  importing,
  onExport,
  onImport,
}: {
  t: (key: string) => string
  exporting: boolean
  importing: boolean
  onExport: () => void
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <SectionPanel icon={<Upload className="h-5 w-5 text-muted-foreground" />} title="Import / Export">
      <div className="flex flex-wrap gap-3">
        <button onClick={onExport} disabled={exporting} className="dialog-button-primary">
          <Download className="h-4 w-4" />
          {exporting ? t('settings.exporting') : t('settings.export')}
        </button>

        <label className="dialog-button-secondary cursor-pointer">
          <Upload className="h-4 w-4" />
          {importing ? t('settings.importing') : t('settings.import')}
          <input
            type="file"
            accept=".db"
            onChange={onImport}
            className="hidden"
            disabled={importing}
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Import replaces the current database after creating a pre-import backup.
      </p>
    </SectionPanel>
  )
}

function ClientLogSettingsSection({
  showLog,
  clientLog,
  logLoading,
  setShowLog,
}: {
  showLog: boolean
  clientLog: string
  logLoading: boolean
  setShowLog: (value: boolean | ((current: boolean) => boolean)) => void
}) {
  return (
    <SectionPanel icon={<Terminal className="h-5 w-5 text-muted-foreground" />} title="Client Log">
      <button onClick={() => setShowLog(v => !v)} className="dialog-button-secondary">
        {showLog ? 'Close' : 'View Log'}
      </button>
      {showLog && (
        <textarea
          readOnly
          value={clientLog}
          rows={16}
          className="mt-3 w-full resize-none rounded border bg-background p-2 font-mono text-xs"
          placeholder={logLoading ? 'Loading...' : 'No log available'}
        />
      )}
    </SectionPanel>
  )
}

function VersionSettingsSection({ t, serverVersion }: { t: (key: string) => string; serverVersion: string }) {
  return (
    <SectionPanel icon={<Info className="h-5 w-5 text-muted-foreground" />} title={t('settings.versionInfo')}>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('settings.uiVersion')}</span>
          <span className="font-mono text-xs">{__CHRONICLE_VERSION__}</span>
        </div>
        {serverVersion && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('settings.serverVersion')}</span>
            <span className="font-mono text-xs">{serverVersion}</span>
          </div>
        )}
      </div>
    </SectionPanel>
  )
}

export function SettingsPage() {
  const { t, setLocale } = useI18n()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dayOffset, setDayOffset] = useState(5)
  const [message, setMessage] = useState<SettingsMessage>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [clientLog, setClientLog] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [uiLanguage, setUiLanguage] = useState<string>('auto')
  const [serverVersion, setServerVersion] = useState('')
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(isTauriEnv ? 'general.language' : 'general.workday')
  const [llmSettings, setLlmSettings] = useState<LlmSettings>({
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 30000,
    meetingExtractionPrompt: '',
    defaultMeetingExtractionPrompt: '',
    taskSummaryPrompt: '',
    defaultTaskSummaryPrompt: '',
  })
  const [llmSaving, setLlmSaving] = useState(false)
  const [llmTesting, setLlmTesting] = useState(false)
  const [showPromptTest, setShowPromptTest] = useState(false)
  const [showTaskSummaryPromptTest, setShowTaskSummaryPromptTest] = useState(false)
  const [meetingExtractionLogs, setMeetingExtractionLogs] = useState<LlmCallLogSummary[]>([])
  const [meetingExtractionLogsLoading, setMeetingExtractionLogsLoading] = useState(false)
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const [taskSummaryLogs, setTaskSummaryLogs] = useState<LlmCallLogSummary[]>([])
  const [taskSummaryLogsLoading, setTaskSummaryLogsLoading] = useState(false)
  const [expandedTaskSummaryLogId, setExpandedTaskSummaryLogId] = useState<string | null>(null)

  const [autoAfkEnabled, setAutoAfkEnabled] = useState(false)
  const [screenLockEnabled, setScreenLockEnabled] = useState(true)
  const [idleEnabled, setIdleEnabled] = useState(true)
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(5)

  const settingsGroups = useMemo<SettingsTreeGroup[]>(() => {
    const groups: SettingsTreeGroup[] = [
      {
        id: 'general',
        label: 'General',
        items: [
          ...(isTauriEnv ? [{
            id: 'general.language' as const,
            label: t('settings.language'),
            description: 'Choose the UI language.',
          }] : []),
          {
            id: 'general.workday',
            label: 'Workday',
            description: 'Configure the day boundary used by reports.',
          },
        ],
      },
      {
        id: 'automation',
        label: 'Automation',
        items: isTauriEnv ? [{
          id: 'automation.autoAfk' as const,
          label: t('settings.autoAfkTitle'),
          description: 'Control automatic AFK triggers.',
        }] : [],
      },
      {
        id: 'ai',
        label: 'AI',
        items: [
          {
            id: 'ai.provider',
            label: 'Provider',
            description: 'Configure the shared LLM connection.',
          },
          {
            id: 'ai.meetingExtraction',
            label: 'Meeting Extraction',
            description: 'Edit the prompt, test it, and inspect this scene logs.',
          },
          {
            id: 'ai.taskSummary',
            label: 'Task Summary',
            description: 'Edit the prompt and inspect task summary calls.',
          },
        ],
      },
      {
        id: 'data',
        label: 'Data',
        items: [
          {
            id: 'data.database',
            label: 'Database',
            description: 'Inspect the current SQLite database.',
          },
          {
            id: 'data.importExport',
            label: 'Import / Export',
            description: 'Move Chronicle data in or out.',
          },
        ],
      },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        items: [
          ...(isTauriEnv ? [{
            id: 'diagnostics.clientLog' as const,
            label: 'Client Log',
            description: 'Inspect the desktop client log.',
          }] : []),
          ...(isTauriEnv ? [{
            id: 'diagnostics.version' as const,
            label: 'Version',
            description: 'Check UI and server versions.',
          }] : []),
        ],
      },
    ]
    return groups.filter(group => group.items.length > 0)
  }, [t])

  const activeItem = settingsGroups
    .flatMap(group => group.items)
    .find(item => item.id === activeSection) ?? settingsGroups[0]?.items[0]

  useEffect(() => {
    if (!settingsGroups.some(group => group.items.some(item => item.id === activeSection))) {
      setActiveSection(settingsGroups[0]?.items[0]?.id ?? 'general.workday')
    }
  }, [activeSection, settingsGroups])

  useEffect(() => {
    apiFetch('/api/settings/info')
      .then(r => r.json())
      .then(setInfo)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!showLog || !isTauriEnv) return
    setLogLoading(true)
    ;(window as any).__TAURI__.core.invoke('get_client_log')
      .then((log: string) => { setClientLog(log); setLogLoading(false) })
      .catch(() => { setClientLog(t('settings.logUnavailable')); setLogLoading(false) })
  }, [showLog, t])

  useEffect(() => {
    if (!isTauriEnv) return
    ;(window as any).__TAURI__.core.invoke('get_auto_afk_config')
      .then((cfg: any) => {
        setAutoAfkEnabled(cfg.enabled)
        setScreenLockEnabled(cfg.screen_lock_enabled)
        setIdleEnabled(cfg.idle_enabled)
        setIdleTimeoutMinutes(Math.round(cfg.idle_timeout_seconds / 60))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!isTauriEnv) return
    ;(window as any).__TAURI__.core.invoke('get_ui_language')
      .then((lang: string) => setUiLanguage(lang))
      .catch(() => {})
  }, [])

  useEffect(() => {
    apiFetch('/api/version')
      .then(r => r.json())
      .then(data => setServerVersion(data.version))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchStartOfDayOffset().then(setDayOffset).catch(() => {})
  }, [])

  useEffect(() => {
    fetchLlmSettings().then((settings) => setLlmSettings(displayLlmSettings(settings))).catch(() => {})
  }, [])

  const updateLlmSettings = (patch: Partial<LlmSettings>) => {
    setLlmSettings((current) => ({ ...current, ...patch }))
  }

  const handleSaveLlmSettings = async () => {
    setLlmSaving(true)
    setMessage(null)
    try {
      const saved = await saveLlmSettings(serializeLlmSettings(llmSettings))
      setLlmSettings(displayLlmSettings(saved))
      setMessage({ type: 'success', text: 'LLM settings saved' })
      setTimeout(() => setMessage(null), 3000)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || err?.message || 'Failed to save LLM settings' })
    } finally {
      setLlmSaving(false)
    }
  }

  const handleTestLlmConnection = async () => {
    setLlmTesting(true)
    setMessage(null)
    try {
      await saveLlmSettings(serializeLlmSettings(llmSettings))
      const result = await testLlmConnection()
      setMessage({ type: 'success', text: `LLM connection OK (${result.latencyMs ?? 0} ms)` })
      setTimeout(() => setMessage(null), 3000)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || err?.message || 'LLM connection failed' })
    } finally {
      setLlmTesting(false)
    }
  }

  const handleTestMeetingExtractionPrompt = async () => {
    try {
      const saved = await saveLlmSettings(serializeLlmSettings(llmSettings))
      setLlmSettings(displayLlmSettings(saved))
      setShowPromptTest(true)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || err?.message || 'Failed to save prompt before test' })
    }
  }

  const handleTestTaskSummaryPrompt = async () => {
    try {
      const saved = await saveLlmSettings(serializeLlmSettings(llmSettings))
      setLlmSettings(displayLlmSettings(saved))
      setShowTaskSummaryPromptTest(true)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || err?.message || 'Failed to save prompt before test' })
    }
  }

  const loadMeetingExtractionLogs = async () => {
    setMeetingExtractionLogsLoading(true)
    try {
      const res = await apiFetch('/api/llm-call-logs?feature=meeting_extract&limit=50')
      if (!res.ok) throw new Error('Failed to load LLM logs')
      setMeetingExtractionLogs(await res.json())
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to load LLM logs' })
    } finally {
      setMeetingExtractionLogsLoading(false)
    }
  }

  const loadTaskSummaryLogs = async () => {
    setTaskSummaryLogsLoading(true)
    try {
      const res = await apiFetch('/api/llm-call-logs?feature=task_summary&limit=50')
      if (!res.ok) throw new Error('Failed to load LLM logs')
      setTaskSummaryLogs(await res.json())
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to load LLM logs' })
    } finally {
      setTaskSummaryLogsLoading(false)
    }
  }

  const handleSaveLanguage = async (lang: string) => {
    setUiLanguage(lang)
    if (lang === 'zh-CN' || lang === 'zh') setLocale('zh-CN')
    else if (lang === 'en') setLocale('en')
    if (isTauriEnv) {
      try {
        await (window as any).__TAURI__.core.invoke('set_ui_language', { language: lang })
        setMessage({ type: 'success', text: t('settings.languageSaved') })
        setTimeout(() => setMessage(null), 3000)
      } catch {
        setMessage({ type: 'error', text: 'Failed to save language setting' })
      }
    }
  }

  const handleSaveAutoAfk = async () => {
    try {
      await (window as any).__TAURI__.core.invoke('set_auto_afk_config', {
        config: {
          enabled: autoAfkEnabled,
          screen_lock_enabled: screenLockEnabled,
          idle_enabled: idleEnabled,
          idle_timeout_seconds: idleTimeoutMinutes * 60,
        },
      })
      setMessage({ type: 'success', text: t('settings.autoAfkSaved') })
      setTimeout(() => setMessage(null), 3000)
    } catch {
      setMessage({ type: 'error', text: 'Failed to save Auto-AFK settings' })
    }
  }

  const handleExport = async () => {
    setExporting(true)
    setMessage(null)
    try {
      const res = await apiFetch('/api/settings/export')
      if (!res.ok) throw new Error('Export failed')
      const buffer = await res.arrayBuffer()

      try {
        const filePath = await save({
          title: 'Export Database',
          defaultPath: 'tasks.db',
          filters: [{ name: 'SQLite Database', extensions: ['db'] }],
        })
        if (!filePath) { setExporting(false); return }
        await writeFile(filePath, new Uint8Array(buffer))
      } catch {
        const blob = new Blob([buffer], { type: 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'tasks.db'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }

      setMessage({ type: 'success', text: t('settings.exportSuccess') })
    } catch {
      setMessage({ type: 'error', text: t('settings.exportError') })
    } finally {
      setExporting(false)
    }
  }

  const SQLITE_MAGIC = new Uint8Array([0x53, 0x51, 0x4C, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6F, 0x72, 0x6D, 0x61, 0x74, 0x20, 0x33, 0x00])

  function isValidSqlite(file: File): Promise<boolean> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const arr = new Uint8Array(e.target?.result as ArrayBuffer)
        resolve(arr.length >= 16 && arr.slice(0, 16).every((b, i) => b === SQLITE_MAGIC[i]))
      }
      reader.onerror = () => resolve(false)
      reader.readAsArrayBuffer(file.slice(0, 16))
    })
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const isValid = await isValidSqlite(file)
    if (!isValid) {
      setMessage({ type: 'error', text: t('settings.importInvalidFormat') })
      return
    }

    setPendingImportFile(file)
    setShowConfirmDialog(true)
  }

  const confirmImport = async () => {
    if (!pendingImportFile) return
    setShowConfirmDialog(false)
    setImporting(true)
    setMessage(null)
    try {
      const formData = new FormData()
      formData.set('file', pendingImportFile)
      const res = await apiFetch('/api/settings/import', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Import failed')
      const infoRes = await apiFetch('/api/settings/info')
      setInfo(await infoRes.json())
      setMessage({ type: 'success', text: t('settings.importSuccess') })
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || t('settings.importError') })
    } finally {
      setImporting(false)
      setPendingImportFile(null)
    }
  }

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'general.language':
        return isTauriEnv ? (
          <LanguageSettingsSection t={t} uiLanguage={uiLanguage} onSaveLanguage={handleSaveLanguage} />
        ) : null
      case 'general.workday':
        return <WorkdaySettingsSection dayOffset={dayOffset} setDayOffset={setDayOffset} />
      case 'automation.autoAfk':
        return isTauriEnv ? (
          <AutoAfkSettingsSection
            t={t}
            autoAfkEnabled={autoAfkEnabled}
            screenLockEnabled={screenLockEnabled}
            idleEnabled={idleEnabled}
            idleTimeoutMinutes={idleTimeoutMinutes}
            setAutoAfkEnabled={setAutoAfkEnabled}
            setScreenLockEnabled={setScreenLockEnabled}
            setIdleEnabled={setIdleEnabled}
            setIdleTimeoutMinutes={setIdleTimeoutMinutes}
            onSave={handleSaveAutoAfk}
          />
        ) : null
      case 'ai.provider':
        return (
          <LlmProviderSettingsSection
            settings={llmSettings}
            saving={llmSaving}
            testing={llmTesting}
            onUpdate={updateLlmSettings}
            onSave={handleSaveLlmSettings}
            onTest={handleTestLlmConnection}
          />
        )
      case 'ai.meetingExtraction':
        return (
          <MeetingExtractionSettingsSection
            settings={llmSettings}
            saving={llmSaving}
            logs={meetingExtractionLogs}
            logsLoading={meetingExtractionLogsLoading}
            expandedLogId={expandedLogId}
            onUpdate={updateLlmSettings}
            onSave={handleSaveLlmSettings}
            onTestPrompt={handleTestMeetingExtractionPrompt}
            onLoadLogs={loadMeetingExtractionLogs}
            onToggleExpandedLog={setExpandedLogId}
          />
        )
      case 'ai.taskSummary':
        return (
          <TaskSummarySettingsSection
            settings={llmSettings}
            saving={llmSaving}
            logs={taskSummaryLogs}
            logsLoading={taskSummaryLogsLoading}
            expandedLogId={expandedTaskSummaryLogId}
            onUpdate={updateLlmSettings}
            onSave={handleSaveLlmSettings}
            onTestPrompt={handleTestTaskSummaryPrompt}
            onLoadLogs={loadTaskSummaryLogs}
            onToggleExpandedLog={setExpandedTaskSummaryLogId}
          />
        )
      case 'data.database':
        return <DatabaseSettingsSection t={t} info={info} />
      case 'data.importExport':
        return (
          <ImportExportSettingsSection
            t={t}
            exporting={exporting}
            importing={importing}
            onExport={handleExport}
            onImport={handleImport}
          />
        )
      case 'diagnostics.clientLog':
        return isTauriEnv ? (
          <ClientLogSettingsSection
            showLog={showLog}
            clientLog={clientLog}
            logLoading={logLoading}
            setShowLog={setShowLog}
          />
        ) : null
      case 'diagnostics.version':
        return isTauriEnv ? <VersionSettingsSection t={t} serverVersion={serverVersion} /> : null
      default:
        return null
    }
  }

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden md:flex-row">
      <SettingsTree
        groups={settingsGroups}
        activeSection={activeSection}
        onSelect={setActiveSection}
      />

      <main className="min-w-0 flex-1 overflow-y-auto p-5 md:p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          <header>
            <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
            {activeItem && (
              <div className="mt-2">
                <div className="text-sm font-medium text-foreground">{activeItem.label}</div>
                <p className="text-sm text-muted-foreground">{activeItem.description}</p>
              </div>
            )}
          </header>

          <SettingsMessageBanner message={message} />
          {renderActiveSection()}
        </div>
      </main>

      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <DialogTitle>{t('settings.importWarning')}</DialogTitle>
            </div>
          </DialogHeader>
          <DialogBody className="pt-4">
            <DialogDescription>{t('settings.importWarningDesc')}</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <button onClick={() => setShowConfirmDialog(false)} className="dialog-button-secondary">
              {t('common.cancel')}
            </button>
            <button onClick={confirmImport} className="dialog-button-danger">
              {t('settings.importConfirm')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <MeetingExtractionDialog
        open={showPromptTest}
        mode="test"
        onOpenChange={setShowPromptTest}
      />
      <TaskSummaryPromptTestDialog
        open={showTaskSummaryPromptTest}
        onOpenChange={setShowTaskSummaryPromptTest}
      />
    </div>
  )
}
