import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { fetchTodayReport, fetchSummary, fetchSessions, fetchRangeStats, fetchReportTasks, getAfkEvents } from '@/services/api'
import { format, startOfWeek as dfStartOfWeek, startOfMonth, addDays, addWeeks, addMonths, isSameDay } from 'date-fns'
import { BarChart3, CheckCircle2, Clock, ListTodo, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X } from 'lucide-react'
import type { Task, WorkSession, AfkEvent } from '@/types'
import { priorityColors } from '@/types'
import { useI18n } from '@/i18n/context'
import { getTaskById, fetchTaskEntries } from '@/services/api'
import { registerShortcut } from '@/shortcuts/registry'

type TimeView = 'day' | 'week' | 'month'
type StatFilter = 'NEW' | 'COMPLETED' | 'IN_PROGRESS' | 'ALL'

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

interface ReportTask extends Task {
  body: string
  workMs: number
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}

type RecordType = 'work' | 'afk' | 'gap'

interface TimeRecord {
  type: RecordType
  startedAt: number
  endedAt: number
  session?: WorkSession
  afkEvent?: AfkEvent
  task?: Task
}

function buildDayTimeline(
  dayStart: number,
  dayEnd: number,
  daySessions: WorkSession[],
  dayAfkEvents: AfkEvent[],
  sessionTasks: Record<string, Task>,
  now: number
): TimeRecord[] {
  const items: { type: 'work' | 'afk'; start: number; end: number; session?: WorkSession; afkEvent?: AfkEvent }[] = []

  for (const s of daySessions) {
    const start = Math.max(s.startedAt, dayStart)
    const end = s.endedAt ? Math.min(s.endedAt, dayEnd) : Math.min(dayEnd, now)
    if (start < end) items.push({ type: 'work', start, end, session: s })
  }

  for (const a of dayAfkEvents) {
    const start = Math.max(a.triggeredAt, dayStart)
    const end = a.submittedAt ? Math.min(a.submittedAt, dayEnd) : Math.min(dayEnd, now)
    if (start < end) items.push({ type: 'afk', start, end, afkEvent: a })
  }

  items.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))

  const records: TimeRecord[] = []
  let cursor = dayStart

  for (const item of items) {
    if (item.end <= cursor) continue
    if (item.start > cursor + 1000) {
      records.push({ type: 'gap', startedAt: cursor, endedAt: item.start })
    }
    const effectiveStart = Math.max(item.start, cursor)
    if (effectiveStart < item.end) {
      records.push({
        type: item.type,
        startedAt: effectiveStart,
        endedAt: item.end,
        session: item.session,
        afkEvent: item.afkEvent,
        task: item.session ? sessionTasks[item.session.taskId] : undefined,
      })
    }
    cursor = Math.max(cursor, item.end)
  }

  if (cursor < dayEnd - 1000) {
    records.push({ type: 'gap', startedAt: cursor, endedAt: dayEnd })
  }

  return records
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
  const [afkEvents, setAfkEvents] = useState<AfkEvent[]>([])
  const [sessionTasks, setSessionTasks] = useState<Record<string, Task>>({})
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<'onDuty' | 'workTime' | 'idleTime' | null>(null)

  // Date-range stats
  const [dateRangeStats, setDateRangeStats] = useState({ total: 0, completed: 0, inProgress: 0 })

  // Task list from new API
  const [reportTasks, setReportTasks] = useState<ReportTask[]>([])
  const [allTasksTotal, setAllTasksTotal] = useState(0)
  const [allTasksPage, setAllTasksPage] = useState(1)
  const [allTasksHasMore, setAllTasksHasMore] = useState(false)
  const [selectedStatFilter, setSelectedStatFilter] = useState<StatFilter>('COMPLETED')
  const [allTasksLoading, setAllTasksLoading] = useState(false)

  // Side panel
  const [selectedTask, setSelectedTask] = useState<ReportTask | null>(null)
  const [taskEntries, setTaskEntries] = useState<{ id: string; content: string; type: string; createdAt: number }[]>([])

  // Work day offset
  const [workDayOffset, setWorkDayOffset] = useState(() => {
    const saved = localStorage.getItem('chronicle_workday_offset')
    return saved ? parseInt(saved, 10) : 5
  })

  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(val, max))

  // Live timer: only tick when viewing a period that includes today
  const [nowTick, setNowTick] = useState(Date.now())
  const nowTickRef = useRef(nowTick)
  nowTickRef.current = nowTick
  const isCurrentDay = (): boolean => {
    const today = new Date()
    if (timeView === 'day') return isSameDay(selectedDate, today)
    if (timeView === 'week') {
      const ws = dfStartOfWeek(selectedDate, { weekStartsOn: 1 })
      const we = addDays(ws, 7)
      const tws = dfStartOfWeek(today, { weekStartsOn: 1 })
      const twe = addDays(tws, 7)
      return ws.getTime() === tws.getTime() && we.getTime() === twe.getTime()
    }
    return selectedDate.getMonth() === today.getMonth() && selectedDate.getFullYear() === today.getFullYear()
  }
  useEffect(() => {
    if (!isCurrentDay()) return
    setNowTick(Date.now())
    const timer = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [timeView, selectedDate])

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

  // Fetch sessions + date-range stats + report tasks when time view or date changes
  useEffect(() => {
    const abortController = new AbortController()
    setSessionsLoading(true)
    const { start, end } = getDayRange()

    let isStale = false

    // Fetch sessions
    fetchSessions(start, end).then(sessions => {
      if (isStale || abortController.signal.aborted) return
      setSessions(sessions)
      const uniqueTaskIds = [...new Set(sessions.map(s => s.taskId))]
      Promise.all(
        uniqueTaskIds.map(async (id) => {
          try { return { id, task: await getTaskById(id) } }
          catch { return { id, task: null } }
        })
      ).then(results => {
        if (isStale || abortController.signal.aborted) return
        const map: Record<string, Task> = {}
        results.forEach(({ id, task }) => { if (task) map[id] = task })
        setSessionTasks(map)
        setSessionsLoading(false)
      })
    }).catch(() => {
      if (!isStale && !abortController.signal.aborted) {
        setSessions([])
        setSessionsLoading(false)
      }
    })

    // Fetch AFK events
    getAfkEvents(start, end).then(events => {
      if (isStale || abortController.signal.aborted) return
      setAfkEvents(events)
    }).catch(() => {
      if (!isStale && !abortController.signal.aborted) {
        setAfkEvents([])
      }
    })

    // Fetch date-range stats
    fetchRangeStats(start, end).then(stats => {
      if (isStale || abortController.signal.aborted) return
      setDateRangeStats({ total: stats.total, completed: stats.completed, inProgress: stats.inProgress })
    }).catch(() => {
      if (!isStale && !abortController.signal.aborted) {
        setDateRangeStats({ total: 0, completed: 0, inProgress: 0 })
      }
    })

    return () => { isStale = true; abortController.abort() }
  }, [timeView, selectedDate, workDayOffset])

  // Fetch report tasks when filter or date range changes
  useEffect(() => {
    const abortController = new AbortController()
    const { start, end } = getDayRange()
    let isStale = false

    if (selectedStatFilter === 'ALL') {
      setAllTasksLoading(true)
      setAllTasksPage(1)
    }

    const page = selectedStatFilter === 'ALL' ? 1 : 1
    const pageSize = selectedStatFilter === 'ALL' ? 50 : 1000

    fetchReportTasks({ start, end, filter: selectedStatFilter, page, pageSize })
      .then(data => {
        if (isStale || abortController.signal.aborted) return
        setReportTasks(data.items)
        if (selectedStatFilter === 'ALL') {
          setAllTasksTotal(data.total)
          setAllTasksHasMore(data.hasMore)
          setAllTasksLoading(false)
        }
      })
      .catch(() => {
        if (!isStale && !abortController.signal.aborted) {
          setReportTasks([])
          if (selectedStatFilter === 'ALL') setAllTasksLoading(false)
        }
      })

    return () => { isStale = true; abortController.abort() }
  }, [selectedStatFilter, timeView, selectedDate, workDayOffset])

  // When stat filter or reportTasks change, update selectedTask if it no longer matches
  useEffect(() => {
    if (selectedTask) {
      const exists = filteredTasks.some(t => t.id === selectedTask.id)
      if (!exists) setSelectedTask(null)
    }
  }, [selectedStatFilter, reportTasks])

  // Stats calculation — offset-based, includes AFK events
  const stats = useMemo(() => {
    const range = getDayRange()
    const days = getDaysInRange(range.start, range.end)
    const current = isCurrentDay()
    const now = current ? nowTickRef.current : Date.now()
    let totalOnDuty = 0
    let totalWorkTime = 0
    for (const { dayStart, dayEnd, daySessions } of days) {
      const hasWork = daySessions.length > 0
      const dayAfk = afkEvents.filter(a =>
        (a.triggeredAt >= dayStart && a.triggeredAt < dayEnd) ||
        (a.submittedAt && a.submittedAt >= dayStart && a.submittedAt < dayEnd) ||
        (a.triggeredAt < dayStart && (!a.submittedAt || a.submittedAt >= dayStart))
      )
      const hasAfk = dayAfk.length > 0
      if (!hasWork && !hasAfk) continue

      const onDutyStart = hasWork
        ? (hasAfk
          ? Math.min(Math.min(...daySessions.map(s => s.startedAt)), Math.min(...dayAfk.map(a => a.triggeredAt)))
          : Math.min(...daySessions.map(s => s.startedAt)))
        : Math.min(...dayAfk.map(a => a.triggeredAt))

      const lastSessionEnd = hasWork
        ? (daySessions.some(s => !s.endedAt) ? Math.min(dayEnd, now) : Math.max(...daySessions.map(s => s.endedAt!)))
        : -Infinity
      const lastAfkEnd = hasAfk
        ? (dayAfk.some(a => !a.submittedAt) ? Math.min(dayEnd, now) : Math.max(...dayAfk.map(a => a.submittedAt!)))
        : -Infinity
      const onDutyEnd = Math.max(lastSessionEnd, lastAfkEnd)

      totalOnDuty += Math.max(0, onDutyEnd - onDutyStart)
      totalWorkTime += daySessions.reduce((sum, s) => {
        const sessionEnd = s.endedAt ?? Math.min(dayEnd, now)
        return sum + Math.max(0, clamp(sessionEnd, dayStart, dayEnd) - clamp(s.startedAt, dayStart, dayEnd))
      }, 0)
    }
    return { onDuty: totalOnDuty, workTime: totalWorkTime, idleTime: Math.max(0, totalOnDuty - totalWorkTime) }
  }, [sessions, afkEvents, timeView, selectedDate, workDayOffset, nowTick])

  // Group sessions by offset-based day
  const groupedSessions = useMemo(() => {
    const range = getDayRange()
    const days = getDaysInRange(range.start, range.end)
    const current = isCurrentDay()
    return days
      .filter(d => d.daySessions.length > 0)
      .map(d => ({
        date: d.date,
        sessions: [...d.daySessions].sort((a, b) => b.startedAt - a.startedAt),
        firstTakeOver: Math.min(...d.daySessions.map(s => s.startedAt)),
        lastAfk: d.daySessions.some(s => !s.endedAt)
          ? Math.min(d.dayEnd, current ? nowTickRef.current : Date.now())
          : Math.max(...d.daySessions.map(s => s.endedAt!)),
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime())
  }, [sessions, timeView, selectedDate, workDayOffset, nowTick])

  // Merged day timelines (work + afk + gaps)
  const dayTimelines = useMemo(() => {
    const range = getDayRange()
    const days = getDaysInRange(range.start, range.end)
    const current = isCurrentDay()
    const now = current ? nowTickRef.current : Date.now()

    return days.map(d => {
      const dayAfk = afkEvents.filter(a =>
        (a.triggeredAt >= d.dayStart && a.triggeredAt < d.dayEnd) ||
        (a.submittedAt && a.submittedAt >= d.dayStart && a.submittedAt < d.dayEnd) ||
        (a.triggeredAt < d.dayStart && (!a.submittedAt || a.submittedAt >= d.dayStart))
      )

      const hasWork = d.daySessions.length > 0
      const hasAfk = dayAfk.length > 0

      const onDutyStart = hasWork
        ? (hasAfk
          ? Math.min(Math.min(...d.daySessions.map(s => s.startedAt)), Math.min(...dayAfk.map(a => a.triggeredAt)))
          : Math.min(...d.daySessions.map(s => s.startedAt)))
        : (hasAfk ? Math.min(...dayAfk.map(a => a.triggeredAt)) : d.dayStart)

      const lastSessionEnd = hasWork
        ? (d.daySessions.some(s => !s.endedAt) ? Math.min(d.dayEnd, now) : Math.max(...d.daySessions.map(s => s.endedAt!)))
        : -Infinity
      const lastAfkEnd = hasAfk
        ? (dayAfk.some(a => !a.submittedAt) ? Math.min(d.dayEnd, now) : Math.max(...dayAfk.map(a => a.submittedAt!)))
        : -Infinity
      const onDutyEnd = Math.max(lastSessionEnd, lastAfkEnd, d.dayStart)

      const records = buildDayTimeline(onDutyStart, onDutyEnd, d.daySessions, dayAfk, sessionTasks, now)

      return { date: d.date, dayStart: d.dayStart, dayEnd: d.dayEnd, onDutyStart, onDutyEnd, records }
    }).filter(d => d.records.length > 0)
      .sort((a, b) => b.date.getTime() - a.date.getTime())
  }, [sessions, afkEvents, sessionTasks, timeView, selectedDate, workDayOffset, nowTick])

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

  const navigateReset = () => setSelectedDate(new Date())

  // Filtered tasks — server-side filtered, no client-side filtering needed
  const filteredTasks = reportTasks

  const loadMoreAllTasks = () => {
    if (!allTasksHasMore) return
    const nextPage = allTasksPage + 1
    setAllTasksPage(nextPage)
    const { start, end } = getDayRange()
    fetchReportTasks({ start, end, filter: 'ALL', page: nextPage, pageSize: 50 })
      .then(data => {
        setReportTasks(prev => [...prev, ...data.items])
        setAllTasksTotal(data.total)
        setAllTasksHasMore(data.hasMore)
      })
      .catch(() => {})
  }

  // Open side panel for a task
  const openTaskDetail = async (task: ReportTask) => {
    setSelectedTask(task)
    try {
      const entries = await fetchTaskEntries(task.id)
      setTaskEntries(entries)
    } catch {
      setTaskEntries([])
    }
  }

  // ESC to close side panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedTask) {
        setSelectedTask(null)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedTask])

  if (loading) return <div className="flex items-center justify-center h-40 text-muted-foreground">{t('report.loading')}</div>

  const today = format(new Date(), 'PPP EEEE', { locale: dateLocale })

  return (
    <div className="flex h-full">
      <div className="flex flex-col gap-4 p-4 flex-1 min-h-0 overflow-hidden">
        <h1 className="text-2xl font-bold">{t('report.title')}</h1>
        <p className="text-muted-foreground">{today}</p>

        {/* Date view tabs + navigation */}
        <div className="flex items-center gap-4 shrink-0">
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

        {/* Stats row with expandable list */}
        <div className="border rounded-lg">
          <div className="grid grid-cols-3 divide-x">
            <div className={`px-4 py-3 transition-colors ${activeSection === 'onDuty' ? 'bg-muted/20' : ''}`}>
              <div className="text-xs text-muted-foreground mb-1">{t('report.onDuty')}</div>
              <button
                className="text-lg font-semibold underline decoration-dotted hover:decoration-solid hover:text-foreground transition-all cursor-pointer"
                onClick={() => setActiveSection(prev => prev === 'onDuty' ? null : 'onDuty')}
              >
                {formatDuration(stats.onDuty)}
              </button>
            </div>
            <div className={`px-4 py-3 transition-colors ${activeSection === 'workTime' ? 'bg-muted/20' : ''}`}>
              <div className="text-xs text-muted-foreground mb-1">{t('report.workTime')}</div>
              <button
                className="text-lg font-semibold text-green-600 underline decoration-dotted hover:decoration-solid hover:text-foreground transition-all cursor-pointer"
                onClick={() => setActiveSection(prev => prev === 'workTime' ? null : 'workTime')}
              >
                {formatDuration(stats.workTime)}
              </button>
            </div>
            <div className={`px-4 py-3 transition-colors ${activeSection === 'idleTime' ? 'bg-muted/20' : ''}`}>
              <div className="text-xs text-muted-foreground mb-1">{t('report.idleTime')}</div>
              <button
                className="text-lg font-semibold text-amber-600 underline decoration-dotted hover:decoration-solid hover:text-foreground transition-all cursor-pointer"
                onClick={() => setActiveSection(prev => prev === 'idleTime' ? null : 'idleTime')}
              >
                {formatDuration(stats.idleTime)}
              </button>
            </div>
          </div>

          {activeSection === 'onDuty' && (
            dayTimelines.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground border-t">{t('report.noSessions')}</div>
            ) : (
              <div className="divide-y max-h-[300px] overflow-y-auto border-t">
                {dayTimelines.map(({ date, onDutyStart, onDutyEnd, records }) => (
                  <div key={format(date, 'yyyy-MM-dd')}>
                    <div className="px-4 py-2 bg-muted/30 text-sm">
                      <span className="font-medium">
                        {format(date, 'yyyy-MM-dd EEEE', { locale: dateLocale })}
                      </span>
                      <span className="text-muted-foreground ml-3">
                        {format(new Date(onDutyStart), 'HH:mm')} — {format(new Date(onDutyEnd), 'HH:mm')}
                      </span>
                    </div>
                    {records.map((record, idx) => (
                      <TimeRecordRow key={idx} record={record} nowTick={nowTick} />
                    ))}
                  </div>
                ))}
              </div>
            )
          )}
          {activeSection === 'workTime' && (
            sessionsLoading ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground border-t">{t('report.loading')}</div>
            ) : sessions.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground border-t">{t('report.noSessions')}</div>
            ) : (
              <div className="divide-y max-h-[300px] overflow-y-auto border-t">
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
                      <SessionRow key={session.id} session={session} task={sessionTasks[session.taskId]} dayEnd={
                        (() => { const d = getDaysInRange(getDayRange().start, getDayRange().end).find(dd => dd.daySessions.some(s => s.id === session.id)); return d?.dayEnd ?? Date.now() })()
                      } nowTick={nowTick} />
                    ))}
                  </div>
                ))}
              </div>
            )
          )}
          {activeSection === 'idleTime' && (
            dayTimelines.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground border-t">{t('report.noSessions')}</div>
            ) : (
              <div className="divide-y max-h-[300px] overflow-y-auto border-t">
                {dayTimelines.map(({ date, records }) => {
                  const idleRecords = records.filter(r => r.type === 'afk' || r.type === 'gap')
                  if (idleRecords.length === 0) return null
                  return (
                    <div key={format(date, 'yyyy-MM-dd')}>
                      <div className="px-4 py-2 bg-muted/30 text-sm">
                        <span className="font-medium">
                          {format(date, 'yyyy-MM-dd EEEE', { locale: dateLocale })}
                        </span>
                      </div>
                      {idleRecords.map((record, idx) => (
                        <TimeRecordRow key={idx} record={record} nowTick={nowTick} />
                      ))}
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>

        {/* Stat cards - clickable filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard icon={<ListTodo className="w-5 h-5" />} label="New" value={dateRangeStats.total} active={selectedStatFilter === 'NEW'} onClick={() => setSelectedStatFilter('NEW')} />
          <StatCard icon={<CheckCircle2 className="w-5 h-5" />} label={t('report.completed')} value={dateRangeStats.completed} active={selectedStatFilter === 'COMPLETED'} onClick={() => setSelectedStatFilter('COMPLETED')} />
          <StatCard icon={<Clock className="w-5 h-5" />} label={t('report.inProgress')} value={dateRangeStats.inProgress} active={selectedStatFilter === 'IN_PROGRESS'} onClick={() => setSelectedStatFilter('IN_PROGRESS')} />
          <StatCard icon={<BarChart3 className="w-5 h-5" />} label="All Tasks" value={summary?.totalTasks ?? 0} active={selectedStatFilter === 'ALL'} onClick={() => setSelectedStatFilter('ALL')} />
        </div>

        {/* Task list — fills remaining vertical space */}
        <div className="border rounded-lg flex flex-col min-h-0 flex-1">
          <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
            <span className="text-sm font-medium">
              {selectedStatFilter === 'ALL'
                ? `${filteredTasks.length} / ${allTasksTotal} tasks`
                : `${filteredTasks.length} task${filteredTasks.length !== 1 ? 's' : ''}`}
            </span>
            <span className="text-xs text-muted-foreground">
              {selectedStatFilter === 'NEW' ? 'New tasks' : selectedStatFilter === 'COMPLETED' ? 'Completed tasks' : selectedStatFilter === 'IN_PROGRESS' ? 'In progress tasks' : 'All tasks'}
            </span>
          </div>
          {allTasksLoading ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('report.loading')}</div>
          ) : filteredTasks.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('report.noTasks')}</div>
          ) : (
            <>
              <div className="divide-y flex-1 min-h-0 overflow-y-auto">
              {filteredTasks.map(task => (
                <div
                  key={task.id}
                  className="px-4 py-3 flex items-center gap-4 text-sm cursor-pointer hover:bg-muted/40 transition"
                  onClick={() => openTaskDetail(task)}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${priorityColors[task.priority as keyof typeof priorityColors]}`} />
                  <span className="flex-1 truncate">{task.title}</span>
                  <span className="text-xs text-muted-foreground w-24 text-right">{format(new Date(task.createdAt), 'MM-dd')}</span>
                  {task.completedAt && (
                    <span className="text-xs text-green-600 w-24 text-right">{format(new Date(task.completedAt), 'MM-dd')}</span>
                  )}
                  <span className="text-xs tabular-nums w-16 text-right">{formatDuration(task.workMs)}</span>
                </div>
              ))}
            </div>
              {selectedStatFilter === 'ALL' && allTasksHasMore && (
                <div className="px-4 py-3 border-t text-center">
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground transition"
                    onClick={loadMoreAllTasks}
                  >
                    Load more ({allTasksTotal - filteredTasks.length} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Side panel - task detail */}
      {selectedTask && (
        <div className="w-96 border-l bg-card flex flex-col flex-shrink-0 overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h2 className="text-sm font-semibold truncate flex-1">{selectedTask.title}</h2>
            <button className="p-1 rounded hover:bg-muted transition" onClick={() => setSelectedTask(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-4 py-3 space-y-4 text-sm">
            <div className="flex gap-4">
              <div>
                <span className="text-xs text-muted-foreground">Status</span>
                <div>{selectedTask.status}</div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Created</span>
                <div>{format(new Date(selectedTask.createdAt), 'MM-dd HH:mm', { locale: dateLocale })}</div>
              </div>
              {selectedTask.completedAt && (
                <div>
                  <span className="text-xs text-muted-foreground">Completed</span>
                  <div>{format(new Date(selectedTask.completedAt), 'MM-dd HH:mm', { locale: dateLocale })}</div>
                </div>
              )}
            </div>
            {selectedTask.body && (
              <div>
                <span className="text-xs text-muted-foreground">Body</span>
                <div className="mt-1 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: selectedTask.body }} />
              </div>
            )}
            {taskEntries.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground">Work Logs</span>
                <div className="mt-1 space-y-2">
                  {taskEntries.filter(e => e.type === 'log').map(entry => (
                    <div key={entry.id} className="border-l-2 border-muted pl-3 py-1">
                      <div className="text-xs text-muted-foreground">{format(new Date(entry.createdAt), 'MM-dd HH:mm')}</div>
                      <div className="text-sm" dangerouslySetInnerHTML={{ __html: entry.content }} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SessionRow({ session, task, dayEnd, nowTick }: { session: WorkSession; task?: Task; dayEnd?: number; nowTick: number }) {
  const { t, dateLocale } = useI18n()
  const startedAt = new Date(session.startedAt)
  const endedAt = session.endedAt ? new Date(session.endedAt) : null
  const now = Math.min(dayEnd ?? nowTick, nowTick)
  const duration = endedAt ? session.endedAt! - session.startedAt : now - session.startedAt

  return (
    <div className="px-4 py-3 flex items-center gap-6 text-sm">
      <div className="w-32 flex-shrink-0">
        <div className="font-medium">{format(startedAt, 'HH:mm', { locale: dateLocale })}</div>
        {endedAt ? (
          <div className="text-muted-foreground">{format(endedAt, 'HH:mm', { locale: dateLocale })}</div>
        ) : (
          <div className="text-blue-500 text-xs">{t('report.ongoing')}</div>
        )}
      </div>
      <div className="w-20 flex-shrink-0 font-medium">
        {formatDuration(duration)}
      </div>
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

function TimeRecordRow({ record, nowTick }: { record: TimeRecord; nowTick: number }) {
  const { t } = useI18n()
  const now = Math.min(record.endedAt, nowTick)
  const duration = Math.max(0, now - record.startedAt)

  return (
    <div className="px-4 py-3 flex items-center gap-6 text-sm">
      <div className="w-32 flex-shrink-0">
        <div className="font-medium">{format(new Date(record.startedAt), 'HH:mm')}</div>
        <div className="text-muted-foreground">{format(new Date(now), 'HH:mm')}</div>
      </div>
      <div className="w-20 flex-shrink-0 font-medium tabular-nums">
        {formatDuration(duration)}
      </div>
      <div className="flex-1 min-w-0">
        {record.type === 'work' && record.task && (
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${priorityColors[record.task.priority as keyof typeof priorityColors]}`} />
            <span className="truncate">{record.task.title}</span>
          </div>
        )}
        {record.type === 'work' && !record.task && (
          <span className="text-muted-foreground">{t('report.unknownTask')}</span>
        )}
        {record.type === 'afk' && (
          <div className="flex items-center gap-2">
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
              {t('report.afkLabel')}
            </span>
            <span className="truncate text-muted-foreground">
              {record.afkEvent?.reason}
              {record.afkEvent?.userNote && ` — ${record.afkEvent.userNote}`}
            </span>
          </div>
        )}
        {record.type === 'gap' && (
          <span className="text-muted-foreground italic">{t('report.notLabeled')}</span>
        )}
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, active, onClick }: { icon: React.ReactNode; label: string; value: number; active?: boolean; onClick?: () => void }) {
  return (
    <div
      className={`border rounded-lg p-4 flex items-center gap-3 cursor-pointer transition ${
        active ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <div className="p-2 bg-muted rounded-md">{icon}</div>
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
