import { useState, useEffect } from 'react'
import { useI18n } from '../i18n/context'
import { Database, Download, Upload, AlertCircle, CheckCircle, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'

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

export function SettingsPage() {
  const { t } = useI18n()
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)

  useEffect(() => {
    fetch('/api/settings/info')
      .then(r => r.json())
      .then(setInfo)
      .catch(() => {})
  }, [])

  const handleExport = async () => {
    setExporting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/settings/export')
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
      const res = await fetch('/api/settings/import', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Import failed')
      const infoRes = await fetch('/api/settings/info')
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
    <div className="p-6 max-w-2xl mx-auto">
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
