export type Locale = 'zh-CN' | 'en'

export interface TranslationEntry {
  'zh-CN': string
  en: string
}

export const translations: Record<string, TranslationEntry> = {
  // Sidebar
  'sidebar.board': { 'zh-CN': '看板', en: 'Board' },
  'sidebar.report': { 'zh-CN': '报告', en: 'Report' },

  // Board page
  'board.loading': { 'zh-CN': '加载中...', en: 'Loading...' },
  'board.empty': { 'zh-CN': '暂无待办', en: 'No tasks' },
  'board.newTask': { 'zh-CN': '新建任务', en: 'New Task' },
  'board.deleteConfirm': { 'zh-CN': '确定删除 "{title}" 吗？', en: 'Delete "{title}"?' },
  'board.cancelWithContentConfirm': { 'zh-CN': '内容有未保存的修改，确认取消？', en: 'Unsaved content. Confirm cancel?' },
  'board.selectPrompt': { 'zh-CN': '选择一个待办任务开始工作', en: 'Select a task to start working' },
  'board.selectSubtitle': { 'zh-CN': '或点击 + 新建任务', en: 'Or click + to create a new task' },
  'board.expandFilters': { 'zh-CN': '展开更多筛选', en: 'Expand filters' },

  // Workspace
  'workspace.loading': { 'zh-CN': '加载中...', en: 'Loading...' },
  'workspace.submitLog': { 'zh-CN': '提交记录', en: 'Submit Log' },
  'workspace.logsLoading': { 'zh-CN': '加载记录中...', en: 'Loading logs...' },
  'workspace.workLogs': { 'zh-CN': '工作记录', en: 'Work Logs' },
  'workspace.start': { 'zh-CN': '开始', en: 'Start' },
  'workspace.complete': { 'zh-CN': '完成', en: 'Complete' },
  'workspace.continue': { 'zh-CN': '继续工作', en: 'Resume' },
  'workspace.leave': { 'zh-CN': '离开', en: 'Leave' },
  'workspace.leaveTitle': { 'zh-CN': '离开工作区', en: 'Leave workspace' },

  // Entry
  'entry.bodyLabel': { 'zh-CN': '任务正文', en: 'Task Conent' },
  'entry.logLabel': { 'zh-CN': '工作记录', en: 'Work Log' },
  'entry.save': { 'zh-CN': '保存', en: 'Save' },
  'entry.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'entry.editPlaceholder': { 'zh-CN': '编辑内容...', en: 'Edit...' },

  // Task
  'task.new': { 'zh-CN': '新建任务', en: 'New Task' },
  'task.edit': { 'zh-CN': '编辑任务', en: 'Edit Task' },
  'task.creating': { 'zh-CN': '创建中...', en: 'Creating...' },
  'task.title': { 'zh-CN': '标题', en: 'Title' },
  'task.titlePlaceholder': { 'zh-CN': '输入任务标题...', en: 'Enter task title...' },
  'task.type': { 'zh-CN': '类型', en: 'Type' },
  'task.priority': { 'zh-CN': '优先级', en: 'Priority' },
  'task.tags': { 'zh-CN': '标签', en: 'Tags' },
  'task.tagsPlaceholder': { 'zh-CN': '用逗号分隔，如: 研发, 重构', en: 'Comma separated, e.g. dev, backend' },
  'task.dueDate': { 'zh-CN': '截止日期', en: 'Due Date' },
  'task.today': { 'zh-CN': '今天', en: 'Today' },
  'task.newLabel': { 'zh-CN': '新建', en: 'New' },
  'task.bodyPlaceholder': { 'zh-CN': '输入任务正文...', en: 'Enter task body...' },
  'task.logPlaceholder': { 'zh-CN': '输入新记录...', en: 'Enter new log...' },
  'task.status': { 'zh-CN': '状态', en: 'Status' },
  'task.cancel': { 'zh-CN': '取消', en: 'Cancel' },
  'task.save': { 'zh-CN': '保存', en: 'Save' },

  // Rich editor
  'editor.placeholder': { 'zh-CN': '在这里记录你的工作进展... 支持粘贴图片', en: 'Record your progress here... Paste images supported' },
  'editor.bold': { 'zh-CN': '加粗', en: 'Bold' },
  'editor.italic': { 'zh-CN': '斜体', en: 'Italic' },
  'editor.strikethrough': { 'zh-CN': '删除线', en: 'Strikethrough' },
  'editor.heading1': { 'zh-CN': '标题 1', en: 'Heading 1' },
  'editor.heading2': { 'zh-CN': '标题 2', en: 'Heading 2' },
  'editor.bulletList': { 'zh-CN': '无序列表', en: 'Bullet List' },
  'editor.orderedList': { 'zh-CN': '有序列表', en: 'Ordered List' },
  'editor.blockquote': { 'zh-CN': '引用', en: 'Blockquote' },
  'editor.codeBlock': { 'zh-CN': '代码块', en: 'Code Block' },
  'editor.linkPrompt': { 'zh-CN': '输入链接地址:', en: 'Enter URL:' },
  'editor.link': { 'zh-CN': '插入链接', en: 'Insert Link' },
  'editor.image': { 'zh-CN': '插入图片', en: 'Insert Image' },

  // Report page
  'report.loading': { 'zh-CN': '加载中...', en: 'Loading...' },
  'report.title': { 'zh-CN': '工作报告', en: 'Work Report' },
  'report.todayTotal': { 'zh-CN': '今日总计', en: 'Today Total' },
  'report.completed': { 'zh-CN': '已完成', en: 'Completed' },
  'report.inProgress': { 'zh-CN': '进行中', en: 'In Progress' },
  'report.total': { 'zh-CN': '总任务', en: 'Total Tasks' },
  'report.byType': { 'zh-CN': '按类型统计', en: 'By Type' },
  'report.byPriority': { 'zh-CN': '按优先级统计', en: 'By Priority' },
  'report.taskList': { 'zh-CN': '今日任务列表', en: "Today's Tasks" },

  // Labels
  'type.todo': { 'zh-CN': '工作任务', en: 'Task' },
  'type.toread': { 'zh-CN': '待读', en: 'To Read' },
  'type.daily_improve': { 'zh-CN': '每日提升', en: 'Daily Improve' },
  'status.pending': { 'zh-CN': '待开始', en: 'Pending' },
  'status.doing': { 'zh-CN': '进行中', en: 'In Progress' },
  'status.done': { 'zh-CN': '已完成', en: 'Done' },
  'status.dropped': { 'zh-CN': '已废弃', en: 'Dropped' },
  'priority.high': { 'zh-CN': '高', en: 'High' },
  'priority.medium': { 'zh-CN': '中', en: 'Medium' },
  'priority.low': { 'zh-CN': '低', en: 'Low' },

  // Filter
  'filter.active': { 'zh-CN': '进行中', en: 'Active' },
  'filter.done': { 'zh-CN': '完成', en: 'Done' },
  'filter.dropped': { 'zh-CN': '废弃', en: 'Dropped' },

  // Workspace new
  'workspace.drop': { 'zh-CN': '废弃', en: 'Drop' },
  'workspace.redo': { 'zh-CN': '重做', en: 'Redo' },
  'workspace.takeOver': { 'zh-CN': 'Take', en: 'Take' },
  'workspace.afk': { 'zh-CN': 'AFK', en: 'AFK' },
  'workspace.tracking': { 'zh-CN': '正在工作', en: 'Working' },
  'workspace.notTracking': { 'zh-CN': '未追踪时间', en: 'Not tracking' },
  'workspace.dropReason': { 'zh-CN': '请输入废弃原因...', en: 'Enter drop reason...' },
  'workspace.dropConfirm': { 'zh-CN': '确认废弃', en: 'Confirm Drop' },

  // Report
  'report.day': { 'zh-CN': '天', en: 'Day' },
  'report.week': { 'zh-CN': '周', en: 'Week' },
  'report.month': { 'zh-CN': '月', en: 'Month' },
  'report.today': { 'zh-CN': '今天', en: 'Today' },
  'report.thisWeek': { 'zh-CN': '本周', en: 'This Week' },
  'report.thisMonth': { 'zh-CN': '本月', en: 'This Month' },
  'report.onDuty': { 'zh-CN': '在岗时长', en: 'On-duty' },
  'report.workTime': { 'zh-CN': '工作时长', en: 'Work Time' },
  'report.idleTime': { 'zh-CN': '摸鱼时长', en: 'Idle Time' },
  'report.hours': { 'zh-CN': '小时', en: 'hours' },
  'report.sessionTask': { 'zh-CN': '任务', en: 'Task' },
  'report.sessionStarted': { 'zh-CN': '开始', en: 'Started' },
  'report.sessionEnded': { 'zh-CN': '结束', en: 'Ended' },
  'report.sessionDuration': { 'zh-CN': '时长', en: 'Duration' },
  'report.ongoing': { 'zh-CN': '进行中', en: 'Ongoing' },
  'report.noSessions': { 'zh-CN': '暂无工作记录', en: 'No work sessions' },
  'report.workDayOffset': { 'zh-CN': '工作日偏移', en: 'Work Day Offset' },
  'report.workPeriod': { 'zh-CN': '工作时间', en: 'Work Period' },
  'report.trackedTask': { 'zh-CN': '追踪任务', en: 'Tracked Task' },

  // Settings
  'sidebar.settings': { 'zh-CN': '设置', en: 'Settings' },
  'settings.title': { 'zh-CN': '设置', en: 'Settings' },
  'settings.databaseInfo': { 'zh-CN': '数据库信息', en: 'Database Info' },
  'settings.dbPath': { 'zh-CN': '数据库路径', en: 'Database Path' },
  'settings.dbSize': { 'zh-CN': '数据库大小', en: 'Database Size' },
  'settings.lastBackup': { 'zh-CN': '上次备份', en: 'Last Backup' },
  'settings.never': { 'zh-CN': '从未', en: 'Never' },
  'settings.export': { 'zh-CN': '导出数据库', en: 'Export Database' },
  'settings.import': { 'zh-CN': '导入数据库', en: 'Import Database' },
  'settings.exporting': { 'zh-CN': '导出中...', en: 'Exporting...' },
  'settings.importing': { 'zh-CN': '导入中...', en: 'Importing...' },
  'settings.exportSuccess': { 'zh-CN': '导出成功', en: 'Export successful' },
  'settings.importSuccess': { 'zh-CN': '导入成功', en: 'Import successful' },
  'settings.exportError': { 'zh-CN': '导出失败', en: 'Export failed' },
  'settings.importError': { 'zh-CN': '导入失败', en: 'Import failed' },
  'settings.importWarning': { 'zh-CN': '确认导入数据库？', en: 'Confirm Database Import?' },
  'settings.importWarningDesc': { 'zh-CN': '当前所有数据将被替换，并自动创建备份。', en: 'All current data will be replaced. A backup will be created automatically.' },
  'settings.importConfirm': { 'zh-CN': '确认导入', en: 'Confirm Import' },
  'common.cancel': { 'zh-CN': '取消', en: 'Cancel' },

  // Search
  'search.placeholder': { 'zh-CN': '搜索任务标题、内容和标签...', en: 'Search task titles, content, and tags...' },
  'search.noResults': { 'zh-CN': '未找到匹配的任务', en: 'No matching tasks found' },
  'search.loading': { 'zh-CN': '搜索中...', en: 'Searching...' },
  'search.matchTitle': { 'zh-CN': '标题', en: 'Title' },
  'search.matchBody': { 'zh-CN': '正文', en: 'Body' },
  'search.matchLog': { 'zh-CN': '记录', en: 'Log' },
  'search.close': { 'zh-CN': '关闭', en: 'Close' },
}
