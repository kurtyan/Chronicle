import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { BoardPage } from './pages/BoardPage'
import { ReportPage } from './pages/ReportPage'
import { ListTodo, BarChart3, Square } from 'lucide-react'
import { useI18n } from './i18n/context'

function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()

  const navItems = [
    { path: '/', icon: <ListTodo className="w-5 h-5" />, label: t('sidebar.board') },
    { path: '/report', icon: <BarChart3 className="w-5 h-5" />, label: t('sidebar.report') },
  ]

  return (
    <aside className="w-12 border-r bg-card h-screen flex flex-col items-center py-4 gap-1 flex-shrink-0">
      {/* Logo placeholder */}
      <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center mb-4">
        <Square className="w-4 h-4 text-primary" />
      </div>
      <nav className="flex flex-col gap-1">
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
    </aside>
  )
}

function Layout() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/report" element={<ReportPage />} />
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
