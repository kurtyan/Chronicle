import { useEffect, useState, useMemo, useCallback } from 'react'
import { fetchTodayReport, fetchSummary, fetchSessions, fetchRangeStats } from '@/services/api'
import { format, startOfWeek as dfStartOfWeek, startOfMonth, addDays, addWeeks, addMonths, isSameDay } from 'date-fns'
import { BarChart3, CheckCircle2, Clock, ListTodo, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import type { Task, WorkSession } from '@/types'
import { priorityColors } from '@/types'
import { useI18n } from '@/i18n/context'
import { getTaskById } from '@/services/api'
import { registerShortcut } from '@/shortcuts/registry'

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
  const [_report, setReport] = useState<ReportData | null>(null)
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)

  // Time view state
  const [timeView, setTimeView] = useState<TimeView>('day')
  const [selectedDate, setSelectedDate] = useState(new Date())

  // Session data
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [sessionTasks, setSessionTasks] = useState<Record<string, Task>>({})
  const [sessionsLoading, setSessionsLoading] = useState(false)

  // Date-range stats (updates with selected date/view)
  const [dateRangeStats, setDateRangeStats] = useState({ total: 0, completed: 0, inProgress: 0 })

  // Work day offset (hours to shift day boundary, default +5)
  const [workDayOffset, setWorkDayOffset] = useState(() => {
    const saved = localStorage.getItem('chronicle_workday_offset')
    return saved ? parseInt(saved, 10) : 5
  })

  // Helper: clamp value to [min, max]
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(val, max))

  // Helper: get start/end timestamps for the date range in current time view, with offset applied
  const getDayRange = (): { start: number; end: number } => {
    if (timeView === 'day') {
      const d = new Date(selectedDate)
      d.setHours(0, 0, 0, 0)
      const start = d.getTime() + workDayOffset * 3600_000
      d.setDate(d.getDate() + 1)
      const end = d.getTime() + workDayOffset * 3600_000
      return { start, end }
    }
    if (timeView === 'week') {
      const ws = dfStartOfWeek(selectedDate, { weekStartsOn: 1 })
      ws.setHours(0, 0, 0, 0)
      const start = ws.getTime() + workDayOffset * 3600_000
      const end = addDays(ws, 7).getTime() + workDayOffset * 3600_000
      return { start, end }
    }
    const ms = startOfMonth(selectedDate)
    ms.setHours(0, 0, 0, 0)
    const start = ms.getTime() + workDayOffset * 3600_000
    const me = addMonths(ms, 1)
    me.setHours(0, 0, 0, 0)
    const end = me.getTime() + workDayOffset * 3600_000
    return { start, end }
  }

  // Helper: iterate each day in the range, compute { dayStart, dayEnd, daySessions }
  const getDaysInRange = (rangeStart: number, rangeEnd: number) => {
    const days: { date: Date; dayStart: number; dayEnd: number; daySessions: WorkSession[] }[] = []
    let d = new Date(rangeStart - workDayOffset * 3600_000)
    d.setHours(0, 0, 0, 0)
    while (d.getTime() + workDayOffset * 3600_000 < rangeEnd) {
      const dayStart = d.getTime() + workDayOffset * 3600_000
      d.setDate(d.getDate() + 1)
      const dayEnd = d.getTime() + workDayOffset * 3600_000
      days.push({
        date: new Date(dayStart),
        dayStart,
        dayEnd,
        daySessions: sessions.filter(s => s.startedAt >= dayStart && s.startedAt < dayEnd),
      })
    }
    return days
  }

  // Classic report data
  const loadData = useCallback(() => {
    setLoading(true)
    Promise.all([fetchTodayReport(), fetchSummary()])
      .then(([r, s]) => { setReport(r); setSummary(s) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Cmd+R: refresh report (registered with central dispatcher)
  useEffect(() => {
    const unregister = registerShortcut({
      id: 'refresh-report',
      combo: 'mod+r',
      label: 'Refresh report',
      scope: 'page',
      handler: loadData,
    })
    return unregister
  }, [loadData])

  // Fetch sessions + compute date-range stats when time view or date changes
  useEffect(() => {
    const abortController = new AbortController()
    setSessionsLoading(true)
    const { start, end } = getDayRange()

    let isStale = false

    // Fetch sessions
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

    // Fetch date-range stats from server
    fetchRangeStats(start, end).then(stats => {
      if (isStale || abortController.signal.aborted) return
      setDateRangeStats({ total: stats.total, completed: stats.completed, inProgress: stats.inProgress })
    })
      .catch(() => {
        if (!isStale && !abortController.signal.aborted) {
          setDateRangeStats({ total: 0, completed: 0, inProgress: 0 })
        }
      })

    return () => {
      isStale = true
      abortController.abort()
    }
  }, [timeView, selectedDate, workDayOffset])

  // Stats calculation — offset-based
  const stats = useMemo(() => {
    const range = getDayRange()
    const days = getDaysInRange(range.start, range.end)
    let totalOnDuty = 0
    let totalWorkTime = 0
    for (const { dayStart, dayEnd, daySessions } of days) {
      if (daySessions.length === 0) continue
      const firstTakeover = Math.min(...daySessions.map(s => s.startedAt))
      const lastAfk = daySessions.some(s => !s.endedAt)
        ? dayEnd
        : Math.max(...daySessions.map(s => s.endedAt!))
      totalOnDuty += lastAfk - firstTakeover
      totalWorkTime += daySessions.reduce((sum, s) => {
        const sessionEnd = s.endedAt ?? dayEnd
        return sum + Math.max(0, clamp(sessionEnd, dayStart, dayEnd) - clamp(s.startedAt, dayStart, dayEnd))
      }, 0)
    }
    return { onDuty: totalOnDuty, workTime: totalWorkTime, idleTime: Math.max(0, totalOnDuty - totalWorkTime) }
  }, [sessions, timeView, selectedDate, workDayOffset])

  // Group sessions by offset-based day
  const groupedSessions = useMemo(() => {
    const range = getDayRange()
    const days = getDaysInRange(range.start, range.end)
    return days
      .filter(d => d.daySessions.length > 0)
      .map(d => ({
        date: d.date,
        sessions: [...d.daySessions].sort((a, b) => b.startedAt - a.startedAt),
        firstTakeOver: Math.min(...d.daySessions.map(s => s.startedAt)),
        lastAfk: d.daySessions.some(s => !s.endedAt)
          ? d.dayEnd
          : Math.max(...d.daySessions.map(s => s.endedAt!)),
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime())
  }, [sessions, timeView, selectedDate, workDayOffset])

  // Date display
  const dateDisplay = useMemo(() => {
    const now = new Date()
    if (timeView === 'day') {
      const isToday = isSameDay(selectedDate, now)
      return { text: format(selectedDate, 'yyyy-MM-dd', { locale: dateLocale }), isToday }
    }
    if (timeView === 'week') {
      const monday = dfStartOfWeek(selectedDate, { weekStartsOn: 1 })
      const sunday = addDays(monday, 6)
      const thisMonday = dfStartOfWeek(now, { weekStartsOn: 1 })
      const isThisWeek = isSameDay(monday, thisMonday)
      return { text: `${format(monday, 'MM-dd', { locale: dateLocale })} ~ ${format(sunday, 'MM-dd', { locale: dateLocale })}`, isToday: isThisWeek }
    }
    const isThisMonth = selectedDate.getMonth() === now.getMonth() && selectedDate.getFullYear() === now.getFullYear()
    return { text: format(selectedDate, 'yyyy/MM', { locale: dateLocale }), isToday: isThisMonth }
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
    <div className="flex flex-col gap-6 p-4">
      <h1 className="text-2xl font-bold">{t('report.title')}</h1>
      <p className="text-muted-foreground">{today}</p>

      {/* Date view tabs + navigation - moved to top */}
      <div className="flex items-center gap-4">
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
          <div className="w-4" />
          {/* Offset config */}
          <div className="flex items-center gap-1">
            <span className="text-xs tabular-nums">+{workDayOffset}h</span>
            <div className="flex flex-col items-center gap-0">
              <button
                className="p-0.5 leading-none rounded hover:bg-muted transition"
                onClick={() => {
                  const v = Math.min(workDayOffset + 1, 12)
                  setWorkDayOffset(v)
                  localStorage.setItem('chronicle_workday_offset', String(v))
                }}
                title={t('report.workDayOffset')}
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                className="p-0.5 leading-none rounded hover:bg-muted transition"
                onClick={() => {
                  const v = Math.max(workDayOffset - 1, -12)
                  setWorkDayOffset(v)
                  localStorage.setItem('chronicle_workday_offset', String(v))
                }}
                title={t('report.workDayOffset')}
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Classic stats cards - now show date-range data */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard icon={<ListTodo className="w-5 h-5" />} label="Total" value={dateRangeStats.total} />
        <StatCard icon={<CheckCircle2 className="w-5 h-5" />} label={t('report.completed')} value={dateRangeStats.completed} />
        <StatCard icon={<Clock className="w-5 h-5" />} label={t('report.inProgress')} value={dateRangeStats.inProgress} />
        <StatCard icon={<BarChart3 className="w-5 h-5" />} label="Overall Tasks" value={summary?.totalTasks ?? 0} />
      </div>

      {/* ==================== Work Session Section ==================== */}
      <div className="border rounded-lg flex flex-col" style={{ maxHeight: '600px' }}>
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
