import { useEffect, useState, useMemo } from 'react'
import { fetchTodayReport, fetchSummary, fetchSessions } from '@/services/api'
import { format, startOfWeek as dfStartOfWeek, startOfMonth, addDays, addWeeks, addMonths, isSameDay } from 'date-fns'
import { BarChart3, CheckCircle2, Clock, ListTodo, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Task, WorkSession } from '@/types'
import { priorityColors } from '@/types'
import { useI18n } from '@/i18n/context'
import { getTaskById } from '@/services/api'

type TimeView = 'day' | 'week' | 'month'

interface ReportData {
  totalToday: number
  completedToday: number
  inProgress: number
  tasks: Task[]
}

interface SummaryData {
  byType: Record<string, number>
  byPriority: Record<string, number>
  totalTasks: number
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}h ${minutes}m ${seconds}s`
}

export function ReportPage() {
  const { t, dateLocale } = useI18n()
  const [report, setReport] = useState<ReportData | null>(null)
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)

  // Time view state
  const [timeView, setTimeView] = useState<TimeView>('day')
  const [selectedDate, setSelectedDate] = useState(new Date())

  // Session data
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [sessionTasks, setSessionTasks] = useState<Record<string, Task>>({})
  const [sessionsLoading, setSessionsLoading] = useState(false)

  // Classic report data
  useEffect(() => {
    Promise.all([fetchTodayReport(), fetchSummary()])
      .then(([r, s]) => { setReport(r); setSummary(s) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Fetch sessions when time view or date changes
  useEffect(() => {
    const abortController = new AbortController()
    setSessionsLoading(true)
    let start: number, end: number

    if (timeView === 'day') {
      const dayStart = new Date(selectedDate)
      dayStart.setHours(0, 0, 0, 0)
      start = dayStart.getTime()
      const dayEnd = new Date(selectedDate)
      dayEnd.setHours(23, 59, 59, 999)
      end = dayEnd.getTime()
    } else if (timeView === 'week') {
      const weekStart = dfStartOfWeek(selectedDate, { weekStartsOn: 1 })
      weekStart.setHours(0, 0, 0, 0)
      start = weekStart.getTime()
      const weekEnd = addDays(weekStart, 1)
      weekEnd.setHours(23, 59, 59, 999)
      end = weekEnd.getTime()
      // Actually, we need the full week
      end = addDays(weekStart, 7).getTime() - 1
    } else {
      const monthStart = startOfMonth(selectedDate)
      monthStart.setHours(0, 0, 0, 0)
      start = monthStart.getTime()
      const monthEnd = addMonths(monthStart, 1)
      monthEnd.setHours(23, 59, 59, 999)
      end = monthEnd.getTime() - 1
    }

    let isStale = false

    fetchSessions(start, end).then(sessions => {
      if (isStale || abortController.signal.aborted) return
      setSessions(sessions)
      // Fetch task info for each unique task
      const uniqueTaskIds = [...new Set(sessions.map(s => s.taskId))]
      Promise.all(
        uniqueTaskIds.map(async (id) => {
          try {
            const task = await getTaskById(id)
            return { id, task }
          } catch {
            return { id, task: null }
          }
        })
      ).then(results => {
        if (isStale || abortController.signal.aborted) return
        const map: Record<string, Task> = {}
        results.forEach(({ id, task }) => {
          if (task) map[id] = task
        })
        setSessionTasks(map)
        setSessionsLoading(false)
      })
    }).catch(() => {
      if (!isStale && !abortController.signal.aborted) {
        setSessions([])
        setSessionsLoading(false)
      }
    })

    return () => {
      isStale = true
      abortController.abort()
    }
  }, [timeView, selectedDate])

  // Stats calculation
  const stats = useMemo(() => {
    if (sessions.length === 0) {
      return { onDuty: 0, workTime: 0, idleTime: 0 }
    }

    // Find the latest endedAt or use current time for ongoing sessions
    const latestEndedAt = sessions
      .filter(s => s.endedAt)
      .map(s => s.endedAt!)
      .sort((a, b) => b - a)[0]
    const now = latestEndedAt ?? Date.now()

    // Group sessions by day
    const dayMap = new Map<string, typeof sessions>()
    sessions.forEach(s => {
      const dayKey = format(new Date(s.startedAt), 'yyyy-MM-dd')
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, [])
      dayMap.get(dayKey)!.push(s)
    })

    let totalOnDuty = 0
    let totalWorkTime = 0

    dayMap.forEach(daySessions => {
      if (daySessions.length === 0) return

      const startedAts = daySessions.map(s => s.startedAt)
      // For endedAt, use actual endedAt or 'now' for ongoing sessions
      const endedAts = daySessions.map(s => s.endedAt ?? now)

      const firstTakeover = Math.min(...startedAts)
      const lastAfk = Math.max(...endedAts)
      const dayOnDuty = lastAfk - firstTakeover
      totalOnDuty += dayOnDuty

      const dayWorkTime = daySessions.reduce((sum, s) => {
        const endTime = s.endedAt ?? now
        return sum + (endTime - s.startedAt)
      }, 0)
      totalWorkTime += dayWorkTime
    })

    const idleTime = totalOnDuty - totalWorkTime
    return { onDuty: totalOnDuty, workTime: totalWorkTime, idleTime: Math.max(0, idleTime) }
  }, [sessions])

  // Group sessions by day for all views
  const groupedSessions = useMemo(() => {
    const groups: { date: Date; sessions: WorkSession[]; firstTakeOver: number; lastAfk: number }[] = []
    const dayMap = new Map<string, WorkSession[]>()

    const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt)
    sorted.forEach(s => {
      const dayKey = format(new Date(s.startedAt), 'yyyy-MM-dd')
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, [])
      dayMap.get(dayKey)!.push(s)
    })

    const now = Date.now()
    for (const [dateStr, daySessions] of dayMap) {
      const startedAts = daySessions.map(s => s.startedAt)
      const endedAts = daySessions.map(s => s.endedAt ?? now)
      groups.push({
        date: new Date(dateStr),
        sessions: daySessions.sort((a, b) => b.startedAt - a.startedAt),
        firstTakeOver: Math.min(...startedAts),
        lastAfk: Math.max(...endedAts),
      })
    }

    groups.sort((a, b) => b.date.getTime() - a.date.getTime())
    return groups
  }, [sessions])

  // Date display
  const dateDisplay = useMemo(() => {
    if (timeView === 'day') {
      const isToday = isSameDay(selectedDate, new Date())
      return { text: format(selectedDate, 'yyyy-MM-dd', { locale: dateLocale }), isToday }
    }
    if (timeView === 'week') {
      const monday = dfStartOfWeek(selectedDate, { weekStartsOn: 1 })
      const sunday = addDays(monday, 6)
      const isThisWeek = isSameDay(monday, dfStartOfWeek(new Date(), { weekStartsOn: 1 }))
      return { text: `${format(monday, 'MM-dd', { locale: dateLocale })} ~ ${format(sunday, 'MM-dd', { locale: dateLocale })}`, isToday: isThisWeek }
    }
    return { text: format(selectedDate, 'yyyy/MM', { locale: dateLocale }), isToday: isSameDay(startOfMonth(selectedDate), startOfMonth(new Date())) }
  }, [timeView, selectedDate, dateLocale])

  const navigateLeft = () => {
    if (timeView === 'day') setSelectedDate(d => addDays(d, -1))
    else if (timeView === 'week') setSelectedDate(d => addWeeks(d, -1))
    else setSelectedDate(d => addMonths(d, -1))
  }

  const navigateRight = () => {
    if (timeView === 'day') setSelectedDate(d => addDays(d, 1))
    else if (timeView === 'week') setSelectedDate(d => addWeeks(d, 1))
    else setSelectedDate(d => addMonths(d, 1))
  }

  const navigateReset = () => {
    setSelectedDate(new Date())
  }

  if (loading) return <div className="flex items-center justify-center h-40 text-muted-foreground">{t('report.loading')}</div>

  const today = format(new Date(), 'PPP EEEE', { locale: dateLocale })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('report.title')}</h1>
      <p className="text-muted-foreground">{today}</p>

      {/* Classic stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard icon={<ListTodo className="w-5 h-5" />} label={t('report.todayTotal')} value={report?.totalToday ?? 0} />
        <StatCard icon={<CheckCircle2 className="w-5 h-5" />} label={t('report.completed')} value={report?.completedToday ?? 0} />
        <StatCard icon={<Clock className="w-5 h-5" />} label={t('report.inProgress')} value={report?.inProgress ?? 0} />
        <StatCard icon={<BarChart3 className="w-5 h-5" />} label={t('report.total')} value={summary?.totalTasks ?? 0} />
      </div>

      {/* ==================== Work Session Section ==================== */}
      <div className="border rounded-lg flex flex-col" style={{ maxHeight: '600px' }}>
        {/* Tab bar */}
        <div className="px-4 py-3 border-b flex items-center gap-4 flex-shrink-0">
          {/* View tabs */}
          <div className="flex gap-1">
            {([
              { key: 'day' as TimeView, label: 'day' },
              { key: 'week' as TimeView, label: 'week' },
              { key: 'month' as TimeView, label: 'month' },
            ]).map(({ key, label }) => (
              <button
                key={key}
                className={`text-xs px-3 py-1.5 rounded transition ${
                  timeView === key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
                }`}
                onClick={() => setTimeView(key)}
              >
                {t(`report.${label}`)}
              </button>
            ))}
          </div>

          {/* Date navigation */}
          <div className="flex items-center gap-2">
            <button className="p-1 rounded hover:bg-muted transition" onClick={navigateLeft}>
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              className={`text-sm font-medium px-2 py-0.5 rounded transition ${
                dateDisplay.isToday ? 'bg-muted/50' : 'hover:bg-muted'
              }`}
              onClick={navigateReset}
            >
              {dateDisplay.text}
            </button>
            <button className="p-1 rounded hover:bg-muted transition" onClick={navigateRight}>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Stats overview */}
        <div className="px-4 py-3 border-b grid grid-cols-3 gap-4 flex-shrink-0">
          <div>
            <div className="text-xs text-muted-foreground mb-1">{t('report.onDuty')}</div>
            <div className="text-lg font-semibold">{formatDuration(stats.onDuty)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">{t('report.workTime')}</div>
            <div className="text-lg font-semibold text-green-600">{formatDuration(stats.workTime)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">{t('report.idleTime')}</div>
            <div className="text-lg font-semibold text-amber-600">{formatDuration(stats.idleTime)}</div>
          </div>
        </div>

        {/* Session list */}
        {sessionsLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('report.loading')}</div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('report.noSessions')}</div>
        ) : (
          <div className="divide-y overflow-y-auto flex-1">
            {groupedSessions.map(({ date, sessions: daySessions, firstTakeOver, lastAfk }) => (
              <div key={format(date, 'yyyy-MM-dd')}>
                <div className="px-4 py-2 bg-muted/30 text-sm">
                  <span className="font-medium">
                    {format(date, 'yyyy-MM-dd EEEE', { locale: dateLocale })}
                  </span>
                  <span className="text-muted-foreground ml-3">
                    {format(new Date(firstTakeOver), 'HH:mm')} — {format(new Date(lastAfk), 'HH:mm')}
                  </span>
                </div>
                {daySessions.map(session => (
                  <SessionRow key={session.id} session={session} task={sessionTasks[session.taskId]} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SessionRow({ session, task, serverNow }: { session: WorkSession; task?: Task; serverNow?: number }) {
  const { t, dateLocale } = useI18n()
  const startedAt = new Date(session.startedAt)
  const endedAt = session.endedAt ? new Date(session.endedAt) : null
  // Use serverNow if available, otherwise fallback to Date.now() with a warning
  const now = serverNow ?? Date.now()
  const duration = endedAt ? session.endedAt! - session.startedAt : now - session.startedAt

  return (
    <div className="px-4 py-3 flex items-center gap-6 text-sm">
      {/* Time */}
      <div className="w-32 flex-shrink-0">
        <div className="font-medium">{format(startedAt, 'HH:mm', { locale: dateLocale })}</div>
        {endedAt ? (
          <div className="text-muted-foreground">{format(endedAt, 'HH:mm', { locale: dateLocale })}</div>
        ) : (
          <div className="text-blue-500 text-xs">{t('report.ongoing')}</div>
        )}
      </div>

      {/* Duration */}
      <div className="w-20 flex-shrink-0 font-medium">
        {formatDuration(duration)}
      </div>

      {/* Task */}
      <div className="flex-1 min-w-0">
        {task ? (
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${priorityColors[task.priority as keyof typeof priorityColors]}`} />
            <span className="truncate">{task.title}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        )}
      </div>
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="border rounded-lg p-4 flex items-center gap-3">
      <div className="p-2 bg-muted rounded-md">{icon}</div>
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
