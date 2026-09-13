import { ArrowLeft } from 'lucide-react'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useI18n } from '@/i18n/context'
import { readProjectNavigation } from '@/lib/projectNavigation'
import { useTaskStore } from '@/stores/taskStore'

export function ProjectReturnLink() {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useI18n()
  const context = readProjectNavigation(location.state, location.search)
  const linkedTaskId = context ? new URLSearchParams(location.search).get('task') : null
  // Project links remain useful after a reload. Apply their requested selection
  // once per navigation; subsequent ordinary Board selection stays in the store.
  useEffect(() => {
    if (linkedTaskId && linkedTaskId !== '__draft__' && useTaskStore.getState().activeTaskId !== linkedTaskId) {
      void useTaskStore.getState().setActiveTask(linkedTaskId)
    }
  }, [location.key, linkedTaskId])
  if (!context) return null
  return <div className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card px-5 py-2 text-xs" data-testid="project-return-context">
    <button className="inline-flex items-center gap-1.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => navigate(context.returnTo)}><ArrowLeft className="h-3.5 w-3.5" />{t('project.workspace.return')}</button>
    {context.periodLabel && <span className="text-muted-foreground/70">{context.periodLabel}</span>}
  </div>
}
