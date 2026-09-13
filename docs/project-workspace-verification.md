# 项目工作区：风格、语言与回归验收

日期：2026-09-13。设计依据：[项目工作区设计](project-workspace-design.md)。

本轮完成英文系统下的国际化、搜索选择与 Task 批量归属、数字快捷键和大屏布局调整。项目接口与页面 62 项、服务 68 项通过；181 项既有功能用例均已完成本轮验证，具体复跑过程见下文。没有新增数据库迁移，没有操作生产数据或发布到日常环境。

## 改动与行为

| 用户反馈 | 本轮结果 |
| --- | --- |
| 英文系统仍出现中文功能文案 | 沿用现有 i18n，新增静态文案、日期、状态、提示、空态和无障碍标签跟随语言设置。Auto 使用系统语言；显式设置优先。用户名称、笔记及历史文本不自动翻译。 |
| 下拉框与 Task 批量归属难用 | 项目控件统一为可搜索弹层，支持方向键、Enter、Esc 和焦点返回。Board 平时保持紧凑；进入选择模式后显示数量、全选、清除与归属操作。选择任务后搜索目标、预览历史投入、保存，并可撤销整批调整。 |
| 新页面没有数字快捷键 | 侧栏和快捷键共用顺序定义：Cmd/Ctrl+1–4 保持原页面，+5 打开项目，+6 打开设置。项目页支持搜索和新建快捷键；嵌套选择器先关闭自身，再允许 Esc 关闭外层编辑窗口。 |
| 大屏页面未充分使用空间 | 概览占满工作区余下宽高，所有方向共用时间轴；泳道继续保持紧凑，不通过拉高单行填空。详情使用主内容与辅助侧栏；长文字仅局部限制阅读宽度。 |

点击方向或里程碑，可以在右侧查看进展、下一步和关联 Notes。编辑、历史、模型草稿和回顾保留在相应上下文中；回顾的高级分析预算默认收起。

## 旧工作流保护与语言边界

**Focus 的导航保存保护仅接入应用侧栏和 Cmd/Ctrl+1–6。** 有未保存编辑时先保存草稿再切换；已有保存请求运行时等待它完成，并保存期间新增的文字。重复导航使用最后请求的目的页。保存失败或版本冲突时留在当前可编辑页面；未改动的 Focus 不发起保存。这里保存的是恢复草稿，不自动提交 Focus 进度或 Task 日志。不能据此声称浏览器后退、所有内部链接或进程退出均受同一保护。

新 Review 的标题、正文模板和默认标签按请求语言创建，关联已有 Note 时不替换其内容。新 AI 草稿将生成语言保存在既有 `evidence.analysis.locale` 中，语言参与请求去重，供提示词、重试、后台标题、预算耗尽提示和采纳包装使用。证据及模型正文保持原文；旧草稿缺少该字段时沿用原中文行为。完整备份恢复保留语言并重算对应请求标识。这是已有 JSON 元数据的扩展，没有增加数据库表或列。

## 自动验收

| 范围 | 实际结果与覆盖 |
| --- | --- |
| 项目接口与页面 | **62 项通过**。覆盖真实 HTTP/MCP/SSE、方向与里程碑、摘要和回顾、Notes 引用、批量归属、英文与中文控件、快捷键、嵌套弹层、故障隔离，以及 Focus 导航保存和失败回退。 |
| 服务 | **68 项通过**。包括数据归属、统计、草稿与故障隔离、语言解析、新 Review/AI 语言持久化、模型替身、重试采纳、旧记录兼容和完整备份恢复。服务结果来自本轮成功执行输出，未单独落盘日志。 |
| 既有功能 | 完整 181 项运行先得到 **180 通过、1 失败**。失败项是 Work Overview 隐藏信号的顺序用例，后续校准其初始加载假设并通过正式用例、两种受控加载顺序和所属 `plan-today-draft.test.ts` **16 项整组复验**。因此 181 项均经本轮验证，但不是同一次完整运行全绿。 |
| 大屏与语言 | WebKit 使用 **1728×1117、2056×1329** 两种 Mac 逻辑分辨率，检查甘特宽高利用、紧凑轨道、水平溢出及英文页面/悬停/侧栏；英文详情完成确认到 Note 编辑、回顾版本确认与持久化全链路纳入页面验收。 |

Work Overview 原失败并不是隐藏操作改变了排序：任务上下文与 carry-over 数据独立到达，旧断言预设了其中一种初始先后顺序。当前测试等待两类信号完整可见，记录初始顺序，再精确检查 Hide 前后顺序不变。分别控制两类数据先到的诊断均通过。`TodayPage.tsx` 的 `workOverviewItems` 计算块共 202 行，与本轮起点 `HEAD` 完全一致；没有为了通过测试改动产品排序。

复跑用例不重复累计。以上是选定验收范围，不代表运行了仓库所有测试。AI 服务使用确定性模型替身；本轮没有真实模型质量或付费调用验收。

保留的本地日志：

- [项目 62 项](../.dev-data/project-style-zt00oi/verification/chronicle-style-project-final.log)
- [既有功能完整运行 180/181](../.dev-data/project-style-zt00oi/verification/chronicle-style-legacy-final.log)
- [Plan Today 16 项整组复验](../.dev-data/project-style-zt00oi/verification/chronicle-style-plan-final.log)
- [两种受控加载顺序](../.dev-data/project-style-zt00oi/verification/chronicle-overview-order-both-sequences.log)
- [正式隐藏顺序用例复验](../.dev-data/project-style-zt00oi/verification/chronicle-overview-order-acceptance.log)

## Computer Use 与截图

在独立预览浏览器中实际点击、键入和观察，完成：选择两个 Task → 搜索归属目标 → 预览 → 保存 → Undo → Esc；Cmd+5 切到项目；点击方向查看关联 Notes；在 Focus 输入未完成的内容后立即 Cmd+5，再返回核对文字保留。上述操作验证真实页面交互，不冒充本轮已在生产原生客户端验收。

以下五张截图均来自合成演示数据，保存在本地验收目录：

| 截图 | 内容 |
| --- | --- |
| [英文概览](../.dev-data/project-style-zt00oi/screenshots/projects-english-1728.png) | 大屏共享甘特与紧凑工具栏 |
| [深色概览](../.dev-data/project-style-zt00oi/screenshots/projects-dark-1728.png) | 沿用现有主题 token |
| [方向侧栏](../.dev-data/project-style-zt00oi/screenshots/projects-area-context-1728.png) | 摘要、下一步与关联 Notes |
| [Task 选择模式](../.dev-data/project-style-zt00oi/screenshots/task-selection-1728.png) | 多选数量与归属入口 |
| [归属预览](../.dev-data/project-style-zt00oi/screenshots/assignment-preview.png) | 提交前的历史投入影响 |

预览服务已停止，浏览器视口恢复，本轮标签页已关闭。独立演示数据、截图和上述日志保留；没有执行生产升级、release pipeline、提交或推送。
