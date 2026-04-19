import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { BoardPage } from './pages/BoardPage'
import { ReportPage } from './pages/ReportPage'
import { SettingsPage } from './pages/SettingsPage'
import { ListTodo, BarChart3, Settings } from 'lucide-react'
import { useI18n } from './i18n/context'
import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSSE } from './hooks/useSSE'
import { isTauriEnv, apiBase } from './services/httpApi'

// Open links in system browser when running in Tauri
function useSystemBrowserLinks() {
  useEffect(() => {
    if (!(window as any).__TAURI__) return
    const handler = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a')
      if (link?.href) {
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
      <div className="relative mt-auto mb-3">
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

  const navItems = [
    { path: '/', icon: <ListTodo className="w-5 h-5" />, label: t('sidebar.board') },
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
      <SseStatusDot />
    </aside>
  )
}

function Layout() {
  useSystemBrowserLinks()
  useTauriZoom()
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/report" element={<ReportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
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
