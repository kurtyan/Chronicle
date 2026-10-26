# 工作大纲与每日任务摘要：交付验证

日期：2026-10-15。分支：`codex/work-outline-daily-summary`。

设计、交互、数据结构、API 和快捷键规则见 [work-outline-design.md](work-outline-design.md)。代码保存在该分支工作区；本次未提交、推送、发布或替换正在使用的 Chronicle 服务。

## 使用入口

- 侧栏第 4 位为「工作大纲」，快捷键 `Cmd+4`（其他平台 `Ctrl+4`）；Report、方向与里程碑、Settings 依次为 `Mod+5/6/7`，Settings 始终最后。
- 左侧直接编辑层级，Enter 新行，Tab / Shift+Tab 缩进，Alt+上下移动整支，Cmd+S 立即保存；平时自动保存，不分草稿与正式提交。
- 输入 `@` 关联已有 Task，或选择菜单底部新建。右侧表单支持真实 `Ctrl+Enter`，成功后回填引用并打开详情。左侧 Ctrl+Enter 不提交业务数据。
- 右侧显示累计工时、每日工时和已结束日期的摘要；当天只有工时。点击历史格查看完整摘要、来源和刷新状态。
- Settings → AI →「每日任务摘要」配置独立提示词、输出 token、启停、轮询间隔、输入上限、每日调用预算、时区，并提供历史日期试跑和调用记录。

日期起点沿用 Focus 设置。默认每小时对账一次完整历史候选，不依赖星期或启动事件。电脑关闭期间服务不能执行；恢复运行后下一次周期检查会补齐所有遗漏的已结束日期。来源修改、删除、改日期会刷新相关摘要，来源未变不重复调用模型。

## 结构

| 层 | 实现与职责 |
| --- | --- |
| 共享契约 | `shared/workOutlineTypes.ts`、`shared/taskDailySummaryTypes.ts` |
| 编辑器与派生逻辑 | `OutlineEditor.tsx`、`web/src/lib/workOutline.ts`：稳定行 ID、树操作、剪贴板、弱化规则 |
| 客户端状态 | `workOutlineStore.ts`：串行自动保存、本地恢复、版本/世代冲突、创建幂等 |
| 页面与接口适配 | `WorkOutlinePage.tsx`、`workOutlineApi.ts`：共享行布局、日期查询、详情面板 |
| 大纲服务 | `workOutlineService.ts`：严格文档校验、CAS、原子 Task 创建与绑定 |
| 日期和证据 | `workCalendarService.ts`、`taskDailySourceService.ts`：Focus 日界、正式来源和输入指纹 |
| 摘要执行 | `taskDailySummaryService.ts`、`taskDailySummaryWorker.ts`：历史对账、持久队列、租约、预算、分块续跑 |
| 查询和配置 | `taskDayQueryService.ts`、`taskDailySummarySettings.ts`：工时查询、来源分页、调度配置 |
| 路由与持久化 | 独立 routes/schema；复用现有 origin/maintenance 中间件、LLM provider 和 recordedWork 统计口径 |

## 首轮交付测试结果（试用反馈前）

全部在 adversarial review 修复后重新运行。

| 范围 | 结果 |
| --- | --- |
| 新增单元/服务测试 | **62 / 62** |
| 既有服务回归：Projects 核心、工时、备份、响应验证 | **35 / 35** |
| 新增 WebKit 界面测试 | **25 / 25** |
| 既有界面回归：Notes、Focus 编辑、Work overview 键盘、Task 日志草稿/提交 | **42 / 42** |
| 合计 | **164 / 164** |
| Web TypeScript + Vite 构建 | 通过 |
| Server 构建及 `tsc --noEmit` | 通过 |
| `git diff --check` | 通过 |

新增服务测试分布：daily 19、editor 12、settings 6、storage 14、store 11。新增界面测试分布：workspace 13、interaction 8、settings 4。

## 功能覆盖

| 能力 | 验证 |
| --- | --- |
| 入口与快捷键 | 当前侧栏和数字快捷键顺序一致：工作大纲 Mod+4、Report Mod+5、方向与里程碑 Mod+6、Settings Mod+7；右详情的开始/完成/提交只在正确焦点范围响应 |
| 层级编辑 | Enter、减号、Tab/Shift+Tab、整支移动、撤销、深层层级、复制新 ID、剪切保 ID、非根子树相对层级 |
| 输入保护 | IME Enter 不拆行；相邻两个 Task 引用不能因 Delete/Backspace 合并而丢失其中一个 |
| Task 引用和新建 | 查询完成 Task、菜单选择/退出、新建表单/取消、真实 Ctrl+Enter、重复提交、丢响应重试、点击详情 |
| 保存恢复 | 输入期间保存、离线副本、回执重放、多窗口冲突、目标移动/删除、导入后旧窗口和旧回执拒绝 |
| 完成弱化 | 完成 Task 继承到普通后代、独立子 Task 截断继承、父行全部后代 Task 完成、重新打开恢复 |
| 表格 | 左右行高/位置对齐、调整宽度、折叠、日期导航、累计工时、当天不泄露摘要、历史摘要/来源/刷新/错误恢复 |
| 删除边界 | 删除大纲位置保留 Task、正式日志、work_sessions 与每日摘要；真实 Task 删除后保留可编辑失效引用 |
| 日期与时间 | Focus 起点、显式时区、跨日 session、运行中计时、历史补录、Focus/会议来源、当前日期拒绝摘要 |
| 对账和调度 | 周期实际执行、每日多轮、间隔调整、启停、停机多日后下一周期补齐、日志增改删/改日期、未变零调用 |
| 队列与模型边界 | 租约、旧结果隔离、重试与 Retry-After、限额、配置等待、长输入分块、每天 1 次调用跨日/重启最终完成 |
| Settings | 独立保存、恢复默认、非法数值、未保存提示词试跑、历史日期限制、调用日志、读取/试跑错误恢复 |
| 数据库维护 | 成功导入旋转世代、失败不旋转、重启保留世代、并发上传只允许一个请求取得维护锁 |

## 对抗性代码审查

在初轮新增单元和界面测试通过后，由子 agent 交叉审查新增代码；修复后由其他 agent 或原发现者复核。审查范围包含大纲服务和保存状态、编辑器、设置、每日摘要执行与导入生命周期。

未发现 Critical。发现并修复以下 5 项 High / P1；复核时无剩余 Critical/High。

| 问题 | 修复与回归 |
| --- | --- |
| 创建结果未知时切换右侧面板导致恢复入口丢失，另一创建可能替换回执 | 所有面板入口和离开页面统一保护；store 拒绝不同请求覆盖 pending；界面测试模拟真实提交后丢响应再重试，仅一个 Task |
| 复制非根深层子树改变末尾兄弟的父级 | 粘贴前整段统一减去首行深度；纯逻辑与实际 copy/cut/paste 测试验证 `[1,2,3,2]` 相对关系保持 |
| 长输入在低每日预算下反复生成第一块而永远不能发布 | 持久分块/合并检查点；跨日与重启继续，命中不扣额度；每天 1 次调用最终发布且不重复已完成调用 |
| 导入备份恰好同/低 revision 时旧窗口静默覆盖新内容 | 持久 epoch 与 expectedEpoch 校验先于回执重放；服务与 GUI 验证没收到 SSE 仍拒绝覆盖，保留本地草稿 |
| 并发导入在读取上传文件期间越过维护检查 | 解析后同步复查抢锁，只有持有者释放/恢复调度器；确定性并发测试验证第二请求 503，维护期不提前结束 |

## 隔离与复现

测试入口在加载 app/config 前设置全部持久化位置。DB、配置、日志、附件、临时目录和备份均在项目 `.dev-data` 内，界面测试使用自动分配的空闲端口、全新服务和 WebKit 上下文，不复用生产服务器。

LLM 服务测试使用受控 mock provider；界面测试默认强制连接本地不可用占位地址，特定用例拦截响应。没有使用生产数据库、生产配置或真实模型调用。本次验证包含调用协议、失败处理和输出结构，不声称验证了真实模型的摘要质量。

运行环境：仓库 `scripts/with-node.sh`，Node v25.5.0，npm 11.8.0。

单元/服务命令（试用反馈修复后为 102 项）：

```sh
./scripts/with-node.sh node node_modules/@playwright/test/cli.js test \
  --config playwright.work-outline-services.config.ts \
  tests/work-outline-daily-service.test.ts \
  tests/work-outline-editor-service.test.ts \
  tests/work-outline-settings-service.test.ts \
  tests/work-outline-storage-service.test.ts \
  tests/work-outline-store-service.test.ts \
  tests/project-core-service.test.ts \
  tests/project-work-period-service.test.ts \
  tests/project-backup-service.test.ts \
  tests/project-response-validation-service.test.ts
```

界面命令（第二轮试用反馈修复后构建并运行 86 项）：

```sh
./scripts/with-node.sh node scripts/test-work-outline.mjs --regressions
```

仅运行工作大纲的 35 项界面测试，可去掉 `--regressions`；确认构建未变化时可增加 `--skip-build`。

服务端独立类型检查：

```sh
./scripts/with-node.sh npm --prefix server exec -- tsc --noEmit -p server/tsconfig.json
```

首轮界面运行目录：`.dev-data/work-outline-ui-7apO0l`；端口 57965；结果文件 `results/.last-run.json` 为 passed，`failedTests` 为空。布局截图 `work-outline.png` 留在该目录，已做视觉检查。临时服务在测试结束后停止。

构建保留已有的 Browserslist 数据过期、混合动态/静态 import 和 bundle 大小提示；没有为消除这些提示改动无关构建配置。

## 2026-10-15 试用反馈修复

| 反馈 | 修复与验证 |
| --- | --- |
| Task 详情挤在右下部 | 详情、新建、每日记录面板直接覆盖页面整个右侧，顶部至底部；左侧保持可编辑。验证长日志独立滚动、窄窗口及旧宽度偏好下关闭与提交按钮可达。收窄页面按钮样式作用域，避免污染内嵌 Task 详情按钮。 |
| 左侧像表格，不能粘贴嵌套列表 | 改为连续的自然文本行，去掉逐行横线与大块留白；右侧测量并跟随行高。剪贴板优先内部格式，再解析 HTML 列表或纯文本缩进；覆盖真实 Chronicle Notes 复制、外部嵌套列表、空格/Tab、编号/Unicode 列表、选区替换、撤销与保存重载。 |
| Esc 取消后带回旧创建草稿 | 未提交的创建表单随关闭丢弃，再次打开使用当前文字；仅已提交但结果未知的请求保留幂等恢复。测试标题、说明、类型、优先级、标签、日期均重置；同步恢复编辑焦点，避免取消后的延迟抢光标。 |
| Settings 应在末尾 | 本轮先将 Settings 移到主导航最后并保留旧数字快捷键；后续用户明确要求按位置重新编号，已由下方第二轮修复取代。 |
| 两周日期范围为何受限 | 保持原实现：每页 14 天，左右箭头按 7 天移动日期窗口。14 天是首版界面默认值，不是历史数据保留上限，也不是技术限制；本轮按要求不改日期范围。 |

两位子 agent 对剪贴板、面板生命周期、布局及导航进行交叉审查，无未解决的 Critical/High。最终代码构建后重跑以下全部测试：

| 范围 | 结果 |
| --- | --- |
| 工作大纲单元/服务（daily 19、editor 17、settings 6、storage 14、store 11） | **67 / 67** |
| 既有服务回归 | **35 / 35** |
| 工作大纲 WebKit 界面（workspace 13、interaction 8、settings 4、paste 5、feedback 4） | **34 / 34** |
| 既有界面回归（原 42 项，加项目导航/风格 9 项） | **51 / 51** |
| 合计 | **187 / 187** |

首轮修复验证发现两个测试场景问题：导航定位误包含 Settings 内部菜单、650px 窗口未触发表单滚动。分别将定位限定为主导航、改用 440px 窗口验证滚动后，完整重跑 **102 项单元/服务 + 85 项界面**，全部通过。

最终界面目录：`.dev-data/work-outline-ui-CPMonS`，自动端口 62894；运行使用已验证且未改变的构建（`--regressions --skip-build`）。`results/.last-run.json` 为 passed，失败列表为空。`feedback-task-detail.png`、`feedback-create-task.png` 与 `work-outline.png` 留作布局证据。所有数据库、配置、日志、附件及临时文件仍限定在项目 `.dev-data`；未写入 production 数据库，未重启生产服务。

## 2026-10-15 第二轮反馈：菜单滚动与导航编号

- `@` 菜单的上下键原先仅改变高亮，没有滚动选中项。本轮按选项与菜单边界仅调整菜单自身 `scrollTop`，保留编辑焦点与背景滚动位置；查询变化回到首项，候选缩减时约束选择索引。新增 WebKit 测试覆盖 8 个长标题结果和新建行，逐键检查可见性、向上返回、查询变化重置及 Enter 打开创建表单。
- 按用户最新指定将工作大纲移到第 4 位，数字快捷键同步为：看板 1、今日 2、笔记 3、工作大纲 4、报告 5、方向与里程碑 6、设置 7。设置保持最后；中英文导航顺序、title、ARIA、实际按键及 Focus 保存后导航测试均同步验证。
- 两位子 agent 对菜单滚动和导航进行交叉审查，未发现待修复问题。Web/Server 构建通过；本轮重跑 **28 / 28 编辑器与状态服务测试、86 / 86 WebKit 界面测试**，均通过。后端摘要代码本轮未改变，不将上一轮其他服务用例计入本轮重跑数量。
- 界面运行目录 `.dev-data/work-outline-ui-iykpoY`，自动端口 64660；`results/.last-run.json` 为 passed，失败列表为空。沿用全隔离测试入口，无 production 数据库写入或生产服务重启。
