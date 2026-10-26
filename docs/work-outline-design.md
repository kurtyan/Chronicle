# 工作大纲与每日任务摘要设计

日期：2026-10-15

状态：已实现并完成交叉审查；最终验证记录见 [work-outline-verification.md](work-outline-verification.md)。本稿定义独立的新界面及 task_daily_summary，不涉及 Area 和 Milestone 的替换、映射或迁移。

核心方案：左侧用连续的轻文本编辑器组织任意层级条目，条目按需引用 Task；右侧按同一行展示该 Task 的累计工时、历史每日摘要及每日工时。task_daily_summary 独立于大纲，由服务端固定周期检查源数据，缺失则生成、变化则更新、未变化则跳过。

## 一 已确认的产品行为

| 项目 | 行为 |
| --- | --- |
| 文本和层级 | 每行是普通文本条目，通过减号、Enter、Tab、Shift+Tab 编辑层级；允许继续拆解，不固定方向和阶段的层数 |
| Task 关联 | 一行可不关联 Task；关联后具有 Task 状态、日摘要、工时和详情入口 |
| 关联和新建 | 通过 @ 菜单选择已有 Task，或选择新建；创建表单在右侧打开 |
| 创建快捷键 | 焦点进入右侧创建表单；真实 Ctrl+Enter 等同于创建；成功后引用回填原条目，右侧转为 Task 详情 |
| 大纲保存 | 自动保存；Cmd+S 立即保存；不设置全局草稿和正式提交两个版本 |
| 详情 | 点击 Task 引用，在右侧覆盖日期表打开详情；左侧保留，关闭后恢复原表格位置 |
| 左右联动 | 增删、移动、缩进、折叠立即反映到对应表格行；不等待保存请求 |
| 普通行 | 未关联 Task 的行在右侧保留空白占位，不自动获得 Task 身份或计时能力 |
| 删除条目 | 删除大纲位置及其右侧行；保留真实 Task、日志、工时和 task_daily_summary |
| 历史列 | 仅已结束日期展示每日摘要和工时，范围截至前一天，包含前一天 |
| 当天列 | 只展示该日截至服务端当前时刻的工时；不生成或展示当天摘要、日志摘录、临时摘要 |
| 日期边界 | 沿用 Focus 配置的日起点；不使用周一至周五、周末、节假日等工作日判断 |
| 独立摘要实体 | 某 Task 是否出现在大纲、出现几次，都不影响它的每日摘要生成和保存 |
| 摘要更新 | 已成功生成且输入明细未变则跳过；对应日期明细新增、修改或删除后刷新 |
| 周期执行 | 服务端每天定时执行多轮；启动事件不是生成任务的业务触发条件 |

第一版采用：一个全局大纲、一行最多一个 Task 引用、默认显示最近 14 个日期列（含当天）、每小时进行一轮摘要检查。检查周期可以在设置调整。

## 二 页面与交互

### 页面布局

从左到右为固定累计工时列、可调整宽度的文本大纲、横向滚动的日期列。纵向使用同一个滚动容器。日期列从早到晚排列，当天位于最右侧，进入时定位到当天。

左侧呈现连续的笔记列表：不加逐行边框或固定表格行高，普通文本使用自然行高，缩进与项目符号表达层级。右侧依照文本实际高度对齐；不能反过来为了日期格把左侧文字撑成表格。

累计列显示该行所引用 Task 的全部已记录工时，包含今天截至查询时刻的工时。日期格显示该 Task 自己在该日的记录。父行的 Task 和子行的 Task 各自统计，不把子 Task 工时混入父 Task；没有 Task 的父行保持空白。分支累计统计不是第一版默认能力。

历史格将摘要与工时紧凑并列，摘要超长时截断；展开完整摘要和来源使用格子详情，避免整张表被长文撑高。当日格只有工时，正在计时可用简洁的运行标记。摘要等待生成、生成失败和没有记录分别表达，不能都显示成零。

右侧 Task 面板从页面顶部覆盖至底部，不卸载底层表格。桌面上左侧始终可编辑；关闭面板恢复日期横向滚动、纵向位置和原条目选区。窄屏允许详情临时占用更多空间，但保留可返回的编辑位置。

### 编辑操作

| 操作 | 规则 |
| --- | --- |
| 行首输入减号和空格 | 形成大纲条目，减号作为列表标记呈现 |
| Enter | 拆分当前逻辑行，沿用层级；新半行放在原行完整子树之后，原 ID 及原后代归属不变；Task 引用随所在半行保留 |
| Tab 和 Shift+Tab | 当前条目及其后代整体缩进或提升；不产生跳级或孤立子行 |
| 调整位置 | 支持整支移动及剪切粘贴，保留条目身份和 Task 关联 |
| 自动折行 | 仍为一个条目，不增加表格行 |
| 折叠 | 左右同时隐藏后代；有未完成后代时可显示数量提示 |
| @ 搜索 | 搜索已有 Task，列表末尾始终有新建入口；完成任务也可以被找到和关联 |
| @ 菜单按键 | 方向键选择并保持选中项在菜单可见区域内、Enter 确认、Escape 关闭；查询变化回到首项，Tab 留给层级编辑 |
| 新建标题 | 优先采用搜索词；没有搜索词则取当前行去除列表标记后的正文 |
| Cmd+S | 立即冲刷大纲自动保存队列 |
| Ctrl+Enter | 左侧无提交动作；右侧创建表单提交创建，右侧日志编辑区提交日志 |
| 点击 Task 引用 | 打开详情；查看本身不开始计时 |
| 复制条目 | 创建新的条目 ID，保留对同一个 Task 的引用，不复制真实 Task |
| 移除引用 | 条目恢复普通文本，右侧清空对应 Task 数据 |
| Undo | 撤销大纲编辑和关联；不删除已经创建成功的真实 Task |

new task 文本关键词不作为第一版自动创建指令。以后若增加别名，只打开同一个创建表单，仍由用户在表单里确认创建。

主动取消尚未提交的新建表单即丢弃该次表单草稿；同一条目再次新建时，以当前输入重新初始化。已经发出而结果未确认的请求仍保留幂等恢复能力，不能因切换面板产生重复 Task。

跨编辑器粘贴先读取剪贴板的结构化 HTML 列表，保留 ul/ol/li 的层级及文本；没有结构化列表时读取纯文本缩进与列表标记。外部 HTML 仅解析成规范文本和 Task 引用节点，不挂入页面执行。内部复制/剪切继续使用稳定行 ID 和相对层级规则。

中文输入法组合输入期间不执行拆行、关联确认或任务提交。合并两个分别关联 Task 的条目时，首版保留为两行并提示，不能静默丢弃其中一个引用。

### 完成后的弱化

弱化是派生显示状态，不写回 Task 状态，也不改变条目正文。

1. 关联 Task 的行只跟随自身 Task：DONE 则弱化，其他状态不按完成处理。
2. 未关联的后代行继承最近一个关联 Task 祖先的完成弱化；遇到另一个 Task 引用后，以该 Task 自身状态重新判断。
3. 未关联的父行，至少存在一个后代 Task 且所有后代 Task 都 DONE 时，也弱化。
4. 没有 Task 后代、也没有完成祖先的普通行不自动弱化。
5. 自身 Task 尚未完成的父行，即使所有子 Task 完成，也保持正常。
6. Task 重新打开或新增未完成后代后，重新计算受影响行和祖先。

按每一行设置文字样式，不对整棵子树容器设置透明度；否则父 Task 完成会错误地把进行中的子 Task 也淡化。完成内容保持可读，不默认隐藏，不整段加删除线。

## 三 编辑器与文档模型

使用专用 OutlineEditor，底层复用 Tiptap 和 ProseMirror 的选区、输入法及历史机制，外观接近 textarea。原生 textarea 无法给局部 Task 引用提供独立点击目标和状态样式，也不便稳定对应右侧行。

第一版采用扁平逻辑行 JSON：顺序和 depth 唯一表达层级。仅保存这一份文档；父子关系、Markdown、HTML、Task 集合、弱化状态、右侧行都是派生结果，不设置第二份可独立写入的树。

~~~ts
type OutlineDocument = {
  type: "doc";
  schemaVersion: 1;
  content: OutlineLine[];
};

type OutlineLine = {
  type: "outlineLine";
  attrs: { id: string; depth: number };
  content: Array<
    | { type: "text"; text: string }
    | { type: "taskRef"; attrs: { taskId: string; label: string } }
  >;
};
~~~

约束：

- 行 ID 为客户端生成的 UUID，不从文本、位置或 Task ID 推导。
- 首行 depth 为 0；非负；相邻行最多向下增加一级；使用迭代解析，不设固定的业务层级数量。
- 每行最多一个 taskRef；不在行属性再保存第二份 taskId。
- label 是离线展示和导出兜底，真实身份是 taskId，在线标题和状态从 Task 读取。
- Enter 保留上半行 ID、为新半行分配新 ID；移动保留 ID；复制分配新 ID。
- 同文档整行剪切粘贴可保留 ID，前提是原 ID 已移除且不会重复；外部粘贴生成新 ID。
- 纯文本中的 @标题不猜测为真实 Task。只有带有效 Task ID 的内部引用或用户菜单选择才建立关联。
- 服务端校验文档结构、ID 唯一性、Task 存在性和每行引用数量。已存档的同 rowId/taskId 失效引用可保留，新增不存在的引用拒绝；查询返回 missing 状态。
- Task 被独立删除时保留可移除的失效引用，不错误匹配到同名 Task。

### 行高与实时投影

一个连续编辑器承载整份文档，保留跨行选区和一次撤销。每个逻辑行有可测量的 DOM，以 rowId 对应右侧位置。

使用 ResizeObserver 处理文本折行、列宽、字体及窗口变化。左右共享逻辑行高度和纵向位置；日期格跟随文本高度，长摘要展开到详情。编辑事务立即重算行序和树结构，后台保存不阻塞显示。

日数据缓存以 Task ID 和日期为键，行布局以 rowId 为键。移动条目不会重算摘要；同一个 Task 多处引用复用同一份数据。初版不把编辑器拆成每行一个独立 textarea，也不先引入会破坏跨行选区的虚拟编辑器。

### 保存与并发

复用 Notes 已有的可靠模式：本地恢复副本、约 800ms 防抖、同一大纲串行保存、expectedRevision 乐观锁、Cmd+S 立即保存。

保存返回只推进该次快照的确认版本，不能覆盖请求期间的新输入。未编辑时可以接受远端刷新；本地有修改而远端版本变化时保留本地内容并进入冲突处理，不用最后一次写入静默覆盖。

数据库另有持久 epoch；每次成功导入备份后旋转。保存和创建请求同时提交 expectedEpoch 与 expectedRevision，服务端先校验 epoch，再查询幂等回执。这样旧窗口即使没收到导入事件、导入内容的 revision 恰好相同或更低，也不能覆盖新数据库。恢复副本保留 baseEpoch，跨世代草稿要求显式核对后采用本地或服务器版本，不自动重放旧请求。

Task 状态、工时、摘要和面板开关不会改变大纲 revision。折叠、列宽、滚动等视图状态独立保存。

## 四 Task 创建与右侧详情

面板状态为 closed、view(taskId, sourceRowId)、create(sourceRowId, initialTitle)。创建锚点使用 outlineId 和 rowId，不使用行号或点击时的坐标。

创建流程：

1. 打开创建表单，焦点进入右侧；此时没有创建真实 Task。
2. 用户点击创建或在该表单按 Ctrl+Enter。
3. 先冲刷当前大纲保存，确认目标行仍存在且没有关联其他 Task。
4. 调用原子创建并关联接口，携带 expectedRevision 和 idempotencyKey。
5. 服务端在同一事务中创建 Task、插入引用、增加大纲 revision，提交后再广播事件。
6. 返回 task、rowId、bindingPatch、outlineRevision；右侧转为该 Task 详情。

创建期间暂停该大纲的网络保存队列，允许本地继续编辑。返回时按 rowId 把 bindingPatch 合入当前文档，再用新 revision 保存后续修改；禁止用旧整份文档覆盖新输入。若本地已经删除目标行或改为其他引用，保留用户的新编辑并明确显示新 Task 未关联到原位置，仍可在右侧查看和重新关联。

请求开始前目标在服务端已被删除、占用或 revision 已变化，则整个事务不创建 Task，返回 409 并保留创建表单。重复点击、响应丢失后重试通过幂等记录返回原结果。

创建请求执行中或结果尚未确认时，右侧保留原创建表单，拦截切换 Task、日期详情、新建面板及离开页面。恢复入口使用同一个 idempotencyKey；store 也拒绝用另一请求替换未确认的回执。左侧仍可编辑，避免将恢复能力绑定到可变化的行号。

任务附件可复用现有 reservedId 流程，但 reservation 不等于请求幂等。Undo 成功创建后的引用只解除大纲关联。

现有 TaskDetailWorkspace 的提交快捷键使用 page scope，嵌入前必须改成由详情容器内的焦点决定是否处理。当前快捷键注册器还把 ctrl、cmd、mod 合并；新界面必须区分真实 Ctrl+Enter 和 Cmd+S，并验证没有左侧焦点提交右侧日志的问题。

## 五 独立的每日摘要实体

业务实体名为 task_daily_summary，建议数据库表名 task_daily_summaries。一个 Task 对应多个日期记录；它不引用 outlineId 或 rowId。

~~~mermaid
flowchart LR
  O[大纲条目] -->|可选引用| T[Task]
  T --> L[正式明细]
  T --> W[计时记录]
  L --> R[按 Task 和日期构建输入]
  W --> R
  P[固定周期检查] --> R
  R -->|缺失或指纹不同| Q[持久任务队列]
  Q --> G[生成或刷新每日摘要]
  G --> S[task_daily_summary]
  O --> V[右侧日期表]
  S --> V
  W -->|独立计算工时| V
~~~

### 日界

日期分组沿用 Focus 的 start_of_day_offset。新增明确的 IANA 时区配置，建议初值 Asia/Shanghai；日界由服务端统一计算并返回给前端，不能让服务端和浏览器分别用自己的本地时区。

例如仅假设日起点是 05:00，10 月 14 日这一列对应 10 月 14 日 05:00 至 10 月 15 日 05:00。实际读取设置，不硬编码 05:00。这里的日期区间与星期、周末、是否上班无关。

使用当前时区下下一个日期的日起点确定结束边界，不直接加固定 24 小时。日界配置形成 calendarPolicyId；缓存和查询带上该 ID，防止设置变化后混用两个不同口径的同名日期。

当前日期由服务器 now 和日界计算。只有 periodEnd <= now 的分组有资格生成摘要。日期表响应包含 currentWorkDate、lastClosedWorkDate、asOf 和每列的起止时间。

### 明细与工时来源

| 数据 | 用途 |
| --- | --- |
| 对应日期的正式 Task 日志 | 当天工作内容的主要证据 |
| Focus 已提交到 Task 的日志 | 按明确的 Focus 日期归属纳入一次，不再重复加入原 Focus 正文 |
| 有明确会议时间的会议纪要 | 作为对应日期的会议事实；保留会议来源和时间，不能把普通 Task body 都当作工作记录 |
| 普通 Task 描述和置顶内容 | 识别背景；不能把其当前全部内容当作历史当天发生的工作 |
| 日志草稿 | 不进入摘要 |
| 当前 Task Summary 和当前完成状态 | 不作为历史当天事实，不用今天的进展回填过去 |
| work_sessions | 唯一的已记录工时来源，按日期窗口裁剪 |
| Focus 编辑到提交的跨度 | 不叠加为工时 |

补充 task_entries 的 updated_at、revision、work_date、work_date_source、source_kind 和 source_id。created_at 保持原来的提交时间语义：

- 普通日志默认归入提交所在日期；补录时允许显式指定归属日期。
- Focus 生成日志明确传入 scriptDate；修改日志不改变原归属日，除非显式调整。
- 会议纪要使用明确会议时间建立证据归属；跨日纪要保留时间范围，摘要不得臆造每一天的细分成果。
- 旧日志默认按 created_at 分日；只有可靠的结构化来源映射才能修正，不能让模型猜实际日期。
- 置顶文字是会累计修改的内容，缺少变更历史的旧内容不能可靠拆分到每天。首版按明确日志和会议记录汇总，置顶作为上下文。

时长使用 getRecordedWork 的裁剪与统计口径。跨日 session 分摊到相交日期，未结束 session 截至 asOf；已有重叠记录按现有 Report 口径相加并返回异常，不擅自改成另一种统计算法。

### 持久化结构

| 表 | 主要字段与约束 |
| --- | --- |
| work_outlines | id，title，document_json（内含 schemaVersion），revision，created_at，updated_at |
| work_outline_requests | outline_id，request_key，request_hash，result_json，created_at；唯一约束保护创建及保存重试 |
| _meta.work_outline_epoch | 数据库导入世代；请求先校验世代，再检查大纲 revision 与回执 |
| task_daily_summaries | id，task_id，work_date，calendar_policy_id，period_start，period_end，summary_text，content_kind，input_fingerprint，evidence_json，model，prompt_version，generation，generated_at，llm_call_log_id |
| task_daily_summary_jobs | id，task_id，work_date，calendar_policy_id，requested_fingerprint，state，attempts，next_attempt_at，lease_token，lease_expires_at，last_error，updated_at |
| task_daily_summary_chunks | Task、日期、日界、完整输入指纹、chunk_hash 联合唯一；保存已验证的分块/合并结果与调用记录 ID，支持跨预算日和重启续跑 |
| task_daily_summary_budget | 日界、当前工作日期、已调用次数；事务预留额度，缓存命中不计调用 |

摘要表和任务表各以 task_id、work_date、calendar_policy_id 为唯一键。任务表的同一行可以在新输入出现后再次排队。正文和执行状态分开：更新失败时旧摘要仍可显示并标记待更新或失败。

工时不以摘要中的数字为准，不需要让模型计算。日期表从 work_sessions 单独查询当前准确值；summary_text 不嵌入总时长，避免仅修正计时就必须重写文字。

evidence_json 保存输入条目 ID、版本、内容 hash、归属日期和用于核查的片段；输入及模型调用日志保留关联。Task 改名不会改变历史摘要的事实依据。

## 六 定时对账与摘要生成

### 一个统一的判断规则

定时任务不是只查询昨天，也不依赖上次上班日期或启动事件。每轮构造候选集合：

~~~text
候选 Task 日期键 =
  正式明细按 Task 和归属日期分组
  ∪ work_sessions 按实际相交日期分组
  ∪ 已存在的 task_daily_summary 日期键

仅保留已经结束的日期区间。

对每个候选键：
  读取该日期的源数据并计算 inputFingerprint
  没有摘要                 -> 入队
  指纹与已发布摘要不同     -> 入队刷新
  指纹相同                 -> 跳过
~~~

候选必须包含已有摘要键：否则某日所有日志被删除后，该日期从源数据中消失，旧摘要会永远留存而无法纠正。

指纹来自当日证据条目 ID、内容、归属日期、有效来源、日界及提示词版本。另纳入 hasRecordedWork，确保无明细日期从 time_only 变 empty 时能纠正。具体工时数值不参与叙述指纹。明细顺序使用稳定排序。不要仅用 Task.updated_at，也不要只看明细创建时间。摘要输入不包含会随今天变化的当前 Task 状态或全量当前详情。

工时单独更新；如果只有计时数值变化而工作内容证据没变，刷新时间值即可，不重复调用 LLM。无明细但有工时生成确定性的“已记录工时，未记录工作内容”；没有任何活动生成 empty 结果，两者均不调用 LLM。

### 调度与周期

建议固定每小时执行一轮检查，间隔可配置；一轮未结束时不并行启动第二轮。检查按数据库候选分组分页，遍历整个候选集合，不设置只看近一天或近几天的正确性窗口。

服务启动只建立定时器和 worker，不承担独立的摘要生成语义。服务运行期间每天多轮执行同一检查；停用期间无法执行，恢复运行后下一轮正常检查自然发现遗漏。

周五记录尚未生成摘要，电脑一直关闭到周一：下一轮检查会发现该记录所属日期已经结束且没有摘要，于是生成。周六若有记录也同样处理，没有记录就没有工作内容需要总结。这套逻辑不判断周末或节假日。

持久队列负责执行恢复。即使对账已入队但生成前关机，下次 worker 仍能领取未完成项。过期租约可重新领取，不把重启前的 running 永久视为正在执行。

第一版使用有索引、分页的完整候选对账保证正确性。数据量增长后可以增加“源写入事务标记受影响日期”的增量索引来加速，但必须覆盖日志增改删、日期调整、Focus、会议、工时修订、导入等入口，不能用只监听 UI 或 SSE 的方式替代正确性检查。

### 生成过程

1. 数据库唯一约束合并同一 Task 日期的重复请求；worker 用事务领取有期限的 lease。
2. 抓取该日证据快照，记录 inputFingerprint 和 requestedFingerprint。
3. 无活动、只有计时的情况走确定性结果；有内容时调用独立的 TaskDailySummary 提示词。
4. 输出一至三句中文，描述当天做了什么、得到什么结果、仍有什么阻碍；保留 entry ID 引用。
5. 日志是待总结的数据，不执行其中的指令；没有证据的完成结论不能添加，Task 整体完成状态也不由摘要改变。
6. 校验结构、引用 ID、截断及结果长度；保存前再次计算当前输入指纹并核对 lease。
7. 如果输入已变化，丢弃旧结果、合并为最新请求；不能让慢请求覆盖新明细。
8. 原子写入摘要及 generation，完成任务并发出更新事件；失败保留旧摘要和错误信息。

建议初始参数：并发 1，最多 3 次自动重试，退避 1 分钟、5 分钟、30 分钟；遵守供应商 Retry-After。同一指纹重试耗尽后，周期轮询不重置次数；新指纹或用户显式重试才重置。提供独立输出 token 上限、输入上限和每天调用预算，复用现有模型连接配置。具体预算先作为设置值，不假定现有 1200 token 对所有模型都足够。

超长明细必须按条目分块后合并，引用贯穿分块；不能静默只取最近若干条。重试和分块都计入调用预算。模型未配置或预算耗尽时保留任务为 waiting_config 或 waiting_budget。

已验证的分块结果持久化到 task_daily_summary_chunks。后续轮次先恢复检查点，再继续尚未完成的模型调用；每日预算为 1 时也能逐日完成整个摘要。分块键包含实际输入、提示词、模型连接与 token 设置，源指纹变化即清理旧检查点。慢请求写检查点前再次校验数据库连接、租约和源指纹，旧来源结果不能污染新任务。

当前日期即使被手动请求，也不生成摘要。跨过日起点后，它才成为可总结的历史日期。轮询期间补录、更正或删除更早日期的明细，会在下一轮对账中刷新那个日期的摘要。

### 每日任务摘要设置

Settings → AI 提供独立的“每日任务摘要 / Task Daily Summary”子页，与现有 Task Summary、Daily Summary 并列。沿用 Provider 的连接、模型、API Key 和超时，不引入第二套凭据。该页提供独立的提示词编辑、恢复默认、输出 Token 上限（默认 1200，可调整为 16–32000）、历史日期试跑和 `task_daily_summary` 调用记录。

调度设置包含启停（默认开启）、检查周期（默认 60 分钟）、每次调用输入字符上限（默认 24000）、每日调用预算（默认 100，0 暂停模型调用）。第一版并发为 1。日期起点从 Focus 配置读取并展示；试跑的可选日期以上一已结束工作日为上限，服务端再次校验。试跑使用当前编辑的提示词和 Token 上限，仅记录模型调用，不写入或替换每日摘要，不创建队列任务。

设置保存不执行当日生成。测试和后台执行都使用同一证据约束、结构校验、超时和供应商 Retry-After；失败在对应子页和调用记录中可查看。

## 七 API 契约

接口按新模块组织，时间戳为 Unix 毫秒，日期为 YYYY-MM-DD。以下为已实现的新增契约。

| 方法和路径 | 用途 |
| --- | --- |
| GET /api/work-outlines/default | 获取默认大纲的权威文档、ID、epoch 和 revision |
| PUT /api/work-outlines/:id | 保存完整文档，校验 expectedEpoch 与 expectedRevision |
| POST /api/work-outlines/:id/rows/:rowId/task | 原子创建 Task 并关联到指定条目 |
| POST /api/task-days/query | 批量查询多个 Task 的累计工时和日期格 |
| GET /api/tasks/:taskId/days/:date | 查询该日完整摘要、证据和计时区间，证据支持 cursor 分页 |
| POST /api/tasks/:taskId/days/:date/summary-refresh | 显式要求历史日期重新对账和排队，不同步调用模型 |
| POST /api/tasks/:taskId/days/:date/summary-test | 使用可选 prompt/maxTokens 试跑历史日期；只保存调用记录，不写每日摘要或队列 |
| GET /api/task-daily-summary-jobs | 查询队列和错误状态 |
| GET 和 PUT /api/settings/task-daily-summary | 周期间隔、启停、提示词、token 上限、并发和预算 |
| PUT /api/tasks/:taskId/logs/:entryId/work-date | 设置补录日志的明确归属日期；不改变 createdAt |

### 保存大纲

~~~json
{
  "expectedRevision": 12,
  "expectedEpoch": "database-epoch-uuid",
  "mutationId": "client-operation-uuid",
  "document": {
    "type": "doc",
    "schemaVersion": 1,
    "content": [
      {
        "type": "outlineLine",
        "attrs": { "id": "row-uuid", "depth": 0 },
        "content": [
          { "type": "text", "text": "接入 metrics " },
          { "type": "taskRef", "attrs": { "taskId": "T0000000123", "label": "接入 metrics" } }
        ]
      }
    ]
  }
}
~~~

成功返回 200，包含 id、epoch、revision、mutationId、updatedAt。任务 ID 和行 ID 示例仅表示字段形态。同一世代中重复 mutationId 且请求内容相同返回原结果，内容不同返回 409；跨世代请求返回 409 OUTLINE_EPOCH_CONFLICT。

### 原子创建并关联

~~~json
{
  "expectedRevision": 13,
  "expectedEpoch": "database-epoch-uuid",
  "idempotencyKey": "create-operation-uuid",
  "task": {
    "title": "接入 metrics",
    "type": "TODO",
    "priority": "MEDIUM",
    "tags": [],
    "body": ""
  }
}
~~~

成功返回 201：task、rowId、epoch、outlineRevision、bindingPatch、updatedAt。幂等重试返回同一 Task 和同一结果。创建不隐式开始计时。已有 Task 的关联直接通过编辑器插入引用并保存文档，不调用新建接口。

### 批量日期查询

~~~json
{
  "taskIds": ["T0000000123", "T0000000456"],
  "fromDate": "2026-10-02",
  "toDate": "2026-10-15",
  "includeTotals": true
}
~~~

响应结构：

~~~ts
type TaskDaysResponse = {
  calendar: {
    policyId: string;
    timeZone: string;
    startOfDayHour: number;
    currentWorkDate: string;
    lastClosedWorkDate: string;
  };
  asOf: number;
  columns: Array<{ date: string; start: number; end: number; isCurrent: boolean }>;
  tasks: Array<{ taskId: string; status: string; totalRecordedMs: number; running: boolean }>;
  cells: Array<{
    taskId: string;
    date: string;
    recordedMs: number;
    running: boolean;
    summary:
      | { availability: "not_applicable"; reason: "date_not_closed" }
      | {
          availability: "historical";
          text: string | null;
          kind: "llm" | "time_only" | "empty" | null;
          freshness: "missing" | "fresh" | "stale";
          jobState: "idle" | "queued" | "running" | "failed" | "waiting_config" | "waiting_budget";
          generation: number | null;
          generatedAt: number | null;
        };
  }>;
};
~~~

规则：

- Task IDs 去重，建议单次最多 100 个 Task、31 个日期列，大窗口按 Task 集合和日期范围分块；网格不逐格发请求。
- 当前日期无论缓存里是否存在旧结果，都返回 not_applicable，不返回 summary text、证据摘录或模型生成入口。
- 工时使用同一个服务端 asOf，当前格和累计列口径一致；真实零工时返回 0，查询失败返回错误，不伪装为 0。
- 可返回稀疏 cells；已确认查询范围内缺失的格子表示没有活动，不能表示请求未完成。有证据但尚未生成摘要时仍返回 missing cell。
- 大纲处于未保存编辑时，客户端按当前文档里的 Task IDs 查询，因此新引用可以立即显示已有日数据。
- 查询只读取数据；定时任务负责常规生成。历史格的显式刷新在摘要已匹配时返回 200 fresh/no-op；缺失或变化时返回 202 和 jobId，复用已有排队项。
- 页面可在有计时运行时每 30 秒批量刷新当前工时，状态事件或重新获得焦点时立即刷新。
- 跨越日起点时重新查询 calendar 和可见日期，前一列转为历史待生成，当天列重新计时。

### 错误和事件

| 状态码和错误码 | 含义 |
| --- | --- |
| 409 OUTLINE_REVISION_CONFLICT | 保留本地内容，进入版本冲突处理 |
| 409 OUTLINE_ROW_MISSING | 创建目标行已不存在；不创建 Task |
| 409 OUTLINE_ROW_ALREADY_LINKED | 创建目标行已经关联另一个 Task |
| 409 IDEMPOTENCY_KEY_REUSED | 同一幂等键被用于不同请求 |
| 422 INVALID_OUTLINE_DOCUMENT | 行结构、层级或引用不合法 |
| 422 TASK_NOT_FOUND | 引用对象不存在 |
| 422 DATE_NOT_CLOSED | 请求生成当天或未来日期摘要 |
| 422 QUERY_RANGE_TOO_LARGE | 请求需按 Task 或日期拆分 |

复用现有 SSE，新增 outline_updated 和 task_daily_summary_updated；消息仅携带对象 ID、日期、policyId 和 revision/generation，用于失效缓存。自己的写入用响应更新，其他来源用 SSE 提示。SSE 没有持久重放能力，断连恢复后重查可见范围；后台队列不能依赖 SSE 可靠投递。

## 八 实施顺序与验收

| 阶段 | 交付 | 依赖和验收重点 |
| --- | --- | --- |
| 1 文档与保存 | OutlineDocument、专用编辑器、行身份、保存 API | 深层缩进、整支移动、复制剪切、Undo、IME、断网恢复、409 不丢字 |
| 2 Task 交互 | @ 菜单、原子创建关联、右侧详情 | 焦点范围正确；双击和重试只创建一个 Task；移动后仍回填正确行；完成状态实时弱化 |
| 3 日期表与工时 | 共享行布局、累计列、历史格占位、当前工时 | 多处引用复用数据；未关联行留空；跨日 session 正确切分；只移动大纲不改变历史数据 |
| 4 摘要数据与后台 | 独立实体、明细日期元数据、周期对账、持久队列 | 缺失生成、修改刷新、删除清理、输入没变零 LLM 调用、期间变更拒绝旧结果 |
| 5 联调与回归 | SSE、设置、错误提示、来源展开 | 服务关闭多天后下一周期覆盖旧数据；周末有记录照常处理；当天始终无摘要 |

必须覆盖的端到端场景：

1. 左侧输入或移动时，右侧行立即对应；保存返回不覆盖后续输入。
2. 焦点在左侧按 Ctrl+Enter，不提交右侧任何内容；创建表单中的 Ctrl+Enter 创建并回填；日志编辑区中的同键仅提交日志。
3. 父 Task 完成，纯文本子孙弱化，仍进行中的子 Task 及其普通后代保持正常。
4. 无 Task 父行的所有后代 Task 完成后弱化；父行自己有未完成 Task 时不弱化。
5. 删除和 Undo 大纲行不删除 Task、日志、session 或日摘要。
6. 同一 Task 多处出现只生成一份日摘要；行移动或改写普通标题不触发模型。
7. 历史日志新增、改写、删空、改归属日期，下一周期处理全部受影响日期。
8. 周五数据周一才可处理、周末新增数据、关闭数周、期间多个任务失败，均由同一候选对账与持久队列规则处理。
9. 已结束日期摘要输入完全相同，连续多个周期不会重复调用模型。
10. 摘要运行中明细改变或 worker 租约被回收，旧结果不能覆盖新版本。
11. 当天包括手动刷新接口都不能产出摘要；日起点切换后才获得生成资格。
12. 更改时区或日起点后按新 policy 重新对账，旧口径数据不混入新查询。

实施验证以服务测试、编辑器交互测试及 WebKit 端到端为主；最后覆盖 Notes、Focus、任务详情原有快捷键和保存流程，避免共享组件回归。

## 九 现有实现的复用边界

| 当前代码 | 可复用或需调整的内容 |
| --- | --- |
| web/src/components/DayScriptEditor.tsx | JSON 编辑、Task 引用、点击处理；不复用 Focus 的时间语法和全局提交副作用 |
| web/src/pages/NotesPage.tsx 和 server/src/services/noteService.ts | 串行自动保存、恢复副本、revision 冲突处理 |
| web/src/components/TaskDetailWorkspace/index.tsx | 详情、日志、完成后保持显示；需收紧焦点和快捷键范围 |
| web/src/shortcuts/registry.ts | 当前 ctrl/cmd/mod 合并，需要明确真实按键语义 |
| server/src/services/recordedWorkService.ts | 按区间裁剪已记录工时 |
| server/src/services/taskService.ts | 创建与日志服务；补日期、修订元数据并复用事务能力 |
| server/src/services/meetingService.ts | 会议补录有真实区间，是历史工时和内容的重要入口 |
| server/src/services/taskContextService.ts | 当前 Task Summary 是最新进展，不能充当每日摘要 |
| server/src/services/dayScriptLlmService.ts | 现有 Daily Summary 按整天汇总，不能直接作为 Task 日期实体；可复用调用与输入指纹经验 |
| server/src/services/backgroundTaskService.ts | 当前仅持久化运行结果，缺 queued、租约及恢复执行队列；扩展展示类型 task_daily_summary，另建执行队列 |
| server/src/services/eventBus.ts | 可复用刷新通知，不作为后台任务可靠消息源 |

建议新增模块：shared/workOutlineTypes.ts、shared/taskDailySummaryTypes.ts、OutlineEditor、WorkOutlinePage、TaskDayGrid、TaskSidePanel，以及对应的 schema、route、outlineService、taskDailySourceService、taskDailySummaryService、taskDailySummaryWorker、calendarService。接口薄层和核心日期计算、输入构建、弱化推导保持可独立测试。

## 十 甘特视图扩展

当前表格已具备任务层级和日期轴，是实际工作的时间表。之后可在同一行数据上切换“摘要格”与“工时色块”呈现，保留没有记录的日期空档。

计划型甘特图还需要计划开始、截止日期和依赖关系，这些是额外数据。第一版不把两个有工时的日期之间全部涂满，也不从实际工时推断计划或完成百分比。

## 十一 快捷键排查与新页面约定

已逐项检查集中 registry、App 导航/全局监听、Board、Notes、Focus/DayScriptEditor、RichEditor、TaskDetailWorkspace、Report、Projects、查找框、选择器和图片弹层的局部键盘处理。

| 既有范围 | 风格与按键 | 新功能处理 |
| --- | --- | --- |
| App 导航 | Mod+数字按侧栏可见顺序；Mod+Shift+F 全局搜索；Mod+Shift+N 新笔记 | 工作大纲在第 4 位：Board 1、Today 2、Notes 3、工作大纲 4、Report 5、方向与里程碑 6、Settings 7；提示、ARIA 与实际绑定一致 |
| App 会话 | Mod+Q AFK；Mod+R 刷新；Mod+W 防止关窗；Mod+加减号缩放 | 沿用，不重复占用 |
| Board | Mod+N 新任务；Mod+T Today；Mod+Shift+T 接管；Mod+Shift+S 开始；Mod+Shift+D 完成；方向键选任务 | 嵌入详情仅焦点在详情区时使用任务快捷键 |
| Board 新任务 | Mod+Shift+A/S/D 优先级；Mod+Enter 创建 | 新表单遵循用户指定的真实 Ctrl+Enter，页面不新增全局提交动作 |
| Notes | Mod+S 保存；Mod+N 新笔记；Mod+F 查找；上下键切换；编辑区 Esc | 大纲 Mod+S 即时保存，保留文本选区与编辑习惯 |
| Focus 编辑器 | Enter 分行；Tab/Shift+Tab 层级；@ 菜单；Ctrl+Enter 提交 Focus | 大纲 Tab 专用于层级，@ 使用上下/Enter/Esc，不沿用其 Tab 选中 |
| Today 全局 next steps 列表 | j/k 光标、i 加入 Focus、o/Enter 打开、gg/G 首尾、Ctrl+u/d 翻页、x 隐藏、q 关闭；输入框不处理 | 大纲保留普通文字输入，不把这些字符绑定为业务动作 |
| 富文本 | Mod+S 草稿；Ctrl+Enter 日志；格式化、Undo/Redo；组合输入保护 | 新大纲只有自动保存，Ctrl+Enter 在左侧不提交任何业务数据 |
| Report/Projects/浮层 | Mod+R/Mod+F 页面行为；Esc 关闭最近浮层；选择器上下/Enter | 新详情 Esc 关闭返回原行，避免吞掉 @ 菜单与 IME 操作 |

当前 registry 把 ctrl/cmd 都作为 mod 别名；本次不全局改变旧页面语义。新创建/详情的真实 Ctrl+Enter 在焦点范围内处理。快捷键的副作用必须受所在编辑器/面板限制，特别防止左侧输入触发右侧日志提交、开始计时或完成 Task。
