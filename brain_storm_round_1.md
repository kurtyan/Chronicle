# 工作任务管理系统 - 产品与技术设计方案

## 一、需求核心提炼

### 1.1 用户痛点
- 当前使用 Mac Notes 管理，标签繁琐（#TODO/#DOING/#DONE + 日期标签）
- 无法按时间维度（天/周/月）管理任务
- Notes 无法被第三方访问，无法使用 LLM 总结
- 多任务并行时切换成本高，缺乏"当前激活任务"概念
- 无法自动统计工时和"摸鱼"时间

### 1.2 核心需求
- **任务生命周期管理**：创建 → 进行中 → 等待中 → 完成
- **快速录入**：文本、粘贴消息（LLM自动提取）、截图、链接
- **进展留痕**：时间线形式的进展记录，支持链接、截图、附件
- **时间管理**：激活任务计时、AFK 自动暂停、多任务切换
- **智能总结**：日报、周报、月报通过 LLM 自动生成
- **跨环境使用**：工作环境（Mac，内网隔离）+ 生活环境（iPhone/Mac）

---

## 二、问题分析

### 2.1 合理的交互方式

#### 分析维度

| 维度 | 选项 | 评估 |
|------|------|------|
| **部署形态** | Native App vs PWA vs Electron | 推荐 **Tauri + Web 技术** 打包桌面端，同时支持 Web 访问 |
| **主界面形态** | 看板 vs 列表 vs 日历 | 推荐 **看板为主 + 日历/时间线为辅** |
| **快捷录入** | 全局快捷键 vs 悬浮窗 vs 侧边栏 | 推荐 **全局快捷键唤起悬浮输入框** |
| **当前任务** | 悬浮窗 vs 菜单栏 vs Dock 栏 | 推荐 **菜单栏图标 + 悬浮小窗** |

#### 推荐的交互设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        主界面布局                                │
├─────────────────────────────────────────────────────────────────┤
│  [Logo] 任务管理    [搜索框]              [新建任务] [当前任务] [设置] │
├────────────┬────────────────────────────────────────────────────┤
│            │                                                    │
│  📋 看板    │    ┌──────────┬──────────┬──────────┬──────────┐  │
│  📅 日历    │    │  待办     │  进行中   │  等待中   │  已完成   │  │
│  🔥 今日    │    │  🔴高优   │  ▶️ 激活  │  ⏸️ 阻塞  │  ✅ 今日  │  │
│  📊 统计    │    │  🟡中优   │          │          │  ✅ 本周  │  │
│  📈 报告    │    │  🟢低优   │          │          │          │  │
│            │    └──────────┴──────────┴──────────┴──────────┘  │
│  ─────────  │                                                    │
│  标签筛选   │    [任务卡片] 可拖拽变更状态                          │
│  类型筛选   │                                                    │
│            │                                                    │
└────────────┴────────────────────────────────────────────────────┘

快捷键: Cmd+Shift+T → 唤起快速录入框
        Cmd+Shift+A → 切换 AFK 状态
        Cmd+Shift+C → 跳转到当前激活任务
```

**快速录入框设计：**
```
┌─────────────────────────────────────────┐
│  新建任务                    [×]        │
├─────────────────────────────────────────┤
│  标题: [________________________]       │
│  类型: ○ 待办 ● 进行中 ○ 待读 ○ 每日提升  │
│  优先级: 🔴 高  🟡 中  🟢 低            │
│  ─────────────────────────────────────  │
│  描述/进展:                             │
│  [粘贴内容自动解析...                   │  ← 支持粘贴飞书/钉钉/Slack消息
│   ____________________________]         │     自动提取标题和链接
│  ─────────────────────────────────────  │
│  附件: [截图1] [链接1] [+添加]          │
│  ─────────────────────────────────────  │
│  [ 直接开始 (Cmd+Enter) ]  [ 仅保存 ]    │
└─────────────────────────────────────────┘
```

**当前任务悬浮窗（菜单栏点击后显示）：**
```
┌─────────────────────────────────────────┐
│  ▶️ 当前任务: 重构订单模块                 │
│  ⏱️ 今日已工作: 2小时 15分钟              │
│  🕐 本次开始: 14:32                     │
│  ─────────────────────────────────────  │
│  [ 添加进展 ]  [ AFK - 去开会 ]  [ 完成 ] │
│  ─────────────────────────────────────  │
│  最近进展:                              │
│  • 14:30 - 提交了 PR #234              │
│  • 11:20 - 等待后端接口确认               │
│  • 09:15 - 开始编写重构方案               │
└─────────────────────────────────────────┘
```

---

### 2.2 技术架构分析

#### 核心约束：工作环境完全与外网隔离

```
                    互联网
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │  LLM API │   │ 云同步服务 │   │ Slack API│
    │ (Claude) │   │ (可选)   │   │         │
    └────┬────┘   └────┬────┘   └────┬────┘
         │             │             │
         │         ┌───┴───┐         │
         │         │       │         │
    ┌────┴────────┐│  ┌────┴────────┐│
    │  生活环境    ││  │  工作环境    ││  ← 物理隔离！
    │  (外网可访问)││  │  (仅内网)    ││
    │             ││  │             ││
    │ ┌─────────┐ ││  │ ┌─────────┐ ││
    │ │ iPhone  │ ││  │ │ Mac     │ ││
    │ │ (PWA)   │ ││  │ │ (桌面端) │ ││
    │ └────┬────┘ ││  │ └────┬────┘ ││
    │      │      ││  │      │      ││
    │ ┌────▼────┐ ││  │ ┌────▼────┐ ││
    │ │ Mac     │ ││  │ │ SQLite  │ ││
    │ │ (备用)  │ ││  │ │ (本地)  │ ││
    │ └─────────┘ ││  │ └─────────┘ ││
    └─────────────┘│  └─────────────┘│
                   │                 │
              同步通道（物理中转）      │
              iCloud/文件共享/手机中转   │
```

#### 架构方案对比

| 方案 | 描述 | 优点 | 缺点 | 推荐度 |
|------|------|------|------|--------|
| **A. 纯本地 + 文件同步** | SQLite 存储，通过 iCloud/WebDAV 同步 | 简单、离线可用、成本低 | 同步依赖外部工具、冲突处理复杂 | ⭐⭐⭐⭐⭐ |
| **B. C/S 架构 + 自建服务端** | 内网部署服务器，手机通过 VPN 或中转访问 | 实时同步、功能强大 | 需要维护服务器、工作环境无法部署服务端 | ⭐⭐⭐ |
| **C. 纯云架构** | 数据全在云端 | 实时同步、跨设备体验好 | 工作环境无法访问外网，完全不可用 | ⭐ |

**推荐方案：方案 A 的增强版 - 分层同步架构**

```
┌─────────────────────────────────────────────────────────────────────┐
│                         数据层设计                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────┐          ┌──────────────────────┐        │
│  │     工作环境 (Mac)    │          │    生活环境 (多端)    │        │
│  │                      │          │                      │        │
│  │  ┌────────────────┐  │          │  ┌────────────────┐  │        │
│  │  │   Tauri App    │  │          │  │   Web App      │  │        │
│  │  │   (桌面端)      │  │          │  │   (PWA)        │  │        │
│  │  └────────┬───────┘  │          │  └────────┬───────┘  │        │
│  │           │          │          │           │          │        │
│  │  ┌────────▼───────┐  │          │  ┌────────▼───────┐  │        │
│  │  │   SQLite       │  │          │  │   SQLite       │  │        │
│  │  │   (主存储)      │  │          │  │   (主存储)      │  │        │
│  │  └────────┬───────┘  │          │  └────────┬───────┘  │        │
│  │           │          │          │           │          │        │
│  │  ┌────────▼───────┐  │          │  ┌────────▼───────┐  │        │
│  │  │   同步文件      │◄─┼───文件───┼─►│   同步文件      │  │        │
│  │  │  (增量日志)     │  │   中转   │  │  (增量日志)     │  │        │
│  │  └────────────────┘  │          │  └────────────────┘  │        │
│  │                      │          │                      │        │
│  │  完全离线工作，       │          │  可访问互联网，       │        │
│  │  定时导出增量日志     │          │  LLM 总结，同步中转   │        │
│  └──────────────────────┘          └──────────────────────┘        │
│                                                                     │
│  同步机制：                                                          │
│  1. 工作环境 Mac → 导出增量操作日志 → iCloud/手机文件共享 → 生活环境   │
│  2. 生活环境有 LLM 能力，可生成总结报告                               │
│  3. 双向同步通过"操作日志回放"实现，避免冲突                          │
│  4. 定时全量备份（压缩后）通过物理方式中转                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、产品功能设计

### 3.1 功能模块划分

```
task-manager/
├── 📱 核心任务模块
│   ├── 任务 CRUD
│   ├── 任务状态机 (TODO → DOING → PENDING → DONE)
│   ├── 任务属性 (类型、优先级、标签、起止时间)
│   └── 任务搜索与筛选
│
├── ⏱️ 时间管理模块
│   ├── 任务计时器 (开始/暂停/停止)
│   ├── AFK 自动检测与手动标记
│   ├── 多任务切换自动暂停
│   ├── 工时统计 (日/周/月视图)
│   └── 摸鱼分析 (AFK 时间段分析)
│
├── 📝 进展留痕模块
│   ├── 进展时间线 (文本 + 时间戳)
│   ├── 富媒体附件 (截图、文件、链接)
│   ├── URL 自动识别与预览
│   ├── 等待状态标记 (阻塞原因)
│   └── 消息引用模板 (飞书/钉钉/Slack)
│
├── 🤖 LLM 集成模块 (仅生活环境可用)
│   ├── 粘贴消息自动提取任务信息
│   ├── 日报生成 (今日完成、工时、摸鱼)
│   ├── 周报生成 (本周主要项目进展)
│   ├── 月报/季度总结
│   └── 任务内容智能标签建议
│
├── 📊 视图与报告模块
│   ├── 看板视图 (Kanban)
│   ├── 日历视图
│   ├── 今日概览 (晨会用)
│   ├── 时间线视图 (进展历史)
│   └── 统计报表 (项目维度、时间维度)
│
└── 🔄 同步模块
    ├── 操作日志记录 (所有 CRUD 操作)
    ├── 增量导出 (JSON Lines 格式)
    ├── 全量备份 (SQLite 压缩)
    └── 日志回放与冲突解决
```

### 3.2 任务数据模型

```typescript
// 任务实体
interface Task {
  id: string;                    // UUID
  title: string;                 // 任务标题
  description?: string;          // 任务描述
  
  // 分类属性
  type: TaskType;                // 类型: TODO / DOING / PENDING / DONE / TOREAD / DAILY
  priority: Priority;            // 优先级: HIGH / MEDIUM / LOW
  tags: string[];                // 标签
  
  // 时间属性
  createdAt: DateTime;           // 创建时间
  startedAt?: DateTime;          // 开始时间
  completedAt?: DateTime;        // 完成时间
  dueDate?: Date;                // 截止日期
  
  // 状态
  status: Status;                // 当前状态
  isActive: boolean;             // 是否是当前激活任务
  isBlocked: boolean;            // 是否被阻塞
  blockReason?: string;          // 阻塞原因
  
  // 统计
  totalTimeSpent: number;        // 总耗时(秒)
  afkTime: number;               // AFK时间(秒)
  
  // 关联
  progressList: Progress[];      // 进展列表
  attachments: Attachment[];     // 附件列表
}

// 进展实体
interface Progress {
  id: string;
  taskId: string;
  content: string;               // 进展内容
  timestamp: DateTime;           // 记录时间
  type: ProgressType;            // 类型: WORK / WAITING / COMPLETE / NOTE
  attachments: Attachment[];     // 附件
  links: Link[];                 // 相关链接
  metadata?: Record<string, any>; // 额外元数据
}

// 时间记录实体 (用于工时统计)
interface TimeEntry {
  id: string;
  taskId: string;
  startTime: DateTime;
  endTime?: DateTime;
  duration: number;              // 持续时间(秒)
  isAfk: boolean;                // 是否是 AFK 时段
  afkReason?: string;            // AFK 原因
}
```

---

## 四、技术栈选型

### 4.1 前端技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| **框架** | React 18 + TypeScript | 类型安全，生态丰富 |
| **状态管理** | Zustand | 轻量，适合本地优先应用 |
| **路由** | React Router | 标准路由方案 |
| **UI 组件** | Headless UI + Tailwind CSS | 可定制，轻量 |
| **桌面端** | Tauri v2 | Rust 后端，比 Electron 更轻量 |
| **移动端** | PWA (Web) | 一套代码多端运行 |
| **数据可视化** | Recharts / D3 | 统计图表 |
| **日期处理** | date-fns | 轻量日期库 |

### 4.2 存储与同步技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| **本地存储** | SQLite (via sql.js 或 Tauri SQL) | 结构化数据存储 |
| **文件存储** | IndexedDB / 本地文件系统 | 大文件存储 |
| **同步格式** | JSON Lines | 增量日志格式 |
| **压缩** | pako (zlib) | 全量备份压缩 |
| **冲突解决** | Operational Transform | 操作日志回放 |

### 4.3 LLM 集成 (生活环境端)

| 功能 | 实现方式 |
|------|----------|
| **消息解析** | Claude API / OpenAI API 调用 |
| **报告生成** | 结构化 Prompt + JSON Schema 输出 |
| **缓存** | 本地 IndexedDB 缓存 LLM 结果 |

---

## 五、项目结构规划

```
task-manager/
├── apps/
│   ├── desktop/                    # Tauri 桌面端
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── main.tsx
│   │   │   └── styles/
│   │   ├── src-tauri/              # Rust 后端
│   │   │   ├── Cargo.toml
│   │   │   └── src/
│   │   │       └── main.rs
│   │   └── package.json
│   │
│   └── web/                        # Web/PWA 端 (生活环境)
│       ├── src/
│       ├── public/
│       └── package.json
│
├── packages/
│   ├── ui/                         # 共享 UI 组件
│   │   ├── src/components/
│   │   └── package.json
│   │
│   ├── core/                       # 核心业务逻辑
│   │   ├── src/
│   │   │   ├── models/             # 数据模型
│   │   │   ├── services/           # 业务服务
│   │   │   │   ├── taskService.ts
│   │   │   │   ├── timeService.ts
│   │   │   │   ├── progressService.ts
│   │   │   │   └── syncService.ts
│   │   │   ├── stores/             # 状态管理
│   │   │   └── utils/              # 工具函数
│   │   └── package.json
│   │
│   ├── database/                   # 数据库层
│   │   ├── src/
│   │   │   ├── schema.sql          # SQLite  schema
│   │   │   ├── migrations/         # 迁移脚本
│   │   │   ├── client.ts           # 数据库客户端
│   │   │   └── sync.ts             # 同步逻辑
│   │   └── package.json
│   │
│   └── llm/                        # LLM 集成 (生活环境专用)
│       ├── src/
│       │   ├── prompts/            # Prompt 模板
│       │   ├── parsers/            # 消息解析器
│       │   └── client.ts
│       └── package.json
│
├── docs/                           # 文档
│   ├── requirements.md
│   └── api/
│
└── turbo.json                      # Monorepo 配置
```

---

## 六、关键技术实现

### 6.1 自动计时与 AFK 检测

```typescript
// 核心逻辑：激活任务自动计时
class TimeTrackingService {
  private activeTaskId: string | null = null;
  private currentEntry: TimeEntry | null = null;
  private afkTimer: NodeJS.Timeout | null = null;

  // 切换任务时自动处理
  switchTask(newTaskId: string) {
    if (this.activeTaskId) {
      this.pauseCurrentTask(); // 旧任务自动暂停
    }
    this.startTask(newTaskId); // 新任务开始计时
  }

  // AFK 检测
  startAfk(reason: string) {
    if (this.currentEntry) {
      this.currentEntry.endTime = now();
      this.saveEntry(this.currentEntry);
    }
    // 开始 AFK 计时
    this.afkTimer = setInterval(() => {
      this.recordAfkTime();
    }, 60000); // 每分钟记录
  }

  // 用户返回
  stopAfk() {
    if (this.afkTimer) {
      clearInterval(this.afkTimer);
      this.afkTimer = null;
    }
    // 恢复当前任务计时
    if (this.activeTaskId) {
      this.startTask(this.activeTaskId);
    }
  }
}
```

### 6.2 消息解析 (LLM)

```typescript
// 粘贴消息自动提取任务信息
interface MessageParser {
  parse(rawText: string): Promise<ParsedTask>;
}

// Prompt 设计
const PARSE_MESSAGE_PROMPT = `
你是一个任务信息提取助手。请从用户粘贴的消息中提取以下信息：

输入消息：
{rawMessage}

请提取并返回 JSON 格式：
{
  "title": "任务标题（一句话总结）",
  "description": "详细描述",
  "source": "消息来源（飞书/钉钉/Slack/邮件等）",
  "links": ["消息链接"],
  "priority": "HIGH/MEDIUM/LOW",
  "dueDate": "截止日期（ISO格式，可选）",
  "mentionedBy": "提及人",
  "context": "相关背景信息"
}
`;
```

### 6.3 同步机制

```typescript
// 操作日志 - 用于同步
interface OperationLog {
  id: string;
  timestamp: DateTime;
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  entity: 'TASK' | 'PROGRESS' | 'TIME_ENTRY';
  entityId: string;
  payload: Record<string, any>;
  checksum: string;  // 用于验证完整性
}

// 同步流程
class SyncService {
  // 导出增量日志
  async exportDelta(since: DateTime): Promise<string> {
    const logs = await db.operationLogs
      .where('timestamp')
      .above(since)
      .toArray();
    return JSONLines.stringify(logs);
  }

  // 导入并回放操作
  async importDelta(deltaContent: string) {
    const logs = JSONLines.parse(deltaContent);
    for (const log of logs) {
      await this.replayOperation(log);
    }
  }

  // 冲突解决策略：时间戳优先
  private resolveConflict(local: any, remote: any) {
    return local.updatedAt > remote.updatedAt ? local : remote;
  }
}
```

---

## 七、实现路线图

### Phase 1: MVP (核心功能)
- [ ] 任务 CRUD 与看板视图
- [ ] 任务计时器与 AFK 功能
- [ ] 进展记录与附件
- [ ] 本地 SQLite 存储
- [ ] Tauri 桌面端打包

### Phase 2: 增强体验
- [ ] 快速录入框 + 全局快捷键
- [ ] 消息解析 (LLM 集成)
- [ ] 日历视图与统计报表
- [ ] PWA Web 端
- [ ] 基础同步功能 (文件导出/导入)

### Phase 3: 智能化
- [ ] 自动消息解析与任务生成
- [ ] 日报/周报/月报自动生成
- [ ] 智能标签推荐
- [ ] 双向自动同步

### Phase 4: 生态集成
- [ ] Slack Bot (通过手机中转)
- [ ] 飞书/钉钉消息导入
- [ ] API 开放

---

## 八、总结

### 架构决策

1. **交互方式**: Tauri 桌面端 + PWA Web 端，一套代码多端运行
2. **数据存储**: SQLite 本地存储，操作日志同步机制
3. **跨环境方案**: 物理文件同步 (iCloud/手机中转) + 操作日志回放
4. **LLM 能力**: 仅在生活环境端启用，通过同步机制将结果带回工作环境

### 关键技术点

1. **本地优先**: 所有功能可在离线环境运行，数据永不丢失
2. **自动计时**: 激活任务自动跟踪，AFK 自动暂停
3. **智能解析**: LLM 自动提取消息中的任务信息
4. **冲突解决**: 基于时间戳的操作日志回放策略

### 下一步行动

1. 确定技术选型后，搭建项目基础架构
2. 实现核心任务管理功能
3. 集成计时与 AFK 功能
4. 开发消息解析 LLM 能力
5. 设计并测试同步机制
