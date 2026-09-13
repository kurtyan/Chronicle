# 项目制实现状态

日期：2026-09-13。

整体工作区重设计已完成：甘特与投入列表统一常驻检查面板，期间与返回上下文连续；进展、排期、完成分为明确动作；可展开投入来源、阅读本期记录、从下一步生成 Task 草稿，并在 Notes 内保存和确认回顾。设计见 [整体体验复核](project-workspace-product-review.md)，本次验收见 [连续工作流程验收](project-workspace-continuity-verification.md)。

本次项目页面与集成 93 项、服务 81 项、既有功能 181 项通过；独立浏览器 Computer Use 与截图已完成，未发布到日常环境。

以下为上一阶段（国际化与风格修复）的记录，计数不与本次累计。

最新状态：项目工作区已按 Chronicle 既有风格完成国际化、可搜索选择器与 Task 批量归属、Cmd/Ctrl+5 导航及大屏布局调整；补充了侧栏和数字快捷键离开 Focus 前的草稿保存保护。新 Review/AI 生成内容跟随请求语言，旧文本保留；无新增数据库迁移。

本轮项目接口与页面 **62 项**、服务 **68 项**通过；**181 项既有功能用例均已完成本轮验证**。完整运行先为 180/181，Work Overview 隐藏信号用例校准了独立异步来源的初始加载顺序假设后，正式用例、两种受控加载顺序及所属 Plan Today 16 项整组均通过；产品排序代码未改变。复跑不重复计数，不表述为一次完整 181 项全绿。

已在独立预览浏览器完成 Computer Use，并在两种 Mac 逻辑分辨率下验证布局。预览服务和标签页已关闭，合成数据与截图保留；没有生产发布、提交或推送。设计见 [项目工作区设计](project-workspace-design.md)，范围、证据和限制见 [本轮验收记录](project-workspace-verification.md)。

## 此前阶段记录（2026-09-12）

此前已完成 Task / Work Session / Focus 故障隔离加固，当轮 181 项既有功能、32 项项目集成、12 项浏览器故障验收、61 项服务测试通过，共 286 项不同用例。详见 [隔离修复与回归记录](project-management-rollout-isolation-fixes.md)。下文的 131 / 138 项计数为更早实施阶段记录，不与本轮复验累加。

首版六个实施阶段及后续路线图体验调整已完成。本轮 44 项项目服务测试、87 项接口与页面测试通过，共 131 项；加前轮 Rust 7 项，累计 138 项不同自动测试通过，重复复验不另计。本轮 87 项包含新增后的项目集成 26 项与既有 WebKit 回归 61 项。真实 LLM 小样本与 Rust 结果沿用前轮，本轮没有再次调用真实模型。使用隔离测试数据，没有修改或迁移用户生产数据，没有发布或建立真实工作安排。

## 已实现

| 范围 | 实际入口与行为 |
| --- | --- |
| 两层管理 | Area → Milestone；阶段/持续类型、增改查、进展/下一步/阻碍、状态、归档恢复；Project 仅为模块名称 |
| 任务归属 | Task 单主里程碑；新建时原子保存归属和引用；已有 Task 单个/批量调整须预览，可从原/新里程碑的持久历史撤销整次调整，保留后续冲突保护；里程碑换方向同理 |
| 对象标签 | Task/Note 多目标引用及用途，稳定 ID，独立关系版本，双向查询和去重；沿已有 Task–Note 链接展示派生来源 |
| 页面接入 | 项目总览默认共享时间轴的方向泳道甘特图，重叠里程碑自动分轨，支持周/月、计划日期及开放/未排期状态；点击方向或里程碑打开关联 Notes；原 Board、Today、详情、全局搜索继续可用 |
| 方向摘要 | 每个方向独立显示最新进展、下一步、更新时间和来源；手工编辑或审阅 LLM 草稿后显式采用，保留摘要历史与来源 Note 版本 |
| Notes 筛选 | 输入 # 查找方向/里程碑，选为可删除 token；多对象 AND 与全文共同过滤；服务端 LIMIT 前筛选，保留 URL、中文输入及编辑草稿 |
| 投入 | Session 共享聚合；期间/累计、方向/里程碑/未归属、异常说明；Report 同口径；相关引用不分摊工时 |
| 生命周期 | 手动核对阶段成果，持续型不计算总体完成率；完成/取消/重开事件与复盘分别管理 |
| 人工沉淀 | 新建或关联已有 Note，多次阶段回顾；确认保存不可变内容版本和取证包；原文后改或删除仍保留确认历史 |
| AI 草稿 | 使用现有 LLM 配置；全范围原始取证、分块预算、覆盖缺口、引用校验、后台运行、取消/重试、过期判断；版本保护采纳和手动确认 |
| 接口与刷新 | HTTP/MCP 共用服务；对象/引用/复盘/SSE 失效通知；正文和关系并发校验独立 |
| 恢复 | 增量迁移、首次旧库 DB 快照、完整 ZIP 恢复、跨目录附件/JSON 映射、证据指纹维护、畸形快照拒绝 |

使用方法见 [项目制使用说明](project-management-guide.md)。需求与验收基线见 [实现计划](project-management-implementation-plan.md)，上一轮客户端逐项操作记录见 [Computer Use 验收](project-management-computer-use-acceptance.md)，本轮需求、验收与截图见 [路线图体验调整](project-management-roadmap-update.md)。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 核心数据与统计服务 | 24 项通过：旧库/重复初始化、单主归属、时间裁切与守恒、预览/应用/撤销、生命周期、引用和删除边界；新增持久历史精确追溯、解除归属、整批撤销及后续关系冲突保护回归 |
| 复盘与 AI 服务 | 14 项通过：确定性模型替身、原始证据覆盖、精确引用及数字校验、预算缺口与提高输出预算重试、事件 JSON 和真实实体 ID 回归、陈旧和重复确认、取消/重试/重启、HTTP 采纳到复盘流程 |
| 跨目录完整备份 | 3 项通过：普通及含引号/反斜杠路径、实际附件字节、内容/指纹一致性、畸形快照在替换现有数据前拒绝 |
| 日期边界 | 3 项通过：周日周范围、闰月/跨年、连续工作日半开边界 |
| 项目服务整套复验 | 本轮上述 44 项全部通过（2.6 秒）；与各分项是同一组测试，不重复累计 |
| HTTP/MCP/SSE 集成 | 8 项真实 HTTP/MCP/SSE 用例通过，MCP 使用 `StreamableHTTPClientTransport` 连接独立测试端口；覆盖实际路由、SSE 第二客户端通知、Note 正文/关系冲突、完整备份导入等。此前进程内执行为同一组用例，不重复计数 |
| 既有 WebKit 回归 | 本轮 61 项既有 WebKit 回归全部再次通过；不代表已运行整个仓库的所有测试 |
| SSE 修复后的相关回归 | Notes 24 项与已完成任务搜索 3 项再次全部通过；这 27 项为相关用例复验，不与既有回归重复累计 |
| 真实 SSE 跨窗口 | 三窗口刷新场景连续 3 次通过 |
| 原生桌面 Computer Use | 上一轮 12 个预设场景及 Task 保存专项通过：方向/里程碑管理、Task 规划、真实计时和投入核对、Notes 引用与草稿、改归属、人工完成/回顾及确认快照、持续回顾、归档恢复；见逐项验收记录 |
| 真实 LLM 全链路 | 沿用前轮验证：`deepseek-v4-flash`、提示 v2、输出上限 8000 tokens；1 次调用、11,492 ms、8 个来源且覆盖完整；6 条观察、3 条解释、17 条引用；系统统计为 30 分钟；采纳 Note、人工编辑后确认、不可变版本和无假过期均通过 |
| 最终项目管理与页面整套 | 本轮真实 HTTP/MCP/SSE 8 项与 WebKit UI 18 项，共 26 项通过；同次运行既有 61 项，合计 87 项、55.6 秒、0 失败、0 跳过。新增甘特日期和跳转、方向摘要历史及冲突、LLM 模拟草稿采用、Notes 标签与延迟列表焦点测试 |
| Server TypeScript | `tsc --noEmit -p server/tsconfig.json` 通过 |
| Web 构建 | `tsc && vite build` 通过，资源已更新到 `server/public`；仍有混合动态导入和大 chunk 提示 |
| Server 构建 | `tsup` 通过，产物在 `server/dist` |
| Tauri 前端与原生构建 | Tauri 前端及 Tauri debug app 构建通过；未运行 release pipeline 或发布 |
| Rust | 前轮 7 项测试通过，本次未重跑 |
| 差异格式检查 | `git diff --check` 通过 |

本轮以甘特图、方向摘要、直接笔记入口和输入标签筛选重构主线。独立检查修复了远期目标点被夹到当前时间轴、月底移动到短月份溢出，以及 Notes 列表延迟加载导致 Escape 焦点无法返回的问题。最终 87 项已包含这些变更后的复验。另通过 Computer Use 在重新构建的原生客户端查看甘特、点击方向打开笔记、输入 `#职业` 选择标签并验证两标签交集。截图位于 `artifacts/project-roadmap-update/`；展示数据来自独立 `.dev-data/project-manual-ZGKikS` 的 HTTP 合成记录和已结束计时 fixture，不是用户实际工作计划或投入，也不冒充全部从 UI 创建的验收库。测试进程已退出，演示库保留。

此前监听和 WebKit 启动的环境限制已解除；已实际启动隔离服务、WebKit 和原生桌面应用。早期进程内接口测试通过隔离 SQLite、`app.request()` 和 MCP SDK 的 `InMemoryTransport` 调用真实业务服务；最终复验连接实际 HTTP 服务，MCP 使用 `StreamableHTTPClientTransport`，并完成真实浏览器与多窗口验证。本次测试进程已结束，独立的手工验收数据库保留。

上一轮 Computer Use 先设计用例，再通过客户端点击、输入、导航、计时和观察执行。发现并修复两处操作问题：Board 草稿新增可见的「保存任务」按钮并修正 Mac 保存快捷键；Task 归属调整关闭弹窗后，可从原/新里程碑的「变更历史与归属调整」找回并撤销。批量记录展示全部受影响 Task，撤销恢复整个批次，继续校验后续关系变化。更新客户端和服务后，使用同一测试数据库找回此前的旧事件，实际点击撤销并观察 Task、两层投入和已撤销标记恢复。

保存专项验证了空标题禁用、双击按钮仅创建一次且保留主归属和额外引用、标题连续两次 `⌘Enter` 仅创建一次，以及正文 `⌘Enter` 保存。人工完成与回顾链路、确认后保留原 Note 版本、持续型多次回顾均已通过客户端验证；归档和恢复按原有提示通过验收。完整用例、问题与复验见 [Computer Use 验收](project-management-computer-use-acceptance.md)。

真实 LLM 的前三轮合成抽样先后暴露输出上限 4000 tokens 不足、事件快照的 JSON 双层编码，以及把真实 Task ID 中的数字误判为数字主张的问题。现已提供独立输出预算和有界重试，明确提示预算耗尽；事件证据先解析为结构化对象；数字检查仅豁免被引用来源自身完整的实体 ID，精确引用和工时/百分比限制保持。提示升级为 v2 后，真实小样本全链路通过。该结果证明本次样本的生成与采纳流程可用，不代表所有模型或工作内容的洞察质量均已评估。

本轮计划内验收已完成；138 项是累计选定的不同自动测试，不代表运行了整个仓库的全部测试。Computer Use 场景单独记录，不计入自动测试总数。没有执行生产升级、发布或 release pipeline。

可复现的无浏览器检查：

```bash
./scripts/with-node.sh sh -c 'type node; type npm; node -v; npm -v'
./scripts/with-node.sh node node_modules/@playwright/test/cli.js test --config playwright.project-services.config.ts
./scripts/with-node.sh node node_modules/@playwright/test/cli.js test --config playwright.project-inprocess.config.ts tests/project-management.test.ts --grep-invert 'project page creates'
./scripts/with-node.sh node server/node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
./scripts/with-node.sh npm --prefix web run build
./scripts/with-node.sh npm --prefix server run build
```

以下入口会自动选择互不冲突的 Server/MCP 端口、创建新的临时数据库、先构建 Web/Server，再运行页面与接口旅程：

```bash
./scripts/with-node.sh node scripts/test-project-management.mjs
```

此入口现在默认运行全部 26 项项目接口与页面用例。本轮新增的 12 项 UI 位于甘特图、方向摘要和 Notes 标签三个测试文件中；原独立页面用例在 `tests/project-ui.test.ts`，总览创建用例在 `tests/project-management.test.ts`。

已有最新 Web/Server 构建时，可复用产物并重新创建隔离数据库和端口：

```bash
# 默认运行 61 项既有回归
./scripts/with-node.sh node scripts/test-legacy-regression.mjs
# 运行当前 26 项项目管理与页面验收
./scripts/with-node.sh node scripts/test-legacy-regression.mjs tests/project-management.test.ts tests/project-ui.test.ts tests/project-gantt-ui.test.ts tests/project-area-summary-ui.test.ts tests/project-notes-filter-ui.test.ts
```

真实 LLM 小样本使用单独的显式启用入口，不加入默认测试；仅在进程内复用现有模型配置，以临时库中的合成工作材料调用，不输出或提交凭据：

```bash
./scripts/with-node.sh node --require ./server/node_modules/tsx/dist/cjs/index.cjs scripts/test-project-insight-live.ts --run --output-tokens 8000 --diagnostics
```

每次运行最多调用一次模型；`--diagnostics` 仅在失败时保留合成模型输出、实际来源片段和指标到独立临时 JSON，不包含请求头、配置或凭据。

## 与计划的实现取舍

- 全局搜索直接以参数化查询检索 Area/Milestone 的权威字段，再合并原 Task/Note 搜索结果；没有扩大原 `search_documents.kind` 的 CHECK 或迁移旧 FTS。改名立即可查，旧三类索引保持原流程。
- `server/src/app.ts` 承接 HTTP 路由、SSE 和静态资源；`index.ts` 保留进程启动、监听、备份服务和关闭。这样可以在不监听端口的环境验证同一套真实接口。
- 服务端类型检查同步修正了原有的 Hono context 声明、EntrySource 导出、ParsedLine 默认字段、CLI 错误类型和共享文件 rootDir。Note 正文继续沿用 revision 保护，跨窗口刷新不得覆盖当前草稿；原 LLM 连接测试的预算规则保持。

## 迁移与回退边界

`_meta.project_schema_version` 和 `_meta.project_review_schema_version` 当前均为 `1`。新表/列为增量扩展，旧 Task 的主归属为空，普通 tags、日志、Note 和 Session 不自动转成项目对象。

第一次为有 Task/Note 数据的旧库建立项目表时，会在库旁创建 `<database>.before-projects-<timestamp>.db`。这是数据库快照，不包含独立附件文件；正式升级前仍应保留 Settings 导出的完整 ZIP。升级和生产启动没有在本轮执行。

完整 ZIP 恢复会映射正文、确认版本、证据、草稿和 Day Script 中的附件位置，并更新由位置派生的指纹；原始业务内容、版本、统计和覆盖范围保留。服务重启会把遗留运行中 AI 草稿标为中断，保留取证内容，可重试创建新草稿。

不要直接以旧二进制写入新版库。需要回退时，应先导出当前完整 ZIP，再使用匹配的升级前应用和备份；本轮没有实现把升级后新增项目记录降级合并进旧库的工具。

## 2026-09-12 后续泳道布局调整

方向已改为同一张甘特表内的泳道，摘要位于固定方向列，里程碑按时间及标题占位自动分轨。横向时间轴暂保留，纵向方案仍待讨论。重新构建 Web、服务和 Tauri 前端；本轮仅重跑相关 14 项 WebKit 回归，全部通过（15.0 秒），包括新增 3 项泳道测试；上文 131 项为上一轮完整结果。详见[路线图体验调整](project-management-roadmap-update.md#后续调整统一方向泳道)。

## 2026-09-12 概览信息层级重构

当前概览改为约72px单轨方向、36px轨距的紧凑甘特图，真实时间重叠才增加轨道。方向保留一行进展与投入，完整内容使用只读预览及右侧对象面板；关联 Notes 与摘要管理继续可达。顶部工具和低频筛选收敛。

本轮最终32项相关集成及 WebKit 测试通过（30.4秒），已重新构建隔离原生客户端并通过 Computer Use 与独立视觉检查。当前默认项目测试入口覆盖32项；上文26项/14项/131项为各历史阶段结果。验收细节及最新截图见[概览设计重构](project-overview-design-refinement.md)。未发布、未提交或推送代码，没有使用生产数据。
