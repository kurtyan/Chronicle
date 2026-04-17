# 工作任务管理系统 - 产品与技术设计方案 V2

## 一、关键修正总结

### 1.1 环境重新定义

| 原称呼 | 新称呼 | 网络环境 | LLM 来源 | 使用设备 |
|--------|--------|----------|----------|----------|
| 工作环境 | **电脑+IM模式** | 内网隔离 | 内部 LLM (Ollama/公司Claude) | Mac |
| 生活环境 | **多端模式** | 外网可访问 | 云端 LLM (Kimi/OpenAI/Claude) | Mac + iPhone |

**关键变化**：两个环境是 **parity（对等独立）** 的，不需要跨环境同步数据。各自独立运行，独立存储。

### 1.2 技术约束确认

1. **iOS 端**：无苹果开发者账号 → 只能使用 **Web/PWA**，无法构建 Native App
2. **消息推送**：iOS Web 端推送受限（Safari 16.4+ 支持 Web Push，但体验不如原生）
3. **架构选择**：需要在「端侧app+文件同步」vs「http server+网页端」之间做决策

---

## 二、架构方案对比与选择

### 2.1 方案对比

| 维度 | 方案 A: 端侧 App + 文件同步 | 方案 B: HTTP Server + 网页端 |
|------|---------------------------|-----------------------------|
| **核心架构** | Tauri 桌面端 + SQLite 本地存储<br>通过 iCloud/WebDAV 同步数据库文件 | 自建服务端 (轻量)<br>Web 页面作为客户端 |
| **iOS 支持** | ❌ 困难（无法直接访问本地 SQLite 文件） | ✅ 容易（纯 Web 访问） |
| **离线能力** | ✅ 强（完全本地运行） | ⚠️ 中等（PWA 可缓存，但需服务端） |
| **部署复杂度** | 低（无服务端） | 中（需要部署服务） |
| **数据同步** | 文件级同步（iCloud/WebDAV） | 实时 API 同步 |
| **消息推送** | ❌ 困难 | ✅ 可实现（服务端推送） |
| **多端一致性** | ⚠️ 冲突风险（文件锁问题） | ✅ 服务端仲裁，一致性高 |
| **LLM 集成** | 需本地或配置代理 | 服务端统一代理，客户端无感知 |

### 2.2 推荐方案

**多端模式（生活环境）→ 方案 B: HTTP Server + 网页端**

理由：
- iOS 端只能走 Web，需要有服务端支持
- 消息推送、实时同步更容易实现
- LLM 可以在服务端统一代理，安全可控
- 可以部署在家庭 NAS 或云服务器上

**电脑+IM模式（工作环境）→ 方案 A: 端侧 App + 可选文件备份**

理由：
- 完全离线可用，符合内网隔离要求
- 无需维护服务端
- 可选本地文件备份，定期导出到外部存储

### 2.3 最终架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           多端模式（生活环境）                                │
│                         外网可访问，云端 LLM                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐            │
│   │   Mac 电脑    │      │   iPhone     │      │  其他设备     │            │
│   │              │      │              │      │              │            │
│   │ ┌──────────┐ │      │ ┌──────────┐ │      │ ┌──────────┐ │            │
│   │ │ Web App  │ │      │ │ Safari   │ │      │ │ Web App  │ │            │
│   │ │ (PWA)    │ │      │ │ PWA      │ │      │ │ (PWA)    │ │            │
│   │ └────┬─────┘ │      │ └────┬─────┘ │      │ └────┬─────┘ │            │
│   │      │      │      │      │      │      │      │      │            │
│   │      ▼      │      │      ▼      │      │      ▼      │            │
│   │  HTTP/API   │◄────►│  HTTP/API   │◄────►│  HTTP/API   │            │
│   │      │      │      │      │      │      │      │      │            │
│   └──────┼──────┘      └──────┼──────┘      └──────┼──────┘            │
│          │                    │                    │                      │
│          └────────────────────┼────────────────────┘                      │
│                               ▼                                            │
│   ┌──────────────────────────────────────────────────────────────┐        │
│   │                     服务端 (轻量)                             │        │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐         │        │
│   │  │  API    │  │ SQLite  │  │  LLM    │  │ WebPush │         │        │
│   │  │ Server  │──│  DB     │  │ Proxy   │  │ Service │         │        │
│   │  │(Node.js)│  │         │  │         │  │         │         │        │
│   │  └─────────┘  └─────────┘  └─────────┘  └─────────┘         │        │
│   │                                                             │        │
│   │  部署选项：家庭 NAS / 云服务器 (VPS) / 本地电脑暴露公网         │        │
│   │  对外暴露：443 端口 (HTTPS)                                  │        │
│   └──────────────────────────────────────────────────────────────┘        │
│                               │                                            │
│                               ▼                                            │
│   ┌──────────────────────────────────────────────────────────────┐        │
│   │                      外部服务                                 │        │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────┐                      │        │
│   │  │  Kimi   │  │ OpenAI  │  │ Claude  │                      │        │
│   │  │  API    │  │  API    │  │  API    │                      │        │
│   │  └─────────┘  └─────────┘  └─────────┘                      │        │
│   └──────────────────────────────────────────────────────────────┘        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          电脑+IM模式（工作环境）                              │
│                         内网隔离，内部 LLM                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────┐        │
│   │                    Mac 电脑（单机版）                         │        │
│   │                                                              │        │
│   │   ┌──────────────┐        ┌──────────────┐                  │        │
│   │   │  Tauri App   │◄──────►│   SQLite     │                  │        │
│   │   │  (桌面端)     │        │   (本地)     │                  │        │
│   │   └──────┬───────┘        └──────────────┘                  │        │
│   │          │                                                  │        │
│   │          ▼                                                  │        │
│   │   ┌──────────────┐                                          │        │
│   │   │  内部 LLM    │  配置：                                   │        │
│   │   │  - Ollama    │  - 本地部署的 Ollama                      │        │
│   │   │  - 公司 Claude│  - 或内网可访问的公司采购 Claude           │        │
│   │   └──────────────┘                                          │        │
│   │                                                              │        │
│   │   ┌──────────────┐        ┌──────────────┐                  │        │
│   │   │  可选：导出   │───────►│  USB/硬盘    │  定期备份        │        │
│   │   │  SQLite 文件  │        │  物理带出     │                  │        │
│   │   └──────────────┘        └──────────────┘                  │        │
│   │                                                              │        │
│   └──────────────────────────────────────────────────────────────┘        │
│                                                                             │
│   特点：完全离线运行，无需服务端，数据完全本地存储                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、多端模式详细设计

### 3.1 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| **服务端** | Node.js + Fastify/Express | 轻量 API 服务 |
| **数据库** | SQLite (服务端) | 单文件，易备份 |
| **ORM** | Drizzle ORM / Prisma | 类型安全 |
| **认证** | JWT + 简单密码 | 家庭使用，无需复杂 auth |
| **前端** | React + Vite + PWA | 一套代码多端 |
| **推送** | Web Push API + service-worker | iOS 16.4+ 支持 |
| **部署** | Docker / PM2 | 可选家庭 NAS |

### 3.2 部署方案建议

**推荐：家庭 NAS 部署**

```yaml
# docker-compose.yml
version: '3'
services:
  task-manager:
    image: task-manager:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data  # SQLite 数据持久化
      - ./config:/app/config
    environment:
      - LLM_PROVIDER=kimi  # 或 openai/claude
      - LLM_API_KEY=${LLM_API_KEY}
      - JWT_SECRET=${JWT_SECRET}
    restart: unless-stopped
```

**公网访问方案**（选一）：
1. **内网穿透**：frp / ngrok / Cloudflare Tunnel（推荐）
2. **公网 IP**：家庭宽带申请公网 IP + DDNS
3. **云服务器**：轻量 VPS（腾讯云/阿里云轻量应用服务器，约 50-100元/年）

### 3.3 数据同步机制

```typescript
// 服务端 API 设计
interface APISchema {
  // 认证
  'POST /auth/login': { password: string } => { token: string }
  
  // 任务 CRUD
  'GET    /tasks': () => Task[]
  'POST   /tasks': (task: CreateTaskDTO) => Task
  'PUT    /tasks/:id': (task: UpdateTaskDTO) => Task
  'DELETE /tasks/:id': () => void
  
  // 实时同步（可选 WebSocket）
  'WS /sync': WebSocket  // 实时推送变更
  
  // 进展记录
  'POST /tasks/:id/progress': (progress: CreateProgressDTO) => Progress
  
  // LLM 功能
  'POST /ai/parse-message': (message: string) => ParsedTask
  'POST /ai/daily-report': (date: string) => DailyReport
  'POST /ai/weekly-report': (week: string) => WeeklyReport
  
  // 时间追踪
  'POST /time/start': (taskId: string) => TimeEntry
  'POST /time/stop': (taskId: string) => TimeEntry
  'POST /time/afk': (reason: string) => void
}
```

### 3.4 PWA 配置

```javascript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '任务管理',
        short_name: 'TaskMgr',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#000000',
        icons: [
          { src: '/icon-192.png', sizes: '192x192' },
          { src: '/icon-512.png', sizes: '512x512' }
        ]
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/your-api\.com\/api\//,
            handler: 'NetworkFirst', // API 请求优先网络，离线时用缓存
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 86400 }
            }
          }
        ]
      }
    })
  ]
})
```

### 3.5 iOS Web Push 说明

```javascript
// service-worker.js
// iOS 16.4+ 支持 Web Push
self.addEventListener('push', event => {
  const data = event.data.json()
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      data: { url: data.url }
    })
  )
})

// 用户点击通知
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  )
})
```

**注意**：iOS Web Push 需要：
1. 用户将 PWA 添加到主屏幕
2. 用户在 PWA 内明确订阅推送
3. 服务端使用 VAPID 密钥

---

## 四、电脑+IM模式详细设计

### 4.1 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| **桌面端** | Tauri v2 | 比 Electron 更轻量 |
| **前端** | React + TypeScript | 与多端模式共享组件 |
| **本地存储** | SQLite (via tauri-plugin-sql) | 本地数据库 |
| **LLM** | Ollama 本地 / 内网 API | 完全离线可用 |
| **快捷键** | Tauri Global Shortcut | 全局快捷键唤起 |
| **菜单栏** | Tauri System Tray | 菜单栏图标 |

### 4.2 代码复用策略

两个模式共享大部分代码，通过条件编译/环境变量区分：

```
packages/
├── ui/                    # 共享 UI 组件
├── core/                  # 共享业务逻辑
├── database/
│   ├── src/
│   │   ├── index.ts       # 通用接口
│   │   ├── sqlite-local.ts # 电脑+IM模式：本地 SQLite
│   │   └── sqlite-http.ts  # 多端模式：HTTP API 封装
│   └── package.json
└── llm/
    ├── src/
    │   ├── index.ts
    │   ├── ollama.ts      # 电脑+IM模式：Ollama/内部 API
    │   └── openai.ts      # 多端模式：云端 API
    └── package.json
```

### 4.3 Tauri 配置

```rust
// src-tauri/src/main.rs
use tauri::{CustomMenuItem, SystemTray, SystemTrayEvent, SystemTrayMenu};

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("new_task", "新建任务").accelerator("Cmd+Shift+T"))
        .add_item(CustomMenuItem::new("toggle_afk", "切换 AFK").accelerator("Cmd+Shift+A"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit", "退出"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                // 显示主窗口
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "new_task" => {
                    // 唤起快速录入窗口
                }
                "toggle_afk" => {
                    // 切换 AFK 状态
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 4.4 数据导出/备份

```typescript
// 定期备份功能
class BackupService {
  async exportToFile() {
    const dbPath = await this.getDbPath();
    const backupPath = `/Volumes/USB/task_backup_${formatDate(new Date())}.db`;
    await fs.copyFile(dbPath, backupPath);
    
    // 同时导出可读格式
    const data = await this.exportAllData();
    await fs.writeFile(
      `/Volumes/USB/task_backup_${formatDate(new Date())}.json`,
      JSON.stringify(data, null, 2)
    );
  }
}
```

---

## 五、功能模块详细设计

### 5.1 统一功能清单

两个模式功能对等，但实现方式不同：

| 功能模块 | 多端模式 (HTTP+Web) | 电脑+IM模式 (Tauri本地) |
|---------|-------------------|----------------------|
| **任务管理** | HTTP API | SQLite 本地 |
| **看板视图** | React 组件 | React 组件 (共享) |
| **快速录入** | 页面内快捷键 | 全局快捷键 + 悬浮窗 |
| **当前任务** | 页面标题闪烁 | 菜单栏实时显示 |
| **计时/AFK** | 服务端计时 + 心跳 | 本地计时，更精准 |
| **消息解析** | 服务端 LLM 代理 | 本地 Ollama 调用 |
| **日报/周报** | 服务端生成 | 本地生成 |
| **推送通知** | Web Push | 系统通知 |
| **离线使用** | PWA 缓存有限功能 | 完全离线可用 |

### 5.2 消息解析 LLM 设计

**多端模式 Prompt**（云端 LLM）：
```typescript
const PARSE_MESSAGE_PROMPT = `
你是一个任务信息提取助手。请从用户粘贴的消息中提取任务信息。

输入消息：
{rawMessage}

请提取并返回 JSON：
{
  "title": "任务标题（一句话）",
  "description": "详细描述",
  "source": "消息来源",
  "links": ["相关链接"],
  "priority": "HIGH/MEDIUM/LOW",
  "suggestedType": "TODO/DOING/DAILY/TOREAD"
}
`;
```

**电脑+IM模式 Prompt**（Ollama/内部 LLM）：
- 使用本地部署的 LLM（如 Llama 3 / Qwen 2.5）
- Prompt 相同，但模型能力可能较弱，需要更多示例
- 可配置使用公司内网采购的 Claude API

### 5.3 计时与 AFK 设计

**多端模式**：
```typescript
// 服务端计时（基于心跳）
class ServerTimeTracking {
  private activeSessions: Map<string, Session> = new Map();
  
  startTask(userId: string, taskId: string) {
    // 停止其他任务
    this.stopAllUserTasks(userId);
    // 开始新任务
    this.activeSessions.set(userId, {
      taskId,
      startTime: Date.now(),
      lastHeartbeat: Date.now()
    });
  }
  
  // 客户端每 30 秒发送心跳
  heartbeat(userId: string) {
    const session = this.activeSessions.get(userId);
    if (session) {
      session.lastHeartbeat = Date.now();
    }
  }
  
  // 服务端定时检查（心跳超时 2 分钟判定为 AFK）
  checkAfk() {
    const now = Date.now();
    for (const [userId, session] of this.activeSessions) {
      if (now - session.lastHeartbeat > 2 * 60 * 1000) {
        this.markAfk(userId, "心跳超时");
      }
    }
  }
}
```

**电脑+IM模式**：
```typescript
// 本地计时（更精准）
class LocalTimeTracking {
  private activeTaskId: string | null = null;
  private startTime: number = 0;
  private afkTimer: NodeJS.Timeout | null = null;
  
  startTask(taskId: string) {
    if (this.activeTaskId) {
      this.stopTask(this.activeTaskId);
    }
    this.activeTaskId = taskId;
    this.startTime = Date.now();
    
    // 监听系统空闲
    this.setupIdleDetection();
  }
  
  setupIdleDetection() {
    // Tauri 可以监听系统空闲事件
    // 或定期检测鼠标/键盘活动
    setInterval(() => {
      const idleTime = getSystemIdleTime(); // Tauri API
      if (idleTime > 5 * 60 * 1000) { // 5 分钟无操作
        this.startAfk("系统空闲");
      }
    }, 10000);
  }
}
```

---

## 六、项目结构

```
task-manager/
├── apps/
│   ├── web/                      # 多端模式：Web 前端
│   │   ├── src/
│   │   ├── public/
│   │   └── package.json
│   │
│   ├── server/                   # 多端模式：服务端
│   │   ├── src/
│   │   │   ├── routes/           # API 路由
│   │   │   ├── services/         # 业务服务
│   │   │   ├── models/           # 数据模型
│   │   │   ├── llm/              # LLM 代理
│   │   │   └── db/               # 数据库
│   │   ├── docker-compose.yml
│   │   └── package.json
│   │
│   └── desktop/                  # 电脑+IM模式：Tauri 桌面端
│       ├── src/                  # 前端代码 (与 web 共享)
│       ├── src-tauri/            # Rust 后端
│       │   └── src/
│       └── package.json
│
├── packages/
│   ├── ui/                       # 共享 UI 组件
│   │   └── src/
│   │       ├── components/       # React 组件
│   │       ├── hooks/            # 共享 hooks
│   │       └── styles/           # 共享样式
│   │
│   ├── core/                     # 共享业务逻辑
│   │   └── src/
│   │       ├── types/            # TypeScript 类型
│   │       ├── utils/            # 工具函数
│   │       └── constants/        # 常量
│   │
│   └── config/                   # 共享配置
│       ├── eslint-config/
│       └── ts-config/
│
├── docs/
│   ├── requirements.md
│   ├── architecture-v1.md
│   └── architecture-v2.md        # 本文档
│
└── package.json                  # Monorepo 根配置
```

---

## 七、实现路线图

### Phase 1: 基础框架 (Week 1-2)
- [ ] 搭建 Monorepo 结构
- [ ] 配置共享 UI 组件库
- [ ] 定义共享数据模型和类型

### Phase 2: 多端模式 MVP (Week 3-4)
- [ ] 实现服务端 API (Node.js + SQLite)
- [ ] 实现 Web 前端基础功能
- [ ] 部署到云服务器/家庭 NAS
- [ ] iPhone PWA 测试

### Phase 3: 电脑+IM模式 MVP (Week 5-6)
- [ ] 搭建 Tauri 项目
- [ ] 复用 Web 前端代码
- [ ] 实现本地 SQLite 存储
- [ ] 全局快捷键 + 菜单栏

### Phase 4: 计时与 AFK (Week 7)
- [ ] 多端模式：服务端计时 + 心跳
- [ ] 电脑+IM模式：本地计时 + 空闲检测
- [ ] AFK 自动/手动切换

### Phase 5: LLM 集成 (Week 8)
- [ ] 多端模式：云端 LLM 代理
- [ ] 电脑+IM模式：Ollama 本地集成
- [ ] 消息解析功能

### Phase 6: 报告生成 (Week 9)
- [ ] 日报/周报生成功能
- [ ] 统计报表
- [ ] 数据导出

### Phase 7: 优化与同步 (Week 10)
- [ ] PWA 离线体验优化
- [ ] 消息推送 (iOS Web Push)
- [ ] 电脑+IM模式数据备份功能

---

## 八、关键决策总结

| 决策点 | 选择 | 理由 |
|--------|------|------|
| **多端模式架构** | HTTP Server + Web/PWA | iOS 只能用 Web；需要消息推送；服务端可统一代理 LLM |
| **电脑+IM模式架构** | Tauri 桌面端 + 本地 SQLite | 完全离线可用；内网隔离；无需维护服务端 |
| **服务端技术** | Node.js + SQLite | 轻量；单文件数据库易备份；团队熟悉 |
| **iOS 方案** | PWA (Safari Add to Home Screen) | 无苹果开发者账号；Web Push iOS 16.4+ 已支持 |
| **数据同步** | 实时 API (多端) / 物理备份 (电脑+IM) | 两个环境独立，无需跨环境同步 |
| **LLM 方案** | 云端代理 (多端) / 本地 Ollama (电脑+IM) | 各环境使用最适合的 LLM 来源 |
| **代码复用** | Monorepo 共享 UI 和 Core | 两个模式界面一致，降低维护成本 |

---

## 九、下一步行动

1. **确认服务端部署方式**：家庭 NAS / 云服务器 / 内网穿透？
2. **确认 LLM 供应商**：
   - 多端模式：Kimi / OpenAI / Claude？
   - 电脑+IM模式：Ollama 本地模型 / 公司内网 API？
3. **开始 Phase 1**：搭建基础 Monorepo 结构
