# Chronicle 富文本编辑器：需求整理与改造方案

> 状态：阶段 1–4 已实现，阶段 5–6 未做（实际执行结果见第 10 节）
> 日期：2026-08-06（计划）／ 2026-08-20（执行结果更新）
> 方法：本文的需求全部来自 `git log` 的 commit message 与 diff，不引用任何产品规划文档。

---

## 1. 目标

Chronicle 目前有两个 TipTap 编辑器实现：

- `web/src/components/RichEditor/index.tsx` —— 任务日志条目、笔记正文、会议纪要等通用富文本编辑器
- `web/src/components/DayScriptEditor.tsx` —— Today「focus / day script」专用编辑器

两者在列表、链接、代码块、Tab、方向键等行为上各自实现、逐步漂移，并叠加了大量「窄补丁」。本文的目标是：

1. 从 git 历史中还原出编辑器的**真实需求**；
2. 把这些需求与当前代码状态（含未提交的 WIP）对照，找出病态机制的根因；
3. 给出一个**分阶段、可回退**的改造方案，在不牺牲任何历史需求的前提下收敛实现。

---

## 2. 需求清单（来源：git log）

每条需求都标注了来源 commit，保证可追溯。

### A. 通用富文本（RichEditor）

| 编号 | 需求 | 来源 commit |
|------|------|-------------|
| A1 | 支持 bold/italic/strike/H1–H4/code/blockquote/有序+无序列表/链接 | `28ee9c8` `5a25e68` |
| A2 | 代码块要有「软换行」开关（↵ 按钮） | `7e07709` |
| A3 | 输入 `````` 回车可转成代码块 | `c9182bf` `66f6318` |
| A4 | 图片粘贴/拖拽/插入，默认宽 500、可拖拽改尺寸、存文件引用而非 base64 | `d5f927e` `5ca437c` `6b9ba4d` |
| A5 | 非图片文件拖入 → 存磁盘 → 插入 📎 链接，点击在 Finder 中显示 | `1e4027f` `59e8c56` |
| A6 | `@标题` 任务提及（带 task-id 链接 + 自动补全 + 点击跳转） | `6b9ba4d` 及后续 mention 改动 |
| A7 | 链接 XSS 防护：拒绝 `javascript:` / `vbscript:` | `91e20ec` |
| A8 | 列表「缩进 / 取消缩进」（Tab/Shift-Tab + 工具栏按钮） | `5a25e68` |
| A9 | **Tab 不能把焦点移出编辑器**（"fix Tab focus"） | `5a25e68` |
| A10 | **编辑器内容不能跨编辑器 / 跨任务泄漏** | `59e8c56` `3fcd351` |
| A11 | 剪贴板图片粘贴 → 上传插入 | `55c20f4` `59e8c56` |
| A12 | 编辑器内 Cmd+S=保存 / Escape=取消 / Ctrl+Enter=提交 | `e222263` |

### B. 任务日志条目编辑器（TaskEntryBlock）

| 编号 | 需求 | 来源 commit |
|------|------|-------------|
| B1 | 两种模式：新条目（compose）/ 编辑已有条目 | `cbc3f4f` |
| B2 | 草稿按 task+entry 持久化到 localStorage，保存/取消时清理 | `cbc3f4f` |
| B3 | 30s 静默自动保存 + 双写（localStorage + DB） | `cbc3f4f` `e3134b8` `55c20f4` |
| B4 | 「首次有意义编辑」检测 → 触发自动接管（开始 session） | `3fcd351` |
| B5 | 条目删除需两步确认 | `d5c77fa` |
| B6 | 条目可置顶（pin）/ 加入笔记（选区工具栏） | `6fd41ac` `fbce848` |
| B7 | 日志只读态要高亮搜索词 + 代码块 wrap 按钮 + 列表标记 | `287b723` `7e07709` `b5f78c1` |
| B8 | 空内容判定：含图片视为非空 | `91f7b55` `cbc3f4f` |
| B9 | ~~Plan item 的 Start/Complete/Skip/Revert~~（已移除） | `3268e83` `8c6a5f3` → `71dc2a9` |

### C. Focus / Day Script 编辑器（DayScriptEditor）

| 编号 | 需求 | 来源 commit |
|------|------|-------------|
| C1 | 独立、text-first 的轻量编辑器（时间块行） | `5bdbba1` `80d8805` |
| C2 | `HH:mm-HH:mm` 行头 → 时间块；后续行归属该块 | `5bdbba1` |
| C3 | `@` 自动补全（PENDING/DOING），插入 `@标题` 链接；点击跳转但编辑不跳 | `5bdbba1` `80d8805` |
| C4 | `✅` 标记块完成 | `5bdbba1` |
| C5 | 当前块高亮 + 倒计时 | `5bdbba1` |
| C6 | Cmd+S 保存 + 进度同步（幂等、append-only、编辑冲突需确认） | `5bdbba1` `92c52d1` |
| C7 | 前一天未完成块「结转」（origin_* 属性、重挂） | `6189669` `8c6a5f3` |
| C8 | 无 `@task` 的行 → 新建任务（NewTaskBadge、行头识别） | `3936654` |
| C9 | 选中多行 Cmd+Shift+R → 重排块 | `6beaea1` |
| C10 | 进度日志保留富文本（非纯文本） | `80d8805` |
| C11 | Home/End 定位文本块首末；方向键跨 `hr` 分隔线 | `ce0792e` |
| C12 | 方向键能移出代码块 | `bfba14c` `c9182bf` |
| C13 | **链接结尾按 Enter 要继续列表**（不产生空段落） | `e9e5ccd` → `f2b105d` → WIP |
| C14 | markdown 换行 / 代码块保真 | `c9182bf` |
| C15 | 文档加载时 sanitize + blockId 属性稳定 | `91f7b55` `6189669` |

### D. 笔记 / 置顶 / 搜索

| 编号 | 需求 | 来源 commit |
|------|------|-------------|
| D1 | 笔记工作区：富文本 + 自动保存 + 标题编辑 | `fbce848` |
| D2 | 从任务条目「加入笔记」（追加 HTML） | `fbce848` |
| D3 | 置顶区：pin/unpin/编辑/折叠 | `6fd41ac` |
| D4 | 搜索词在编辑器正文高亮 | `287b723` `dd8fec0` |
| D5 | FindBar（Cmd+F）内容高亮 + 当前匹配序号（ProseMirror 插件） | `f3d16f9` |
| D6 | 统一搜索 + 中文分词（jieba） | `f3d16f9` |

### E. 跨切面

| 编号 | 需求 | 来源 commit |
|------|------|-------------|
| E1 | 关闭系统自动纠错 / 自动大写（中文输入场景） | `f3d16f9` |
| E2 | 集中式快捷键注册表，作用域优先级 component>page>app>global；mod 组合键在输入框里也要生效（故无全局 isInput 检查） | `d7941f6` |
| E3 | 条目/Session 变更通过 SSE 实时反映 | `80540f8` |
| E4 | 附件在提交前需预留任务 ID | `59e8c56` |

---

## 3. 根因映射（需求 → 病态机制）

核心结论：**每个「不合理机制」背后都压着一个真实需求，它们由 agent 在历次 feature 里用「窄补丁」逐个叠加，且每个补丁都比需要的「更宽」。**

| 病态机制 | 压住的需求 | 来源 commit |
|---|---|---|
| 全局吞 Tab（`preventDefault` + sink/lift，无条件 `return true`） | A8 列表缩进 + A9 Tab 不逃焦 | `5a25e68` |
| 代码块 NodeView 里的可聚焦 ↵ 按钮（无 `tabindex=-1`） | A2 软换行开关 | `7e07709` |
| 代码块 ArrowUp/Down 覆盖 | C12 方向键出代码块 | `bfba14c` |
| Home/End + 跨 `hr` 方向键覆盖 | C11 焦点导航 | `ce0792e` |
| `splitAfterLink` → `splitListItemOnEnter` → Backspace 拦截 | C13 链接后 Enter 续列表 | `e9e5ccd` → `f2b105d` → WIP |
| `ChronicleListItem` 非标准 content model（`codeBlock block* | (list)+`） | 粘贴嵌套列表不要空段落 | `66f6318` |
| `priority:1000` 代码栅栏 + 列表拦截 | A3 `````` 转代码块 + C13 | `66f6318` + WIP |
| `textCorrectionPolicy` 连拼写检查一起关 | E1 关系统纠错 | `f3d16f9` |
| 全局 dispatcher 无 isInput 检查（capture 阶段） | E2 mod 组合键输入框内生效 | `d7941f6` |
| `notifyCursorTask` 每次选区变化都触发 `setActiveTask`（副作用化导航） | C3 点击任务链接跳转 | 实测竞态（见阶段 4） |

---

## 4. 当前代码状态（HEAD vs WIP）

- **HEAD**：`b5f78c1`（`fix: keep code-block list markers visible`）
- **未提交的 WIP（工作区）**：
  - `web/src/components/RichEditor/ChronicleListItem.ts`（+138 行）——新增 `ChronicleListEditing` 扩展（code-list-marker 装饰、Backspace/Enter 拦截、`splitListItemAfterTrailingLink`）
  - `web/src/lib/proseHtml.ts`（**未跟踪新文件**）——`withCodeFirstListMarkers`
  - 其余被改动的编辑器文件：`DayScriptEditor.tsx`、`RichEditor/index.tsx`、`PinnedSection`、`TaskEntryBlock`、`MeetingExtractionDialog`、`App.tsx`、`styles/prose-display.css`、`tests/focus-rich-meeting.test.ts`

关键判断：WIP 正把列表逻辑从 DayScriptEditor 抽到共享层，方向是对的，但**抽的是「已经跑偏的逻辑」**，没有修根因。

---

## 5. 设计原则

1. **不牺牲任何需求**（尤其 A9 Tab 不逃焦、A2 软换行、C12/C13 导航、C7 结转、E1 中文输入、E2 mod 组合键）。
2. **优先消除「过宽」的拦截**：凡 `preventDefault` + 无条件 `return true` 的地方，改成「上下文精确 + 命中才处理」。
3. **恢复 TipTap 默认 content model**，把「粘贴嵌套列表不空段落」从改 schema 改成**粘贴规范化**。
4. **一个共享编辑内核 + 两个薄配置**，消灭两套实现漂移。

---

## 6. 改造方案（分阶段，按风险从低到高）

### 阶段 0：WIP 去留决策

- 保留 WIP「抽共享层」这个**方向**。
- **不保留** `priority:1000` 的 Enter/Backspace 拦截，以及 code-list-marker 那套视觉补丁（它们是症状的产物，而非需求本身）。
- 明确：本轮目标是修根因，不是继续把补丁搬来搬去。

### 阶段 1：修最痛的两个 UX bug（低风险）

1. **统一 Tab 处理**：
   - 移除 RichEditor 的全局吞 Tab，改为**上下文感知但始终保持焦点不逃逸**：
     - 在列表项内 → `sinkListItem` / `liftListItem`
     - 在代码块内 → 复用 TipTap `CodeBlock` 内置的 `enableTabIndentation`（默认 `tabSize: 4` 空格缩进），而非自写 `insertTab`
     - 其他位置 → 仍然 `preventDefault` 吞掉（保住 A9，行为与现状一致）
   - DayScriptEditor 接入同一份 Tab 逻辑（消除两处不一致，同时补上它目前缺失的焦点约束）。
2. **wrap 按钮移出焦点链**：NodeView 与展示态 `withCodeBlockWrapButtons` 两处都给按钮加 `tabindex="-1"` + `contenteditable="false"`。

### 阶段 2：修 content model 根因（中风险，解决 Backspace 减缩进）

1. 恢复 `ChronicleListItem` 为 `paragraph block*`（TipTap 默认）。
2. 用**粘贴规范化**满足「粘贴嵌套列表不要空段落」：在 `handlePaste` / `parseHTML` 里，把粘贴进来的「codeBlock 开头 / 纯嵌套列表」的列表项，规范化为「段落 + codeBlock/嵌套列表」，而不是放宽 schema。
3. A3 在列表里 `````` 回车也生成「段落 + codeBlock」形态，而非 codeBlock-first。
4. 撤掉 code-list-marker 视觉补丁（content model 恢复后 WebKit 裁标记问题应自然消失，若残留则退化为纯 CSS 问题单独处理）。

### 阶段 3：消除 priority-1000 与 Enter/Backspace 拦截（中风险）

1. `````` → 代码块（A3）改成 **input rule** 或「光标在段落末尾且匹配栅栏时」的精确 handler，不再占用 `priority:1000` 抢跑所有 Enter。
2. 链接后 Enter 续列表（C13）：移除 Focus 专属 `splitListItemOnEnter` / `deleteEmptyListPlaceholder`，让 TipTap 默认 `splitListItem` 接管（Link 的 `keepOnSplit:false` 已保证链接 mark 不延续）。
3. `ChronicleListEditing` 里剩余的精确 handler 降级为普通 command，不再作为 keyboard shortcut 抢占。

### 阶段 4：收敛两套编辑器为共享内核（结构性重构）

1. 抽 `createEditorExtensions()` 工厂，统一产出：修复后的 `ChronicleListItem`、`WrappedCodeBlock`、链接扩展、代码栅栏 input rule、搜索高亮插件。
2. `RichEditor` = 共享内核 + 工具栏 + 附件/图片/mention。
3. `DayScriptEditor` = 共享内核 + 仅它独有的 `DayScriptParagraph` / `NewTaskBadge` / `FocusLineDecorations` + 焦点专属键盘（Home/End、跨 `hr` 导航、mention 的 capture 监听收敛到编辑器 `handleKeyDown` 一处）。
4. 去掉 DayScriptEditor 里重复的 `document capture` mention 监听（`stopPropagation` 抢占）。
5. **收敛 `notifyCursorTask` 的副作用化导航**：现在它每次选区变化（包括仅仅点击落光标）都调 `onNavigateTask` → `setActiveTask`，触发异步 fetch + 详情面板重渲染 + 会话同步，与紧随其后的编辑按键赛跑。

> **驱动证据（实测，2026-08-06）**：`tests/focus-rich-meeting.test.ts` 里 `inline list fence preserves Focus task-link marks` 偶发失败，根因即此——测试点击含任务链接的段落后立即 `End`+`Enter`，与 `notifyCursorTask` 触发的异步重渲染赛跑，导致光标未停在段落末尾、`turnTrailingFenceIntoCodeBlock` 不匹配（栅栏不转换）或 split 走样（链接 mark 丢失）。两次全量跑失败断言不同（一次链接丢、一次栅栏不转），且单独跑通过，确认是竞态而非确定性 bug；与阶段 1 的 Tab/按钮改动无关。修复方向：`notifyCursorTask` 去抖/仅在真正导航时触发，测试补「编辑器稳定」等待。

### 阶段 5：全局键盘与文本策略的边界收紧（低风险，需回归）

1. 全局 dispatcher 增加「焦点在编辑器/输入框内」的守卫，**保留 E2**（mod 组合键仍在输入框内生效），但阻止无 mod 的 page/component 快捷键在编辑器里偷键。
2. `textCorrectionPolicy`：保留 `autocorrect/autocapitalize off`（E1），把 `spellcheck` 从强制 false 改为可配置或至少不全局覆盖。

### 阶段 6：回归护栏（贯穿全程）

针对历史需求逐条补 Playwright 用例（见第 8 节）。

---

## 7. 仅落地阶段 0+1 的影响分析

**结论：不会破坏现有功能，风险低；前提是阶段 1 采用「上下文感知但始终保持焦点不逃逸」的实现方式。**

### 7.1 Tab 处理（阶段 1.1）

当前 RichEditor 的 Tab 行为：

```ts
if (event.key === 'Tab') {
  event.preventDefault()
  event.shiftKey ? liftListItem : sinkListItem
  return true
}
```

即：**所有位置都吞 Tab，并盲目尝试列表缩进**（非列表处什么都不发生）。

改造后：

| 光标位置 | 现状 | 改造后 | 是否回归 |
|---|---|---|---|
| 列表项内 | 缩进/反缩进 | 缩进/反缩进 | 否（不变） |
| 代码块内 | 吞掉、无反应 | 插入制表符 | 否（净改善） |
| 普通段落/标题 | 吞掉、无反应（焦点留在编辑器） | 仍吞掉（焦点留在编辑器） | 否（不变） |

关键点：
- **A9（Tab 不逃焦）必须继续靠 `preventDefault` 保住**。若为了「放行非列表 Tab」而改回默认，会**重新引入 `5a25e68` 修掉的那个焦点逃逸 bug**。所以正确做法是「全局 `preventDefault`，按上下文路由到 sink/lift/代码块缩进」。
- DayScriptEditor 目前**没有** Tab 处理，Tab 在普通段落会直接逃焦、在代码块会跳到 wrap 按钮。接入统一逻辑后是**补漏而非回归**。

需要小心的唯一点：**Tab 的上下文判定必须精确**——区分「光标在代码块内」和「光标在包含代码块的列表项内」；若判定错，会把「该缩进列表」和「该插制表符」搞反。这一条用单元/Playwright 用例钉死即可。

### 7.2 wrap 按钮移出焦点链（阶段 1.2）

- 仅加 `tabindex="-1"` + `contenteditable="false"`。
- 鼠标点击切换软换行**完全不受影响**（tabindex 不影响 click）。
- `aria-label` 已保留，可访问性不退化。
- 属于纯粹的「移除意外焦点目标」，无功能损失。

### 7.3 明确不触碰的部分（本阶段零改动）

- 列表缩进/反缩进、Cmd+S / Escape / Ctrl+Enter（A8、A12）
- 草稿持久化 / 静默保存 / 首次编辑接管（B2/B3/B4）
- 粘贴 / 图片 / 附件 / 提及 / 链接 XSS（A4–A7、A11）
- 搜索高亮 / FindBar / 中文分词（D4–D6）
- content model、Enter/Backspace 拦截（留到阶段 2/3，本阶段不动）

### 7.4 风险小结

| 风险 | 等级 | 缓解 |
|---|---|---|
| Tab 上下文判定错误 | 中 | 精确 `$from` 判定 + 用例钉死 |
| 误删 A9 的 `preventDefault` 导致焦点逃逸回归 | 中 | 实现时坚持「全局 preventDefault」 |
| 按钮 tabindex 影响点击 | 极低 | click 不受 tabindex 影响，用例验证 |

---

## 8. 测试方案

### 8.1 测试基架（现状）

- Playwright e2e 是唯一自动化手段（仓库无 web 单元测试框架）。`playwright.config.ts` 已配好隔离环境：固定端口 `18182`/`18183`、临时 DB `/private/tmp/chronicle-playwright-data`（跑前清空）、`workers:1`、跑前自动 `npm run build` server。
- Web 构建产物输出到 `server/public`（`web/vite.config.ts` 的 `outDir`），server 直接伺服它；改 web 后需先 `(cd web && ../scripts/with-node.sh npm run build)` 再跑测试。
- 现有测试已用 `page.keyboard.type/press` 驱动 TipTap 真实键盘行为，并断言最终 DOM 结构（`ol > li`、`ol > li > pre > code`、`.code-block-wrap-toggle` 等）。

### 8.2 浏览器选择：WebKit

- 仓库默认 Playwright 跑 Chromium，但用户实际环境是 Tauri（WebKit）。WebKit 恰是问题重灾区（裁 code-first 列表标记、Tab 焦点、输入法）。
- 阶段 1 目标测试通过 `test.use({ browserName: 'webkit' })` 指定 WebKit（`webkit-2287` 已安装，无需额外 install）。
- 后续可评估为整套 editor 用例加 WebKit project。

### 8.3 关键发现（影响测试断言）

- TipTap `@tiptap/extension-code-block` 内置 Tab 缩进：`enableTabIndentation: false`（默认关闭）、`tabSize: 4`。阶段 1 改为 `enableTabIndentation: true`，因此断言「代码块内按 Tab 后文本以 4 空格开头」。
- **`toHaveText` 会做 whitespace 归一化（trim 前导空格）**：用 `toHaveText('    const x = 1')` 断言缩进会「假绿」（前导空格被抹掉）。必须读 `locator.textContent()` 后 `expect().toBe()` 做精确比较。
- **WebKit 下 Playwright 合成 `Tab` 不触发浏览器原生焦点遍历**：因此「Tab 跳 wrap 按钮」的行为断言是弱烟测（假绿）。可靠护栏是 `tabindex="-1"` 的静态断言。

### 8.4 编辑器目标测试（`tests/editor-tab-list.test.ts`，WebKit）

> 下表是最初阶段 1 的 5 个目标用例；后续在修复过程中补充到 10 个（Cmd+A、Enter 换行、三连 Enter、ArrowUp/ArrowDown 等），最终状态见第 10.3 节。

| 用例 | 目标行为 | 当前状态（修复前） |
|------|----------|--------------------|
| Tab inside a code block indents the code（task log） | 代码块内 Tab 插入 4 空格缩进 | 红（Tab 被吞，无缩进） |
| Tab inside a code block indents the code（focus） | 同上 | 红（Tab 逃焦/跳按钮，无缩进） |
| Tab inside a code block does not move focus to the wrap button | Tab 后焦点仍在编辑器 | 绿（弱烟测，不作主要护栏，见 8.7） |
| code block wrap button is excluded from the tab order | 按钮 `tabindex="-1"` + `contenteditable="false"` | 红（按钮无这两属性） |
| Tab and Shift+Tab indent and outdent list items | 列表内 Tab/Shift+Tab 缩进/反缩进 | 绿（回归护栏） |

### 8.5 回归套件（每次改动后）

```bash
# 局部：新用例 + 最相关的既有用例
./scripts/with-node.sh npx playwright test tests/editor-tab-list.test.ts
./scripts/with-node.sh npx playwright test tests/focus-rich-meeting.test.ts

# 全量
./scripts/with-node.sh npx playwright test

# 构建校验
(cd web && ../scripts/with-node.sh npm run build)
(cd server && ../scripts/with-node.sh npm run build)

# 空白/格式
git diff --check
```

重点盯的既有用例：`focus-rich-meeting.test.ts`（列表/代码块/软换行/marker）、`notes.test.ts`、`pinned-content.test.ts`、`input-corrections.test.ts`、`cmd-s-draft-entry.test.ts`、`day-script.test.ts`、`search-findbar.test.ts`。

### 8.6 手动手感清单（主观「顺手」无法被结构断言覆盖）

1. 列表里连续回车、Backspace，缩进是否符合直觉。
2. 列表里插代码块后，Tab 缩进代码、光标不跑。
3. 代码块首/末行方向键能顺畅移出。
4. 链接结尾回车，列表序号/圆点续上。
5. 中文输入（拼音候选）不受系统纠错干扰。

### 8.7 已知限制

- 全量默认 Chromium；WebKit 特有行为（列表标记、Tab 焦点、输入法）必须在 Tauri dev 里复核。
- Playwright `keyboard.press('Tab')` 触发的 native 焦点遍历属 best-effort；`tabindex="-1"` 的静态断言是主要护栏，行为断言（`document.activeElement`）为辅助。

### 8.8 实际运行结果（2026-08-06，WebKit 已验证）

新增 `tests/editor-tab-list.test.ts` 已落地并跑通，WebKit 生效（error-context 中确认 `WebKit`）。修复断言（改用 `textContent()` 精确比较）后结果为 **3 红 / 2 绿**：

- 红：Tab 在代码块内缩进（task log / focus 两个编辑器）——对应「按 Tab 没有缩进」。
- 红：wrap 按钮 `tabindex="-1"` + `contenteditable="false"`——对应「Tab 跳到 wrap 按钮」。
- 绿：Tab/Shift+Tab 列表缩进/反缩进（回归护栏，需保持绿）。
- 绿：Tab 不移动焦点到 wrap 按钮（弱烟测，见 8.7，不作主要护栏）。

这 3 个红用例即阶段 1 的验收标准：实现阶段 1 后应转绿，2 个绿用例保持不变。

**阶段 1 已实现（2026-08-06）**：4 个文件改动——`WrappedCodeBlock`（启用 `enableTabIndentation` + 按钮加 `tabindex="-1"`/`contenteditable="false"`）、`TaskEntryBlock`（展示态按钮同样处理）、`RichEditor` 与 `DayScriptEditor`（Tab 路由改为「代码块放行给扩展、其余吞掉保焦点」）。当时 `tests/editor-tab-list.test.ts` 5/5 转绿；后续补充到 **10/10 全绿**（见第 10.3 节）。

---

## 9. 待决策问题

1. 阶段 0 是否同意「保留共享层方向、放弃 priority-1000 拦截与 code-list-marker」？
2. 阶段 2 的粘贴规范化是否接受「列表项必须以段落开头」的约束（即不再支持 codeBlock 作为列表项首子节点）？
3. 阶段 5 的 spellcheck：是彻底移除全局关闭、还是加设置项？
4. 是否先在阶段 1 落地后暂停，观察真实使用反馈再进入阶段 2？

---

## 10. 实际执行结果与对抗性 Code Review（2026-08-20）

> 本节是「执行后」的记录，取代上方阶段 1–6 的「计划」描述；两者有出入处以本节为准。

### 10.1 各阶段执行状态

| 阶段 | 状态 | 实际做法（与计划的出入） |
|---|---|---|
| 0 WIP 去留 | ✅ 完成 | 保留共享层方向；放弃 `priority:1000` 拦截与 code-list-marker |
| 1 Tab + wrap 按钮 | ✅ 完成 | 按钮用 `contenteditable="false"`（**未用** Decoration widget，更简单）；`enableTabIndentation: true`；**额外移除**了自定义 ArrowUp/ArrowDown 覆盖 |
| 2 content model | ✅ 完成 | 恢复 `paragraph block*`；fence 改为生成「段落+代码块」；`normalizeLegacyCodeFirstListItems`（加载 + 粘贴双向） |
| 3 消除拦截 | ✅ 完成 | 删 `insertNewlineInCodeBlock`（冗余 + 破坏 `exitOnTripleEnter`）；删冗余 link handler；删 code-list-marker 装饰 |
| 4 共享内核 | 🟡 部分 | 抽出 `createSharedEditorExtensions`；**`notifyCursorTask` 副作用收敛未做**（仅测试侧加等待） |
| 5 键盘/文本策略 | ❌ 未做 | 全局 dispatcher 守卫、spellcheck 可配置，均未动 |
| 6 回归护栏 | 🟡 部分 | 新增 WebKit editor 测试；全量 210/215 |

### 10.2 对抗性 Code Review 结论（4 个全新 context sub agent）

**发现并修复的真实问题：**

| 级别 | 问题 | 修复 |
|---|---|---|
| 🔴 H1 | `insertNewlineInCodeBlock` 冗余且破坏 `exitOnTripleEnter`（三连 Enter 不退出代码块） | 删除该函数；补三连 Enter 退出测试 |
| 🔴 H2 | `deleteEmptyListItemAfterTrailingLink` 用 `$from.index(listDepth)` 算错索引，可抛 `RangeError` 打断 Backspace | 连同冗余的 `splitListItemAfterTrailingLink` 一起删除（TipTap 默认行为已覆盖） |
| 🔴 H3 | `normalizeLegacyCodeFirstListItems` 首次挂载被跳过 → 旧 `<li><pre>` 数据首次打开仍损坏 | 在 `useEditor` 的 `content` 选项也规范化 |
| 🟠 M1 | 注释声称「粘贴时规范化」但无 paste 代码 | 两个编辑器加 `transformPastedHTML` |
| 🟠 M2 | JSON 规范化对空列表项不兜底 | 空/非段落首子节点都补段落 |
| 🟠 M3 | ArrowDown 无 WebKit 覆盖 | 补 ArrowDown 退出代码块测试 |
| 🟡 L1 | Enter「换行」测试假绿（子串断言） | 改精确 `textContent` 断言 |
| 🟡 Q4 | flaky fence 测试竞态 | 点击后加「等 `setActiveTask` 落定」等待 |

**验证为正确、无需改：** `turnTrailingFenceIntoCodeBlock` 位置运算、删除 `deleteEmptyListPlaceholder`（正确且必要）、按钮 `contenteditable="false"`、`getPos` 不陈旧、`aria-pressed`、Mod-a、Tab 路由、共享工厂无循环引用且复用安全、marker 无重复冲突。

### 10.3 测试现状

- `tests/editor-tab-list.test.ts`：**10/10 全绿**（WebKit）
- 全量：**210/215**（5 个失败均为既有、与编辑器无关：3× `task-summary-real-llm` 需真实 LLM；2× `plan-today-draft` Work Overview 面板 flaky）
- `git diff --check` 通过；web/server 构建通过

### 10.4 遗留项（未做，供后续）

1. **`notifyCursorTask` 副作用收敛**（阶段 4 第 5 条）——当前靠测试侧等待规避，产品侧仍每次选区变化都 `setActiveTask`。
2. **测试迁移 WebKit**——全量默认仍是 Chromium，仅 `editor-tab-list.test.ts` 用 WebKit（见 8.2）。
3. **阶段 5**：全局 dispatcher 守卫、spellcheck 可配置。
4. `renderHTML`/NodeView 丢 `language-*` class（既有，当前未用 `language`）。
5. read-only marker 测试用 `toBeVisible()` 测不出 WebKit 裁剪（测试质量问题，见 review L2）。
