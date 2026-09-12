# 项目制故障隔离修复与回归

日期：2026-09-12。依据用户要求，修复 [上一轮评估](project-management-rollout-risk-assessment.md) 中已复现的旧功能影响。原诊断已经改为正式验收：绿色现在表示新功能故障时旧功能仍然工作，不再表示“成功复现缺陷”。

## 已修复

| 问题 | 现在的行为 | 验证 |
| --- | --- | --- |
| 无关 Area / Insight 更新重建旧日志编辑器 | 项目事件只刷新项目数据；Task 归属/引用更新仅合并受影响 Task 的关系元数据，不重载日志 | Board 和 Focus 的编辑器 DOM、选择、撤销/重做、未保存文字均保留；同 Task 跨客户端归属仍及时更新 |
| 项目目录/引用错误波及旧工作区 | 运行时校验拒绝畸形结构和错误 source；目录保留最后有效数据；项目组件加局部错误边界，项目路由延迟加载 | 坏目录后 Task 开始/保存仍正常；坏引用后 Focus 仍可保存；Report 项目组件真正渲染出错时旧计时及导航继续可用 |
| 新草稿缓存故障阻断创建或状态通知 | 读取、写入、删除均可降级；仅草稿或有效预留 ID 改变才访问缓存 | 写入/删除失败时普通 Task 创建、取消、计时及 Zustand 后续监听器继续；有效关联仍原子提交 |
| 普通创建依赖空项目引用事务 | UI 省略空项目字段；服务端兼容 `references: []`，不进入引用处理 | 项目存储异常下普通创建成功；显式非空或非法关联仍失败并完整回滚，不产生半个 Task |
| 新统计失败导致旧 Report 停表或列表失败 | session 聚合独立于项目表；项目统计在其上增加分组；原页面计数始终按 session 实时计算 | 定时项目统计先成功再 500 时工作时长继续；坏项目存储下 Report 和计时切换/AFK/恢复正常 |
| 项目引用清理耦合 Task 删除 | 去除冗余显式清理，依赖已存在并启用的外键级联；保留原删除事务 | 正常关联清理、引用表异常下旧 Task 完整删除；真正外键阻止删除时所有旧记录及运行中 session 完整回滚 |
| 无关项目事件重置 Report 分页/关闭详情 | 项目分布单独刷新；旧报表仅由原期间、筛选和手工刷新驱动 | 已加载第二页并打开 Task 后，无关方向更新不改变列表及选中详情 |
| Mac 草稿正文 Control+Enter 入口改变 | 保留 Control+Enter，同时支持 Command+Enter，共用单次保存流程 | 两个快捷键各创建且仅创建一个 Task |

统计聚合保留半开期间、运行中截止、未来区间裁剪和重叠记录求和口径；没有新增对历史 session 的写入。Task 删除保留原事务与旧清理链路。原有明确项目关联失败仍对用户可见，不静默忽略。

## 本轮结果

| 验证 | 结果 |
| --- | --- |
| 既有 Task / Focus / 计时 / Notes / 搜索回归 | 181 项通过，2.2 分钟 |
| 既有项目 HTTP / MCP / SSE / 甘特 / Notes 筛选集成 | 32 项通过 |
| 本次浏览器故障隔离与快捷键验收 | 12 项通过，23.7 秒，无跳过 |
| 服务、数据、统计、备份、缓存及响应校验 | 61 项通过，2.4 秒，无跳过；其中修复后的 13 项服务/缓存验收再次通过，重复不另计 |
| Web / Server 构建 | 通过；Web 构建包含 TypeScript 检查 |
| 差异格式检查 | `git diff --check` 通过 |

共 **286 项不同用例通过**，不把重复运行计为新覆盖。新故障测试覆盖 HTTP 500、成功响应格式错误、局部渲染错误、缓存配额/权限错误以及临时项目存储故障。

首次集成中，两个新快捷键测试因为列表 h4 和详情 h1 同名产生严格定位错误，已限定详情标题；缓存验收改用明确的“取消”按钮验证取消操作，Escape 的原有独立回归仍通过。这些测试修正没有放宽服务器保存、单次创建或缓存降级断言。Report 类型检查中的残留刷新状态引用也已在最终构建前修正。

所有浏览器测试使用当前源码构建、WebKit、自动端口和临时数据库；服务测试不启动监听，不接触生产库。没有安装/发布、重启日常服务、提交或推送代码。本轮验证没有包含 macOS 原生锁屏/睡眠唤醒、生产规模压力测试、完整旧版回退演练，也没有新增项目功能总开关；这些不能算作已完成的发布验收。

## 复验入口与日志

```sh
# 构建并运行故障隔离验收
./scripts/with-node.sh node scripts/test-project-management.mjs tests/project-rollout-browser-probes.test.ts

# 全部隔离服务测试
./scripts/with-node.sh npm exec -- playwright test --config=playwright.project-services.config.ts

# 已完成构建后，复验旧功能（独立库/端口）
./scripts/with-node.sh node scripts/test-legacy-regression.mjs tests/data-integrity.test.ts tests/auto-takeover.test.ts tests/day-script.test.ts tests/focus-rich-meeting.test.ts tests/focus-code-block-scroll.test.ts tests/work-overview-keyboard.test.ts tests/cmd-s-draft-entry.test.ts tests/phase4-ui.test.ts tests/pinned-content.test.ts tests/plan-today-draft.test.ts tests/notes.test.ts tests/search-relevance.test.ts tests/search-done-detail.test.ts
```

本地验证日志位于 `artifacts/rollout-fixes-2026-09-12/`，由仓库现有 `*.log` 规则忽略，不随代码提交；仓库中保留上述结果及可复验的测试：

- `isolation-acceptance.log`：最终 12 项浏览器验收及构建。
- `legacy-regression.log`：181 项旧功能。
- `services.log`：61 项服务/校验；`final-service-acceptance.log` 为 13 项最终复验。
- `browser-project.log`：32 项项目用例通过，及随后新测试第一次运行的定位失败；最终新测试结果以 `isolation-acceptance.log` 为准。

当前结论：本轮已发现且复现的旧功能影响已修复，正常功能和故障隔离回归均通过。此结论不等同于生产发布已经执行。
