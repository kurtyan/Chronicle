# 工作任务管理系统 - 本地客户端实现规划

## 一、项目目标

构建一个**本地优先**的桌面任务管理应用：
- **平台**: Mac (Tauri 桌面应用)
- **存储**: 本地 SQLite，无需服务端
- **网络**: 完全离线可用，可选本地 LLM (Ollama)
- **范围**: 核心任务管理 + 计时 + 报告，**暂不做 IM Bot 集成**

---

## 二、MVP 功能范围

### Phase 1: 核心任务管理 (Week 1-2)
- [ ] 任务 CRUD
- [ ] 看板视图 (TODO → DOING → PENDING → DONE)
- [ ] 任务属性：标题、描述、类型、优先级、标签
- [ ] 任务筛选与搜索

### Phase 2: 时间管理 (Week 3)
- [ ] 当前激活任务概念（只能有一个进行中）
- [ ] 任务计时器（开始/暂停/停止）
- [ ] AFK 手动标记（带原因）
- [ ] 切换任务时自动暂停前一个
- [ ] 工时统计存储

### Phase 3: 进展留痕 (Week 4)
- [ ] 进展记录时间线
- [ ] 进展支持：文本、链接、附件路径
- [ ] 标记等待/阻塞状态
- [ ] 快速添加进展（快捷键唤起小窗）

### Phase 4: 视图与报告 (Week 5)
- [ ] 今日概览视图（晨会用）
- [ ] 日报生成（本地 LLM 或模板）
- [ ] 周报视图
- [ ] 工时统计图表

### Phase 5: 快捷交互 (Week 6)
- [ ] 全局快捷键唤起快速录入
- [ ] 菜单栏图标 + 当前任务显示
- [ ] 悬浮小窗添加进展
- [ ] 粘贴消息解析（本地 LLM）

---

## 三、技术方案

### 技术栈
| 层次 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust 后端) |
| 前端 | React 18 + TypeScript |
| 状态管理 | Zustand |
| UI 组件 | Tailwind CSS + Headless UI |
| 数据库 | SQLite (tauri-plugin-sql) |
| ORM | 手写 SQL + 类型封装 |
| 本地 LLM | Ollama (可选) |
| 快捷键 | Tauri Global Shortcut |
| 菜单栏 | Tauri System Tray |

### 项目结构
```
apps/desktop/
├── src/
│   ├── components/           # UI 组件
│   │   ├── TaskBoard/        # 看板视图
│   │   ├── TaskCard/         # 任务卡片
│   │   ├── ProgressTimeline/ # 进展时间线
│   │   └── QuickInput/       # 快速录入弹窗
│   │
│   ├── hooks/                # 自定义 hooks
│   │   ├── useTask.ts        # 任务操作
│   │   ├── useTimeTracking.ts # 计时
│   │   └── useQuickInput.ts  # 快速录入
│   │
│   ├── services/             # 业务服务
│   │   ├── taskService.ts    # 任务 CRUD
│   │   ├── timeService.ts    # 计时服务
│   │   ├── progressService.ts # 进展服务
│   │   ├── reportService.ts  # 报告生成
│   │   └── llmService.ts     # LLM 调用 (Ollama)
│   │
│   ├── db/                   # 数据库
│   │   ├── schema.ts         # 表结构定义
│   │   ├── migrations/       # 迁移脚本
│   │   └── client.ts         # 数据库连接
│   │
│   ├── stores/               # 状态管理
│   │   └── taskStore.ts      # Zustand store
│   │
│   ├── types/                # TypeScript 类型
│   │   └── index.ts
│   │
│   ├── utils/                # 工具函数
│   │   └── helpers.ts
│   │
│   ├── App.tsx               # 主应用
│   ├── main.tsx              # 入口
│   └── styles.css            # 全局样式
│
├── src-tauri/                # Rust 后端
│   └── src/
│       └── main.rs           # 主入口 + 快捷键/托盘
│
└── package.json
```

---

## 四、数据模型

### 核心表结构

```sql
-- 任务表
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                    -- UUID
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,                     -- TODO, DOING, PENDING, DONE, TOREAD, DAILY_IMPROVE
  priority TEXT NOT NULL,                 -- HIGH, MEDIUM, LOW
  tags TEXT,                              -- JSON 数组 ["标签1", "标签2"]
  status TEXT NOT NULL,                   -- 当前状态
  is_active BOOLEAN DEFAULT 0,            -- 是否是当前激活任务
  is_blocked BOOLEAN DEFAULT 0,           -- 是否被阻塞
  block_reason TEXT,
  created_at INTEGER NOT NULL,            -- Unix 时间戳
  started_at INTEGER,                     -- 开始时间
  completed_at INTEGER,                   -- 完成时间
  due_date INTEGER,                       -- 截止日期
  total_time_spent INTEGER DEFAULT 0,     -- 总耗时(秒)
  afk_time INTEGER DEFAULT 0              -- AFK时间(秒)
);

-- 进展记录表
CREATE TABLE progress (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  content TEXT NOT NULL,                  -- 进展内容
  type TEXT NOT NULL,                     -- WORK, WAITING, COMPLETE, NOTE
  created_at INTEGER NOT NULL,
  links TEXT,                             -- JSON 数组 ["url1", "url2"]
  attachments TEXT,                       -- JSON 数组 ["文件路径1", "文件路径2"]
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 时间记录表
CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration INTEGER,                       -- 持续时间(秒)
  is_afk BOOLEAN DEFAULT 0,
  afk_reason TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

---

## 五、核心交互设计

### 主界面布局
```
┌─────────────────────────────────────────────────────────────┐
│  任务管理                            [+新建] [当前任务] [⚙️]  │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│  📋 看板    │    ┌──────────┬──────────┬──────────┐         │
│  📅 今日    │    │   待办    │  进行中   │  已完成   │         │
│  📊 统计    │    │          │  ▶️ 激活  │          │         │
│            │    │  🔴 高优   │          │  ✅ 今天  │         │
│  ─────────  │    │  🟡 中优   │          │  ✅ 本周  │         │
│            │    │          │          │          │         │
│  类型筛选   │    └──────────┴──────────┴──────────┘         │
│  ○ 全部    │                                                │
│  ● 待办    │    [任务卡片] 可拖拽                           │
│  ○ 待读    │                                                │
│  ○ 每日提升 │                                                │
│            │                                                │
└────────────┴────────────────────────────────────────────────┘
```

### 全局快捷键
| 快捷键 | 功能 |
|--------|------|
| `Cmd+Shift+T` | 唤起快速录入窗口 |
| `Cmd+Shift+A` | 切换 AFK 状态 |
| `Cmd+Shift+.` | 跳转到当前激活任务 |

### 菜单栏图标
```
点击菜单栏图标 → 显示当前任务悬浮窗

┌─────────────────────────────┐
│ ▶️ 重构订单模块              │
│ ⏱️ 今日: 2h 15m             │
│ 🕐 本次: 45m                │
│ ─────────────────────────  │
│ [添加进展] [AFK] [完成]     │
│ ─────────────────────────  │
│ 打开主窗口                 │
│ 今日概览                   │
│ 生成日报                   │
│ ─────────────────────────  │
│ 退出                       │
└─────────────────────────────┘
```

### 快速录入窗口
```
┌─────────────────────────────────────────┐
│ 新建任务                      [_] [X]   │
├─────────────────────────────────────────┤
│ 标题: [________________________]        │
│                                         │
│ 类型: ○ 待办 ● 进行中 ○ 待读 ○ 每日提升  │
│                                         │
│ 优先级: 🔴 高  🟡 中  🟢 低             │
│                                         │
│ 描述:                                   │
│ [粘贴消息自动解析...                    │
│  ___________________________________]   │
│                                         │
│ [ 直接开始 (Cmd+Enter) ]  [ 仅保存 ]    │
└─────────────────────────────────────────┘
```

---

## 六、关键实现逻辑

### 计时服务
```typescript
class TimeTrackingService {
  private activeTaskId: string | null = null;
  private currentEntry: TimeEntry | null = null;

  // 开始任务（同时只能有一个）
  async startTask(taskId: string) {
    // 1. 停止当前任务
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      await this.pauseTask(this.activeTaskId);
    }
    
    // 2. 创建新的时间记录
    this.currentEntry = await db.createTimeEntry({
      taskId,
      startTime: Date.now(),
      isAfk: false
    });
    
    // 3. 更新任务为激活状态
    await db.updateTask(taskId, { 
      isActive: true,
      status: 'DOING',
      startedAt: Date.now()
    });
    
    this.activeTaskId = taskId;
  }

  // 暂停任务
  async pauseTask(taskId: string) {
    if (this.currentEntry) {
      const endTime = Date.now();
      const duration = Math.floor((endTime - this.currentEntry.startTime) / 1000);
      
      await db.updateTimeEntry(this.currentEntry.id, {
        endTime,
        duration
      });
      
      // 累加到任务总耗时
      await db.incrementTaskTime(taskId, duration);
    }
    
    await db.updateTask(taskId, { isActive: false });
  }

  // AFK 开始
  async startAfk(reason: string) {
    if (this.activeTaskId && this.currentEntry) {
      // 结束当前工作时段
      await this.pauseTask(this.activeTaskId);
      
      // 创建 AFK 记录
      this.currentEntry = await db.createTimeEntry({
        taskId: this.activeTaskId,
        startTime: Date.now(),
        isAfk: true,
        afkReason: reason
      });
    }
  }

  // AFK 结束
  async stopAfk() {
    if (this.activeTaskId && this.currentEntry?.isAfk) {
      await this.pauseTask(this.activeTaskId);
      // 自动恢复任务计时
      await this.startTask(this.activeTaskId);
    }
  }
}
```

### 快速录入流程
```typescript
// 快捷键唤起
const showQuickInput = async () => {
  const window = WebviewWindow.getByLabel('quick-input');
  await window?.show();
  await window?.setFocus();
};

// 粘贴解析
const handlePaste = async (text: string) => {
  // 尝试调用本地 Ollama 解析
  const parsed = await llmService.parseMessage(text);
  if (parsed) {
    setFormData({
      title: parsed.title,
      description: parsed.description,
      priority: parsed.priority,
      type: parsed.suggestedType
    });
  }
};

// 创建任务
const createTask = async (data: TaskFormData, startNow: boolean) => {
  const task = await taskService.create(data);
  
  if (startNow) {
    await timeService.startTask(task.id);
  }
  
  // 关闭窗口
  const window = WebviewWindow.getByLabel('quick-input');
  await window?.hide();
};
```

---

## 七、实现里程碑

| 周次 | 目标 | 交付物 |
|------|------|--------|
| Week 1 | 基础框架 + 任务 CRUD | 可运行的 Tauri 应用，基础看板视图 |
| Week 2 | 看板完善 + 筛选搜索 | 完整的看板交互，任务卡片详情 |
| Week 3 | 时间管理 + AFK | 计时功能，菜单栏当前任务显示 |
| Week 4 | 进展留痕 | 进展时间线，快速添加进展 |
| Week 5 | 报告视图 | 今日概览，日报生成 |
| Week 6 | 快捷交互 | 全局快捷键，快速录入窗口 |
| Week 7 | 优化打磨 | 性能优化，边界处理 |

---

## 八、后续可扩展（不做进 MVP）

- [ ] Slack Bot 集成（Webhook 接收消息自动创建任务）
- [ ] 文件/截图附件存储优化
- [ ] 系统空闲自动检测（AFK）
- [ ] 数据导出/备份功能
- [ ] 周/月报 LLM 生成
- [ ] 任务标签智能推荐

---

## 九、技术风险与应对

| 风险 | 应对 |
|------|------|
| Tauri SQLite 插件限制 | 使用 `tauri-plugin-sql` 或直接用 Rust 调用 SQLite |
| 多窗口状态同步 | 使用 Zustand + Tauri 事件广播 |
| 计时精度 | 使用系统时间，定期持久化到数据库 |
| Ollama 未安装 | 功能降级，提供纯文本录入 |

---

## 十、下一步

进入详细设计阶段，确认以下事项：
1. 是否使用 Monorepo 结构？
2. UI 组件库选择（shadcn/ui vs 自建）？
3. 数据库 ORM 方式（手写 vs 轻量 ORM）？
4. 是否需要本地 LLM 作为 MVP 功能？
