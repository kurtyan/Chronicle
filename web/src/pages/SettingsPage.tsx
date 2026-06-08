import { useState, useEffect } from 'react'
import { useI18n } from '../i18n/context'
import { Database, Download, Upload, AlertCircle, CheckCircle, AlertTriangle, Terminal, Clock, Languages, Info, Bot, FlaskConical, Save, FileText, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { isTauriEnv, ensureApiReady, clientId } from '@/services/httpApi'
import { fetchLlmSettings, fetchStartOfDayOffset, saveLlmSettings, setStartOfDayOffset, testLlmConnection } from '@/services/api'
import { MeetingExtractionDialog } from '@/components/MeetingExtractionDialog'
import type { LlmSettings } from '@/types'

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
  rawResponse: string | null
  parsedOutput: any
  status: string
  errorMessage: string | null
  latencyMs: number | null
  createdAt: number
  linkedTaskId: string | null
  linkedEntryId: string | null
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
      <pre className="max-h-64 overflow-auto rounded-md bg-background/70 border border-border/60 p-2 text-[11px] leading-4 font-mono whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function LogTextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-64 overflow-auto rounded-md bg-background/70 border border-border/60 p-2 text-[11px] leading-4 font-mono whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  )
}

function displayLlmSettings(settings: LlmSettings): LlmSettings {
  return {
    ...settings,
    meetingExtractionPrompt: settings.meetingExtractionPrompt || settings.defaultMeetingExtractionPrompt,
  }
}

function serializeLlmSettings(settings: LlmSettings): Partial<LlmSettings> {
  const prompt = settings.meetingExtractionPrompt.trim()
  const defaultPrompt = settings.defaultMeetingExtractionPrompt.trim()
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs,
    meetingExtractionPrompt: prompt === defaultPrompt ? '' : settings.meetingExtractionPrompt,
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

export function SettingsPage() {
  const { t, setLocale } = useI18n()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dayOffset, setDayOffset] = useState(5)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [clientLog, setClientLog] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [uiLanguage, setUiLanguage] = useState<string>('auto')
  const [serverVersion, setServerVersion] = useState('')
  const [llmSettings, setLlmSettings] = useState<LlmSettings>({
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 30000,
    meetingExtractionPrompt: '',
    defaultMeetingExtractionPrompt: '',
  })
  const [llmSaving, setLlmSaving] = useState(false)
  const [llmTesting, setLlmTesting] = useState(false)
  const [showPromptTest, setShowPromptTest] = useState(false)
  const [llmLogs, setLlmLogs] = useState<LlmCallLogSummary[]>([])
  const [llmLogsLoading, setLlmLogsLoading] = useState(false)
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)

  // Auto-AFK state
  const [autoAfkEnabled, setAutoAfkEnabled] = useState(false)
  const [screenLockEnabled, setScreenLockEnabled] = useState(true)
  const [idleEnabled, setIdleEnabled] = useState(true)
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(5)

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
  }, [showLog])

  // Load auto-AFK config on mount
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

  // Load UI language on mount
  useEffect(() => {
    if (!isTauriEnv) return
    ;(window as any).__TAURI__.core.invoke('get_ui_language')
      .then((lang: string) => setUiLanguage(lang))
      .catch(() => {})
  }, [])

  // Fetch server version
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

  const loadLlmLogs = async () => {
    setLlmLogsLoading(true)
    try {
      const res = await apiFetch('/api/llm-call-logs?feature=meeting_extract&limit=50')
      if (!res.ok) throw new Error('Failed to load LLM logs')
      setLlmLogs(await res.json())
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to load LLM logs' })
    } finally {
      setLlmLogsLoading(false)
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

      // Try native save dialog first (Tauri), fallback to browser download
      try {
        const filePath = await save({
          title: 'Export Database',
          defaultPath: 'tasks.db',
          filters: [{ name: 'SQLite Database', extensions: ['db'] }],
        })
        if (!filePath) { setExporting(false); return }
        await writeFile(filePath, new Uint8Array(buffer))
      } catch {
        // Fallback: browser download
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

  // SQLite magic bytes: "SQLite format 3\0"
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

  return (
    <div className="p-6 max-w-2xl mx-auto h-screen overflow-y-auto">
      <h1 className="text-2xl font-semibold mb-6">{t('settings.title')}</h1>

      {/* Start of Day Offset */}
      <div className="bg-card rounded-lg border p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-medium">{t('settings.startOfDayOffset')}</h2>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={23}
            value={dayOffset}
            onChange={(e) => setDayOffset(parseInt(e.target.value))}
            onMouseUp={() => setStartOfDayOffset(dayOffset)}
            className="flex-1"
          />
          <span className="text-sm font-mono w-16 text-right">+{dayOffset}h</span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {t('settings.startOfDayOffsetHint')}
        </p>
      </div>

      {/* LLM Settings */}
      <div className="bg-card rounded-lg border p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Bot className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-medium">LLM Configuration</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Base URL</span>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
              value={llmSettings.baseUrl}
              onChange={(e) => updateLlmSettings({ baseUrl: e.target.value })}
              placeholder="http://localhost:11434/v1"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Model</span>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
              value={llmSettings.model}
              onChange={(e) => updateLlmSettings({ model: e.target.value })}
              placeholder="qwen2.5:7b"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">API Key</span>
            <input
              type="password"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
              value={llmSettings.apiKey}
              onChange={(e) => updateLlmSettings({ apiKey: e.target.value })}
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
              value={llmSettings.timeoutMs}
              onChange={(e) => updateLlmSettings({ timeoutMs: parseInt(e.target.value, 10) || 30000 })}
            />
          </label>
        </div>
        <label className="block space-y-1 mt-3">
          <span className="text-xs font-medium text-muted-foreground">会议抽取 Prompt</span>
          <textarea
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary resize-y min-h-[180px]"
            value={llmSettings.meetingExtractionPrompt}
            onChange={(e) => updateLlmSettings({ meetingExtractionPrompt: e.target.value })}
            placeholder="Meeting extraction prompt"
          />
          <span className="text-[11px] text-muted-foreground">
            Default prompt is shown here when no custom prompt is saved. Editing it makes the prompt custom.
          </span>
        </label>
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={handleSaveLlmSettings}
            disabled={llmSaving}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {llmSaving ? 'Saving...' : 'Save LLM Settings'}
          </button>
          <button
            onClick={handleTestLlmConnection}
            disabled={llmTesting}
            className="flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
          >
            <FlaskConical className="w-4 h-4" />
            {llmTesting ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            onClick={async () => {
              await saveLlmSettings(serializeLlmSettings(llmSettings))
              setShowPromptTest(true)
            }}
            className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-muted transition"
          >
            <Bot className="w-4 h-4" />
            Test Meeting Extraction Prompt
          </button>
        </div>
      </div>

      {/* LLM Call Logs */}
      <div className="bg-card rounded-lg border p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-medium">LLM Call Logs</h2>
          </div>
          <button
            onClick={loadLlmLogs}
            disabled={llmLogsLoading}
            className="dialog-button-secondary"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${llmLogsLoading ? 'animate-spin' : ''}`} />
            {llmLogs.length === 0 ? 'Load Logs' : 'Refresh'}
          </button>
        </div>
        {llmLogs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No logs loaded. Click Load Logs to inspect recent meeting extraction calls.</p>
        ) : (
          <div className="space-y-2">
            {llmLogs.map((log) => {
              const mode = log.requestInput?.mode ?? 'unknown'
              const expanded = expandedLogId === log.id
              return (
                <div key={log.id} className="rounded-md border border-border/70 bg-muted/10">
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-muted/40 transition"
                    onClick={() => setExpandedLogId(expanded ? null : log.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            log.status === 'success'
                              ? 'bg-green-500/10 text-green-600'
                              : log.status === 'parse_error'
                                ? 'bg-amber-500/10 text-amber-600'
                                : 'bg-red-500/10 text-red-600'
                          }`}>
                            {log.status}
                          </span>
                          <span className="text-xs text-muted-foreground">{mode}</span>
                          <span className="text-xs text-muted-foreground truncate">{log.promptVersion}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground font-mono truncate">
                          {log.id}
                        </div>
                      </div>
                      <div className="text-right text-xs text-muted-foreground shrink-0">
                        <div>{formatTimestamp(log.createdAt)}</div>
                        <div>{log.latencyMs ?? 0} ms{log.linkedTaskId ? ` · ${log.linkedTaskId}` : ''}</div>
                      </div>
                    </div>
                  </button>
                  {expanded && (
                    <div className="border-t border-border/70 p-3 space-y-3">
                      <LogJsonBlock label="Request Input" value={log.requestInput} />
                      <LogJsonBlock label="Request Messages" value={log.requestMessages} />
                      <LogJsonBlock label="Parsed Output" value={log.parsedOutput} />
                      {log.rawResponse && <LogTextBlock label="Raw Response" value={log.rawResponse} />}
                      {log.errorMessage && <LogTextBlock label="Error" value={log.errorMessage} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Database Info */}
      <div className="bg-card rounded-lg border p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Database className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-medium">{t('settings.databaseInfo')}</h2>
        </div>
        {info ? (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('settings.dbPath')}</span>
              <span className="font-mono">{info.dbPath}</span>
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
          <p className="text-muted-foreground text-sm">Loading...</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          {exporting ? t('settings.exporting') : t('settings.export')}
        </button>

        <label className="flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:opacity-90 cursor-pointer disabled:opacity-50">
          <Upload className="w-4 h-4" />
          {importing ? t('settings.importing') : t('settings.import')}
          <input
            type="file"
            accept=".db"
            onChange={handleImport}
            className="hidden"
            disabled={importing}
          />
        </label>
      </div>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-md text-sm ${
          message.type === 'success'
            ? 'bg-green-500/10 text-green-500'
            : 'bg-red-500/10 text-red-500'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {message.text}
        </div>
      )}

      {/* Client Log (Tauri only) */}
      {isTauriEnv && (
        <div className="bg-card rounded-lg border p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-medium">Client Log</h2>
            </div>
            <button
              onClick={() => setShowLog(v => !v)}
              className="text-xs px-2 py-1 rounded border hover:bg-muted transition"
            >
              {showLog ? 'Close' : 'View Log'}
            </button>
          </div>
          {showLog && (
            <textarea
              readOnly
              value={clientLog}
              rows={12}
              className="w-full text-xs font-mono bg-background border rounded p-2 resize-none"
              placeholder={logLoading ? 'Loading...' : 'No log available'}
            />
          )}
        </div>
      )}

      {/* Version Info (Tauri only) */}
      {isTauriEnv && (
        <div className="bg-card rounded-lg border p-4 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Info className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-medium">{t('settings.versionInfo')}</h2>
          </div>
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
        </div>
      )}

      {/* Language Settings (Tauri only) */}
      {isTauriEnv && (
        <div className="bg-card rounded-lg border p-4 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Languages className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-medium">{t('settings.language')}</h2>
          </div>
          <div className="flex gap-2">
            {[
              { value: 'auto', label: t('settings.languageAuto') },
              { value: 'zh-CN', label: t('settings.languageZh') },
              { value: 'en', label: t('settings.languageEn') },
            ].map(({ value, label }) => (
              <button
                key={value}
                className={`text-sm px-4 py-2 rounded-lg border transition ${
                  uiLanguage === value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'hover:bg-muted border-border'
                }`}
                onClick={() => handleSaveLanguage(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">{t('settings.languageDesc')}</p>
        </div>
      )}

      {/* Auto-AFK Settings (Tauri only) */}
      {isTauriEnv && (
        <div className="bg-card rounded-lg border p-4 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-medium">{t('settings.autoAfkTitle')}</h2>
          </div>

          <div className="space-y-4">
            {/* Master toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoAfkEnabled}
                onChange={(e) => setAutoAfkEnabled(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm font-medium">{t('settings.autoAfkEnabled')}</span>
            </label>

            {autoAfkEnabled && (
              <div className="ml-7 space-y-4 border-l-2 border-muted pl-4 pb-2">
                {/* Screen lock AFK */}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={screenLockEnabled}
                      onChange={(e) => setScreenLockEnabled(e.target.checked)}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-sm font-medium">{t('settings.screenLockAfk')}</span>
                  </label>
                  <p className="text-xs text-muted-foreground ml-7 mt-1">{t('settings.screenLockAfkDesc')}</p>
                </div>

                {/* Idle AFK */}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={idleEnabled}
                      onChange={(e) => setIdleEnabled(e.target.checked)}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-sm font-medium">{t('settings.idleAfk')}</span>
                  </label>
                  <p className="text-xs text-muted-foreground ml-7 mt-1">{t('settings.idleAfkDesc')}</p>

                  {idleEnabled && (
                    <div className="flex items-center gap-2 ml-7 mt-2">
                      <label className="text-sm text-muted-foreground">{t('settings.idleTimeout')}:</label>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={idleTimeoutMinutes}
                        onChange={(e) => setIdleTimeoutMinutes(Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 1)))}
                        className="w-16 px-2 py-1 text-sm border rounded bg-background"
                      />
                      <span className="text-sm text-muted-foreground">{t('settings.idleTimeoutMinutes')}</span>
                    </div>
                  )}
                </div>

                <button
                  onClick={handleSaveAutoAfk}
                  className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:opacity-90 transition"
                >
                  {t('settings.saveAutoAfk')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import Confirmation Dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              <DialogTitle>{t('settings.importWarning')}</DialogTitle>
            </div>
            <DialogDescription>{t('settings.importWarningDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setShowConfirmDialog(false)}
              className="px-4 py-2 rounded-md border hover:bg-muted transition"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirmImport}
              className="px-4 py-2 rounded-md bg-destructive text-destructive-foreground hover:opacity-90 transition"
            >
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
    </div>
  )
}
