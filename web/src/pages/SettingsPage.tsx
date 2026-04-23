import { useState, useEffect } from 'react'
import { useI18n } from '../i18n/context'
import { Database, Download, Upload, AlertCircle, CheckCircle, AlertTriangle, Terminal, Clock, Languages, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { isTauriEnv, ensureApiReady } from '@/services/httpApi'

interface SettingsInfo {
  dbPath: string
  dbSize: number
  lastBackupAt: number | null
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

// API base URL helper for Tauri vs non-Tauri
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = isTauriEnv ? await ensureApiReady() : ''
  const url = `${base}${path}`
  return fetch(url, init)
}

export function SettingsPage() {
  const { t, setLocale } = useI18n()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [clientLog, setClientLog] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [uiLanguage, setUiLanguage] = useState<string>('auto')
  const [serverVersion, setServerVersion] = useState('')

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

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPendingImportFile(file)
    setShowConfirmDialog(true)
    e.target.value = ''
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
    </div>
  )
}
