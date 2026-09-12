# 项目制功能 rollout 风险评估（修复前记录）

**2026-09-12 修复更新：本文保留发现问题时的证据和当时判断。以下已复现的六类问题已修复，并转换为正式故障隔离验收。当前结果见 [隔离修复与回归记录](project-management-rollout-isolation-fixes.md)。原诊断的 opt-in 开关已移除，当前测试通过代表故障下旧功能仍然可用。**

评估日期：2026-09-12。基线：`f46b797`，对照当前工作树中全部待发布改动。用户的上线底线：新功能可以不完善或有 bug，但不能影响既有 Task、Work Session 和 Focus 功能。

**结论：最近的甘特概览布局改版影响低；整套项目制改动暂不满足这条上线底线，不建议覆盖当前日常使用版本。** 正常路径回归通过，但已复现项目模块错误传播到旧功能，以及无关项目更新打断旧日志编辑。以下不是生产故障记录，均为源码审计和隔离环境验证。

## 影响范围

| 既有功能 | 保持的核心行为 | 新增影响及判断 |
| --- | --- | --- |
| Task 管理 | 普通旧字段更新、完成/恢复/废弃及排序逻辑基本保留；正常状态流转回归通过 | 创建草稿、创建请求、详情组件和 SSE 刷新均已接入项目制。存在实际旧功能受阻，整体中等风险，错误传播最严重可导致工作区白屏 |
| Work Session 管理 | 起停、切换、AFK、恢复核心实现未改；未发现项目归属操作重写历史 session | 原始记录和计时链路风险低；旧 Report 工时和任务列表依赖新统计服务，故障隔离风险中等 |
| Focus（今日工作区） | TodayPage、DayScriptEditor、TaskEntryBlock、富文本核心无累计改动；保存、提交、冲突保护和自动接管流程保留 | 与 Board 共用 TaskDetailWorkspace 和项目 store，因此存在编辑器重建和渲染失败的间接影响；核心算法风险低，共享工作区风险中等 |

“低风险”不是零风险保证。最近的概览预览、紧凑泳道和详情侧栏没有直接修改这些核心状态机，但它们所属的累计待发布功能已经跨越原有模块边界。

## 已复现的上线阻断项

### 1. 无关项目更新会重建旧日志编辑器

在一个普通 Task 中编辑既有日志，由另一客户端更新一个无关联 Area 的最新进展。原编辑器 DOM 被移除后重新创建；未保存的 HTML 能从草稿恢复，但原编辑器实例及其选择/撤销上下文不能因此认为得到保留。这属于正常项目操作引发的旧功能干扰，不需要项目服务故障。

- 路径：`useSSE.ts:175` 对任何 `projects_changed` 重新 `setActiveTask`；`taskStore.ts:243` 进入 loading；`TaskDetailWorkspace/index.tsx:697` 的 loading 分支卸载已有日志编辑器。
- 浏览器探针验证了编辑器实例被重建和 HTML 草稿恢复；没有断言已保存日志丢失。
- 相同 TaskDetailWorkspace 用于 Focus 右侧。浏览器复现在 Board，Focus 的传播范围由共享代码审计确认。
- 上线要求：按受影响对象更新项目元数据；无关项目事件不重载旧 Task 正文和日志。编辑期间保留文本、光标、选择、撤销历史及阅读位置。

### 2. 项目目录格式错误会让原有看板白屏

已经打开普通 Task 后，将项目目录响应替换为 HTTP 200、`{ areas: null, milestones: null }`。React 报错，整个 `#root` 变空，普通 Task 界面随之消失。

- 路径：`projectStore.ts:14` 直接接受响应；Board、TodoItem、EntityReferencePicker 等直接迭代这些字段。当前没有局部 React 错误边界，项目 UI 与旧工作区处于同一错误域。
- 这是畸形响应故障注入，不代表真实服务器正常情况下就会返回此数据。
- 对照：仅让项目 HTTP 接口返回 500，普通 Task 创建、开始计时、工作草稿保存仍成功。不能将普通 HTTP 500 说成必然白屏。
- 上线要求：校验项目响应结构，提供安全空值和局部错误状态；新模块渲染错误只能影响该模块。Board、Focus 与核心导航保持可用。

### 3. 新增草稿缓存失败阻断普通 Task 创建

只对新键 `chronicle:task_draft` 注入 `QuotaExceededError`，其余 localStorage 正常。按 Cmd+N 后普通 Task 草稿界面无法打开。

- 路径：`taskStore.ts:543` 先同步写缓存，失败后不再更新内存草稿。HEAD 的对应方法是纯内存更新，没有这项依赖。
- `taskStore.ts:716` 还新增了全 store 订阅，每次状态更新都操作草稿 ID 缓存，未捕获异常；这是需要一起收窄的传播面。
- 基线已有个别 AFK 缓存访问未捕获异常，不能用全面禁用 localStorage 证明此次回归。容量满也不意味着 `removeItem` 一定失败。本次只确认新草稿键导致普通创建失败。
- 上线要求：缓存持久化作为可降级能力；只在草稿实际变化时写入，失败不阻断创建、取消及核心状态更新。

### 4. 项目统计失败会冻结旧 Report 的工作时长

启动一个运行中的 session，打开 Report 并成功获取项目投入快照，再令后续定时统计请求返回 500。原有“工作时长”停留在旧值，“在岗时长”继续增长，空闲时间被连带高估。

- 路径：`ReportPage.tsx:202-219` 保留失败前快照；`:412` 优先用其 `totalMs` 替代原 session 实时计算结果。
- 实测示例：在岗由 `0h 00m 12s` 增至 `0h 00m 14s`，工作时长仍为 `0h 00m 01s`。
- 触发需要“先成功，再在定时刷新中失败”。项目变更事件会额外重拉 sessions 并清空快照，不能用该事件代替这个故障序列。首次探针走了事件刷新，观察到旧计算回退正常；改为真实定时刷新后复现冻结。
- 上线要求：旧统计继续从权威 session 计算；项目分组统计失败只影响新增分布。若共用统计内核，应把 session 求和与项目分组读取分开，保留实时性和明确回退。

### 5. 无项目归属的普通 UI 创建仍依赖项目引用存储

在临时库中模拟项目引用表不可用：省略 `references` 的旧创建请求成功；普通 UI 发出的 `primaryMilestoneId: null, references: []` 创建失败，并被事务整体回滚。

- 路径：`taskStore.ts:540-560` 默认空引用数组并始终发送；`taskService.ts:314` 对空数组仍调用 `setReferences`。
- 人为移除临时项目表是用来模拟模块内部异常，不能解释为正常运行会主动删表，也不等同于 HTTP 层断网。
- 上线要求：不使用项目功能的 Task 请求不依赖项目引用处理。显式使用项目归属/引用的请求仍需原子性；不能静默忽略关联失败造成半成功。

### 6. 项目统计存储错误会使原 Report 任务列表服务失败

临时库中模拟项目统计字段不可读后，既有 `fetchReportTasks` 抛出错误。同一故障状态下，开始计时 → 切换 Task → AFK → 恢复 → 再次 AFK 仍然成功，且最多一个运行中的 session。

- 路径：`AppService.enrichTasks:366-369` 无条件调用 `getWorkStatistics`；`workStatisticsService.ts:16-17` 读取项目表。
- 上线要求：旧 Report 的任务列表和基础工时不因项目分组数据不可读而失败。

## 其他已审计边界

- `taskService.ts:636-743` 的 session 起停、切换、AFK 截断和恢复相对 HEAD 未修改；Tauri 原生实现无 diff。项目归属和撤销修改归属字段，读取 session 用于预览，没有写入历史 session 的新路径。
- 首次迁移采用增量 schema、迁移前 SQLite 备份及事务。探针验证旧 Task 全部原始列、运行中 session 在迁移前后及备份中一致，重启不重复备份。
- 迁移错误仍会在 HTTP 服务启动前阻断初始化；本次未模拟磁盘满、备份失败或迁移中断。尚未执行旧版程序读取新库的完整回退演练，不能将有备份等同于回退已验证。
- 未发现有效的项目功能关闭开关。仅隐藏侧栏入口不足以隔离已挂载的组件、后台订阅、共享创建链路与服务端依赖。
- 源码另发现 Mac 草稿正文的 Control+Enter 入口改为平台 mod+Enter。这里仅旧正文直接判断 `ctrlKey` 的入口改变；板级快捷键注册字符串变化本身等价。该项尚未单独实跑，不能列为已复现故障。
- 新项目 catalog 会随多类旧 Task、Note、session 事件刷新；未做大规模数据及高频多客户端负载测量。

## 本次验证记录

所有服务使用自动分配端口和临时数据库，未连接生产库。没有修改产品源码、发布、重启日常服务或提交代码。本次新增评估文档和诊断探针。

1. 重建 web/server 后，**138 项既有功能回归通过**（1.7 分钟），覆盖数据完整性、接管与 AFK、Day Script、Focus 富文本及提交、快捷键、Task 状态流转、日志草稿、Pinned、Plan Today 和 Work Overview。
2. **30 项相关服务回归通过**（1.6 秒），覆盖项目 core、备份及报表期间边界。
3. 8 项隔离/迁移诊断中，6 项成功复现上述缺口，另有 HTTP 500 局部降级和迁移保护对照。**诊断输出中的绿色只表示观察符合预期，不能计入“旧功能安全”通过数。** 默认跳过，须显式设置 `CHRONICLE_RUN_ROLLOUT_PROBES=1`。
4. `git diff --check` 通过。

主要命令：

```sh
./scripts/with-node.sh node scripts/test-project-management.mjs tests/data-integrity.test.ts tests/auto-takeover.test.ts tests/day-script.test.ts tests/focus-rich-meeting.test.ts tests/focus-code-block-scroll.test.ts tests/work-overview-keyboard.test.ts tests/cmd-s-draft-entry.test.ts tests/phase4-ui.test.ts tests/pinned-content.test.ts tests/plan-today-draft.test.ts

./scripts/with-node.sh npm exec -- playwright test tests/project-backup-service.test.ts tests/project-core-service.test.ts tests/project-work-period-service.test.ts --config=playwright.project-services.config.ts --reporter=line --output=test-results/rollout-core

CHRONICLE_RUN_ROLLOUT_PROBES=1 ./scripts/with-node.sh node scripts/test-legacy-regression.mjs tests/project-rollout-browser-probes.test.ts

CHRONICLE_RUN_ROLLOUT_PROBES=1 ./scripts/with-node.sh npm exec -- playwright test tests/project-rollout-probes-service.test.ts --config=playwright.project-services.config.ts --reporter=line --output=test-results/project-rollout-probes
```

本地验证日志保存在 `artifacts/rollout-audit-2026-09-12/`，由仓库现有 `*.log` 规则忽略，不随代码提交；仓库保留评估结果及可复验测试。浏览器为 WebKit；本次没有重跑 macOS 原生锁屏、睡眠唤醒、真实多设备 AFK 或生产规模压力测试。

## 建议的 rollout 门槛

1. 先修复以上共享路径干扰与故障传播，将诊断用例转换为“发生故障时旧功能仍成功”的验收断言。
2. 增加可关闭项目功能的完整开关。关闭后普通 Task、Focus、session 和原 Report 不执行项目专属 UI、订阅及查询；开关开启时也必须保留局部错误隔离。
3. 验证项目 HTTP 500、超时、畸形响应、局部组件异常、缓存失败及项目内部服务错误下，旧 Task 创建/编辑/完成/恢复、计时切换/AFK、Focus 保存/提交与 Report 都可继续。
4. 加入后台项目更新期间持续编辑的验收，检查光标、撤销历史、草稿、阅读位置和当前 session，不只检查最终保存的文字。
5. 发布前完成实际版本回退演练，并补做原生计时生命周期检查；迁移时保留可恢复备份。

完成这些门槛后再评估 rollout。当前“正常路径全绿”不足以满足本次要求。
