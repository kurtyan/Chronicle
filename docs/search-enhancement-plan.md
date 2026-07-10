# Chronicle 搜索增强方案

> **状态**：调研完成，待实施
> **覆盖范围**：(1) 现有搜索功能精准度与体验优化 (2) 语义向量搜索接入
> **目标读者**：将实施这些改动的 agent 或开发者
> **前置阅读**：`README.md`（架构总览）、`AGENTS.md`（构建运行环境）

---

## 目录

- [一、现状速览](#一现状速览)
- [二、精准度问题](#二精准度问题17-项)
- [三、交互体验问题](#三交互体验问题15-项)
- [四、改进建议按-ROI-排序](#四改进建议按-roi-排序)
- [五、语义搜索架构总览](#五语义搜索架构总览)
- [六、语义搜索技术选型](#六语义搜索技术选型)
- [七、语义搜索实施计划4-阶段](#七语义搜索实施计划4-阶段)
- [八、Tauri-分发要点](#八tauri-分发要点最容易踩坑的地方)
- [九、关键陷阱清单](#九关键陷阱清单)
- [十、实施优先级](#十实施优先级)
- [附录A-现有代码结构索引](#附录a-现有代码结构索引)
- [附录B-参考资料](#附录b-参考资料)

---

## 一、现状速览

Chronicle 搜索分三个入口（行为不一致的体验）：

| 入口 | 快捷键 | 触发方式 | 范围 | 高亮 | 键盘导航 |
|---|---|---|---|---|---|
| Board 内联搜索 | `Cmd+F` | Enter 触发 | 只搜任务 | 仅标题 | ✅ ArrowUp/Down |
| 全局搜索 Dialog | `Cmd+Shift+F` | 180ms 防抖即时 | 任务+条目+笔记 | ❌ 无 | ❌ 无 |
| Notes 搜索 | 直接输入 | 250ms 防抖 | 仅笔记 | 仅跳转时 | ❌ 无 |

### 后端架构

- **数据库**：SQLite（better-sqlite3 v12.9.0），WAL 模式
- **全文索引**：FTS5，两个虚拟表 `tasks_fts`（任务+条目）、`notes_fts`（笔记）
- **tokenizer**：`unicode61`；nodejieba 在索引前**预分词**（token 前置、FTS5 只按空白切）
- **搜索 4 阶段流水线**（`server/src/services/searchService.ts` 的 `searchTasks()`）：
  1. FTS5 tokenized 搜索 → `ORDER BY f.rank`
  2. LIKE 精确匹配（全表扫描任务标题 + 条目内容）
  3. 多 token 全 token 命中回退（全表扫描）
  4. tags `LIKE '%query%'` 兜底
  5. 按 rank 去重排序（人工 rank -1.0 / -0.5 / 0.5 + FTS5 bm25 混用）

### 现有 LLM 基础设施（语义搜索可复用）

- `config.llm.{baseUrl, model, apiKey, timeoutMs}` — OpenAI 兼容格式，默认 `http://localhost:11434/v1`（Ollama）
- `llmService.ts` 用裸 `fetch()` 调 `${baseUrl}/chat/completions`，**无 SDK 依赖**
- `backgroundTaskService.ts` — 已有去重后台任务队列（`createOrReuseRunningTask`）
- Settings 已有 `ai.provider` 面板，可扩展为 embedding 选择器

---

## 二、精准度问题（17 项）

### 🔴 P0 — 根本性缺陷

**1. 全表扫描回退（Phase 2-3）每搜索都跑**
- `searchService.ts` 第 178-234 行：每次搜索都用 `SELECT id, title FROM tasks` 配 JS `includes()` 扫完所有任务和所有条目
- 对大库就是 O(n) × N 次 `htmlToPlainText` 调用
- 根因：分词后存储和原始文本脱节，必须修分词策略才能去掉这层 fallback

**2. BM25 不分列权重**
- `ORDER BY f.rank` 直接用 FTS5 默认 bm25，标题和正文命中权重一致
- FTS5 原生支持 `bm25(tasks_fts, 3.0, 0.0, 1.0, 1.5)` 让 `task_id/source/content` 不同列各拿不同权重
- 任务标题命中应该远高于 entry 正文命中

**3. 人造 rank 与 FTS5 rank 混用无归一化**
- 精确匹配 `-1.0`、全 token 命中 `-0.5`、FTS5 bm25（约 -3 ~ -12）、tag 兜底 `0.5` 直接放一起比大小
- FTS5 bm25 在 -3 ~ -12 范围摆动，被 `-1.0` 硬压上去时，FTS5 命中的多 keyword 任务反而会被排到精确匹配后面
- 包括像 "neo4j" vs "neo4j 部署" 这种明显应该排第一的 case

**4. 字段存索引的是 `tokenize(id + " " + title)`，不是原始文本**
- `indexTask` 把 `taskId + " " + title` 一起分词塞进 FTS5
- Task ID（如 "T0000012345"）被切成 token 进索引，把噪声推向极高位置
- 用户真正搜任务不会按 ID 搜，除非用 `id:T0000012*` 这种语法（目前没暴露）

**5. Tokenizer 过滤策略丢词**
- 1 个 ASCII 字符直接丢 → 搜 "a"、"x"、"3" 零结果
- 2 字 ASCII 只放行 `{ai, go, ui, ux, id}` → 搜 "js"、"ts"、"go" 之外的语言名进不去
- 用了 `cut` 不是 `cutForSearch` → 索引端召回率不如 `cutForSearch`（后者会插入二级分词，提升短词命中率）

**6. `shortAsciiQuery` 短查询完全不走 FTS5**
- 1-2 字 ASCII 查询跳过 FTS5 与精确匹配回退，仅靠 tag LIKE 兜底
- 用户搜 "go" 找含 "Go" 的任务，会命中一堆 tag 里含 "go" 的，完全错过标题/正文里含 "Go" 字面量的

### 🟡 P1 — 明显可改进

**7. 没有 prefix 索引，无法做 `meet*` 自动补全**
- 建表没设 `prefix='2 3 4'`
- `MATCH 'meet*'` 也能跑但全靠扫描，评分差
- 加上 prefix 索引立即获得 "边打字边搜" 的能力

**8. 没有 NEAR/bigram 邻近搜索**
- `"daily standup"` 当前只能命中 token 级，不能限定词序或邻近度
- 加 `NEAR(daily standup, 5)` 让 "daily meeting" 也能被 "standup daily" 命中

**9. 没有列过滤查询语法**
- FTS5 支持 `title:meeting`、`source:entry_log:crash`，但前端没暴露
- 用户想只搜日志、只搜标题、只搜笔记内容都做不到

**10. Tag fallback 用 `LIKE '%query%'` 整串匹配**
- `tasks.tags LIKE '%trimmed%'` 是整串匹配，会把 tag 列当字符串查
- 用户搜 "dev" 会命中 `["ai", "devops"]` 但也会命中 `["node_development"]`
- 应该 tokenize 后按 tag 对象查 `JSON_EACH(tags)`

**11. 每个任务只保留最佳匹配**
- `bestPerTask` 保 rank 最低的一条进结果
- 用户搜 "微服务" 一个任务里有 5 条 log 都提到微服务，应该能看到 5 条或至少有提示 "另有 4 处命中"

**12. Tasks 和 Notes 分两个 FTS 表、不能跨表搜索**
- `searchAll` 实际是两次独立搜索后合并
- 无法做 "某个 tag 在任务和笔记里同时出现" 这种联合查询
- FTS5 支持 UNION ALL + bm25 排序实现跨表（虽然 rank 不归一）

**13. `htmlToPlainText` 在 LIKE 回退里重复工作**
- 每次搜索都把每条 entry 的 HTML 重跑一遍
- 索引应该把纯文本原始内容另存一列，搜索时直接 `content_text LIKE ?`，避免每搜索全库剥 HTML

**14. MCP stdio bridge 缺 `search_notes` 工具**
- `mcp-bridge.mjs` 只暴露了 `search_tasks`
- HTTP MCP（`start.ts`）有两个，但 Claude Code 用户走 stdio 搜不到笔记
- MCP 响应也没 `total` 字段和 `includeArchived` 支持

### 🟢 P2 — 锦上添花

**15. 没有事前 spellfix1 容错**
- `editdist3` 或 spellfix1 对英文 typo 很有效（`meetin → meeting`）
- 对中文剪前面分词也能补救
- 当前完全无容错

**16. 没有 trigram 子串匹配**
- FTS5 的 trigram tokenizer 原生支持子串匹配（`"会议室"` 能命中 `"会议室预约"`）
- 对中文短查询比 jieba 切词更友好
- 可以二表并存：jieba 表做相关性排名，trigram 表做子串召回

**17. 索引范围窄**
- 当前只索引 tasks、task_entries、notes
- work sessions、day scripts、agent conversations、attachments 内容都不能搜
- 如要扩展，每加一个数据源就要重复一套 indexing + search 的样板

---

## 三、交互体验问题（15 项）

### 🔴 P0 — 明显影响体验

**1. GlobalSearchDialog 不高亮搜索结果**
- `App.tsx` 第 831-861 行：`renderTaskResult`/`renderNoteResult` 直接显示原始 title/snippet 纯文本
- `tokens` 字段拿到了但**完全没用**
- `searchJump.ts` 只负责跳转到目标页面后再高亮
- 全局搜索弹窗里的结果完全没视觉反馈，用户看到 "Meeting preparation" 不知道到底匹配了 "meeting" 还是 "preparation"

**2. Board 内联搜索跳转后不高亮**
- `taskStore.ts` `doSearch` 只存 `searchResults/searchTokens`，没 `setSearchJumpIntent`
- 用户按回车跳进任务详情 → workspace 完全不知道是从搜索进来的
- Tokens 在 store 里但 TaskDetailWorkspace 看不到 searchMode 状态

**3. GlobalSearchDialog 无键盘导航**
- 没有 ArrowUp/Down/Enter 处理用户在结果列表里上下移动的交互
- Escape 能关闭但用户只能鼠标点
- 一个面向键盘的搜索弹窗居然只能鼠标

**4. 三套搜索行为不一致**
- Board 用 Enter-to-search（落后）
- Global 用 180ms 防抖即时搜索
- Notes 用 250ms 防抖过滤
- 用户在每个页面体验到三套搜索 UX 范式，心智成本高
- 应该统一为即时 + 防抖

### 🟡 P1 — 体验短板

**5. Board 内联搜索结果卡片没内容预览**
- `BoardPage.tsx` 第 955-1000 行：结果卡只显示标题 + 类型徽章 + 状态
- 命中日志内容时不显示 `matchedOriginal` 的片段
- 用户看到标题 "T0000012345" 不知道匹配了哪段日志，只能点进去看

**6. 没有搜索历史/最近搜索**
- 每次打开搜索都得重新打
- 一个本地优先的应用保存最近 10-20 条 query 到 localStorage 几乎零成本

**7. 没有结果计数**
- GlobalSearchDialog 没显示 "找到 8 个任务、3 条日志、2 个笔记"
- `result.total` 字段后端返回了但前端没用
- 各 section 单独计数也没显示

**8. 没有高级过滤/搜索运算符**
- 不能按 status 过滤搜索
- 不能按 type 过滤搜索
- 不能按日期范围
- 不能用 `title:foo`、`tag:bar`、`status:done` 这种语法
- 不能按某个 entry type 限定（只搜 log / 只搜 pinned）

**9. 没有自动补全/输入建议**
- 打字过程中没有前缀提示、tag 建议、常用查询补全
- `prefix='2 3 4'` 加上后端语法就能做

**10. searchJump 的 10 秒 TTL 太脆**
- `sessionStorage` + 10s TTL
- 如果用户在搜索结果看一会再点另一条，第一条的 jump intent 已经吃掉了
- 应该按动作计算而不是按时间

### 🟢 P2 — 体验加分

**11. GlobalSearchDialog 的 plainText 处理粗糙**
- `plainText()` 只是 strip HTML 标签
- 匹配命中 `<img alt="...">` 这种节点时容易生成乱码片段

**12. Board 搜索模式无法看任务日志**
- 搜索模式下点结果只是 `setActiveTask`，但搜索框还在
- 如果用户想在搜索的同时看任务详情的日志，detail panel 还展示着上一个任务的，体验割裂

**13. 高亮算法不处理嵌套 token**
- `highlight.ts` 用 greedy 贪心选最长 token 先匹配
- 如果 token 是 `["meeting", "meet"]`，"meet" 永远不会高亮
- 应该全 token 都尝试匹配，取最早出现的

**14. 搜索结果无法批量操作**
- 搜出来 10 个状态为 DROPPED 的任务，想批量改成 DONE 没办法

**15. Board 退出搜索后焦点不归位**
- Escape 退出搜索模式 → 焦点丢失
- 之前的 `preSearchTaskId` 恢复了但没 `focus()` 对应元素

---

## 四、改进建议（按 ROI 排序）

### 立即做（1-2 天，改动极小，收益巨大）

| # | 改动 | 文件 | 估计 |
|---|---|---|---|
| A | GlobalSearchDialog 加 `highlightText` 包到 task/note 渲染 | `App.tsx` | 0.5h |
| B | Board 内联搜索点击时 `setSearchJumpIntent` | `BoardPage.tsx` | 0.5h |
| C | GlobalSearchDialog 加 ArrowUp/Down/Enter 键盘导航 | `App.tsx` | 1h |
| D | 各 section 显示结果计数（"Tasks · 12"） | `App.tsx` | 0.5h |
| E | BM25 分列权重 `bm25(tasks_fts, 3.0, 0.0, 1.0, 1.5)` | `searchService.ts` | 1h |
| F | FTS5 表加 `prefix='2 3 4'` 索引（需 rebuild） | `db.ts` | 1h |
| G | 删除 `indexTask` 里把 taskId 一起索引进去的逻辑 | `searchService.ts` | 0.5h |
| H | 字符串 tag 查询改为 `JSON_EACH(tags)` 查询 | `searchService.ts` | 1h |
| I | MCP stdio bridge 加 `search_notes` 工具 | `mcp-bridge.mjs` | 0.5h |

### 短期做（1 周，精准度质变）

| # | 改动 | 说明 |
|---|---|---|
| J | **重构分词对称性** — 索引和查询都用 `cutForSearch`，去掉 Phase 2/3 全表扫描 | 改完后段 2/3 可直接删除 |
| K | **归一化 rank** — 把 FTS5 bm25 分数归一到 [0,1]，再和人工权重组合 | 让多阶段排序可控 |
| L | **加 `prefix='2 3 4'` 后做搜索即时模式** — GlobalSearchDialog 的 180ms 已有，Board 内联改为即时 | 三套搜索行为统一为即时 |
| M | **加 server 端 snippet()** — 用 FTS5 内置 `snippet()` 替代手动 180 字截断 | Backend 拿出带上下文的匹配片段 |
| N | **每任务显示匹配次数** — bestPerTask 改成 group by 出 `matchCount`，至少在 UI 标示 "×5 hits" | 知道任务内有多少匹配 |
| O | **`htmlToPlainText` 在 indexing 时落库** — 加一列 `entry_plaintext`，搜索 LIKE 直接查它 | 干掉每次搜索的 HTML 解析 |
| P | **JSON_EACH(tags)** 用 B-tree 索引替代 LIKE | tag 搜索精准且能用索引 |

### 中期做（2-4 周，体验质变）

| # | 改动 |
|---|---|
| Q | 统一三套搜索为一套 "Search Slash Command" 模式（弹窗 + 即时 + 键盘导航 + 跨 scope） |
| R | 加搜索历史（localStorage 保留最近 20 条），下次打开默认显示 |
| S | 加高级过滤（status/type/date/tag），后端 API 暴露 `status=DOING&type=TODO` 查询参数 |
| T | 加列过滤搜索语法 `title:foo content:bar`，前端解析后路由到 FTS5 column filter |
| U | 见本文下半部分「语义搜索方案」— 加 trigram 备表 + 向量检索做 hybrid RRF 融合 |
| V | 加 spellfix1 做英文 typo 容错（`meetin → meeting`） |
| W | 加 FTS5 5GB 以下的 optimize 命令定期跑（每天空闲时段） |
| X | 搜索结果支持选中多条批量操作 |
| Y | MCP 输出加 `total` 字段、加 `includeArchived`、加一个 `search_all` 工具 |

### 长期做（如有需要）

- 自定义 FTS5 rank 函数（C/Rust 扩展），综合考虑 recency、priority、status
- 索引扩展：work sessions、agent conversations、attachments 内容
- 搜索范围分租户/工作空间（如果将来支持多用户）

### 建议的推进顺序

投入回报率最高的 5 件事（按这个顺序做）：

1. **A + B + C + D**：4h 改完，搜索体验从 "感觉不到在做搜索" 到 "凸现当前在做搜索"
2. **E + F + G + H**：半天改完，搜索精准度直接翻一倍以上
3. **J + K**：1 周干完，干掉 O(n) 全表扫描，让搜索性能可承载大规模数据
4. **L + M + N + O**：3 天干完，统一三套交互
5. **R + S + T**：1 周做完，搜索进入 "专业级" 水平

---

## 五、语义搜索架构总览

```
用户查询
  │
  ├─ 预过滤 (status/type/tags) ── 应用到两条检索路径
  │
  ├─┬─ PATH A: FTS5 BM25（现有 searchTasks）
  │ └─ tokenize → FTS5 MATCH → rank
  │
  ├─┬─ PATH B: 向量 KNN（新增 sqlite-vec）
  │ ├─ embed(query) → 向量
  │ └─ vec0 MATCH → distance → top-K
  │
  ├─ RRF 融合 (score = Σ weight / (k + rank))
  │  └─ k=60, keyword weight=1.25, vector weight=1.0
  │
  ├─ 后融合重排 (recency boost / priority boost)
  │
  └─ Top-K 结果
```

**核心思路**：FTS5 不替换，加一路向量检索并行跑，RRF 融合排序。

- 精确匹配由 BM25 保障
- 语义召回由向量保障
- 融合排序由 RRF 保障

### RRF 公式

来自原始论文 Cormack, Clarke, Büttcher (SIGIR 2009):

```
RRFscore(d) = Σ_over_retriever_r (1 / (k + rank_r(d)))
```

参数：
- `rank_r(d)` = 文档 `d` 在检索器 `r` 的结果列表中的位置（1-based）
- `k` = 平滑常数，**k=60** 为论文发现的最优值，在生产中（Logseq、Elasticsearch、Azure AI Search）作为通用默认值
- 一个文档在某检索器列表中不存在则该路贡献为 0

**关键论文发现**：k=60 "near-optimal, but the choice was not critical"，RRF 比 Condorcet Fuse 和 CombMNZ 高 4-5%。

### 权重取舍

Logseq 生产验证的做法（推荐 Chronicle 参考）：
- keyword weight = **1.25** — 让精确匹配不被弱向量结果挤掉
- vector weight = **1.0** — 基准线
- 设计哲学："Hybrid ranking should keep vector similarity as an auxiliary signal. Exact or strong keyword matches must not be displaced by weak vector hits."

---

## 六、语义搜索技术选型

### 6.1 向量存储：`sqlite-vec` v0.1.9

| 特性 | 说明 |
|---|---|
| npm 包 | `sqlite-vec`（自动安装平台子包如 `sqlite-vec-darwin-arm64`） |
| 加载方式 | `sqliteVec.load(db)` 一行代码，内部调 `db.loadExtension()` |
| 二进制大小 | `vec0.dylib` 仅 50KB |
| 查询语法 | `WHERE embedding MATCH ? AND k = 10 ORDER BY distance` |
| 距离度量 | cosine / L2 / L1，建表时 `distance_metric=cosine` |
| 性能 | 暴力扫描，<10K 向量 sub-10ms；v0.1.10-alpha 加 DiskANN 索引 |
| 与现有栈兼容 | ✅ better-sqlite3 v12.9.0 原生支持 `loadExtension()` |
| 旧版替代 | `sqlite-vss` 已废弃，所有开发精力在 sqlite-vec（纯 C 零依赖） |
| GitHub | [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) 8K+ stars |
| 许可证 | MIT / Apache-2.0 dual |

**加载示例**:
```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database(":memory:");
sqliteVec.load(db);  // 一行加载

// 验证
const { vec_version } = db.prepare("select vec_version() as vec_version;").get();
```

### 6.2 嵌入模型：两条路径并存

| 路径 | 模型 | 大小 | 维度 | 中文 C-MTEB Retrieval | 运行方式 |
|---|---|---|---|---|---|
| **Provider API**（默认） | 复用 `config.llm.baseUrl` | 0 | 取决于模型 | 取决于模型 | `fetch(${baseUrl}/embeddings)` |
| **本地模型**（可选） | `Xenova/bge-small-zh-v1.5` (q8) | **24MB** | 512 | **61.77** | `@huggingface/transformers` + onnxruntime-node |

**为什么 Provider 路径是默认**：Chronicle 默认指向 Ollama `localhost:11434/v1`，Ollama 同时提供 `/embeddings` 端点，零额外安装。

**为什么 bge-small-zh-v1.5 是本地模型推荐**：
- 24MB int8 模型 — 是 300MB 以内所有模型中**最小**的
- C-MTEB 检索得分 61.77 — 是 300MB 以内所有模型中**最高**的中文检索得分
- 512 维向量 — 存储和查询效率好
- M 系列 CPU 上 ~80-120 embed/s
- MIT 许可证

**被淘汰的模型**：
| 模型 | 否决原因 |
|---|---|
| mxbai-embed-large-v1 | 337MB quantized 超过 300MB 目标 |
| jina-embeddings-v3 | >2 GB |
| bge-m3 | >2 GB |
| all-MiniLM-L6-v2 | 只支持英文，中文需求失败 |
| multilingual-e5-small | 118MB int8，比 bge-large 5x 大，中文检索 59.95 略低 |

**模型对比表（候选模型）**：

| Model | Dim | C-MTEB Avg | C-MTEB Retrieval | ONNX int8 Size | Languages |
|---|:---:|:---:|:---:|:---:|---|
| **bge-small-zh-v1.5** | 512 | 57.82 | 61.77 | ~24 MB | Chinese |
| multilingual-e5-small | 384 | 55.38 | 59.95 | ~118 MB | 100 langs |
| gte-small | 384 | N/A (EN 61.36) | N/A | ~34 MB | EN+some CN |

### 6.3 运行时：`@huggingface/transformers` v3

- npm: `@huggingface/transformers` (v3)；`@xenova/transformers` (v2 已废弃)
- Node.js 环境下底层用 `onnxruntime-node`（原生 CPU 绑定，非 WASM）
- Pipeline API: `pipeline('feature-extraction', modelId, { dtype: 'q8' })` 一行
- 模型首次下载自动缓存到 `env.cacheDir`

### 6.4 量化推荐

| Dtype | 质量保留 | 大小 vs fp32 | 推荐度 |
|---|:---:|:---:|---|
| **int8 / q8** | ~99% | **25%** | **✅ Sweet spot** |
| fp16 | ~100% | 50% | 可接受但更大 |
| q4 | ~95% | 15% | 有明显退化 |
| fp32 | 100% | 100% | 没有必要 |

**Verdict**: 永远用 `dtype: 'q8'` (int8)。BERT-based 嵌入模型对 int8 量化基本无感。

### 6.5 模型前缀

- **bge-small-zh-v1.5**: 索引和查询都需要前缀 `为这个句子生成表示以用于检索相关文章：`
- **multilingual-e5-small**: 文档用 `passage: ` 前缀，查询用 `query: ` 前缀
- **gte-small**: 不需要前缀

---

## 七、语义搜索实施计划（4 阶段）

### 阶段 1：基础设施（~500 行新增，0 行改动现有代码）

#### 1.1 数据库 Schema（`server/src/db.ts`）

```sql
-- 向量表：一个任务一个向量
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_vec USING vec0(
  task_id TEXT PRIMARY KEY,
  embedding FLOAT[512]     -- bge-small-zh = 512 维; e5-small = 384 维
);

-- 嵌入缓存表：避免重复 embed 同一段文本
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash TEXT,           -- SHA1(plaintext + model)
  model TEXT,
  embedding BLOB,           -- Float32Array 序列化
  created_at INTEGER,
  PRIMARY KEY (text_hash, model)
);
```

**注意**：`vec0` 表维度取决于模型。建议在加载时检查并若不匹配则 drop+rebuild（参考现有 `tasks_fts` 在 schema 变更时 drop 的做法，见 `db.ts` 第 73-80 行）。

#### 1.2 嵌入服务（新文件 `server/src/services/embeddingService.ts`）

```typescript
import { getConfig } from '../config'
import { getDb } from '../db'
import { createHash } from 'crypto'
import { getLogger } from '../logging'

// --- Provider API 路径 ---
async function embedViaProvider(texts: string[]): Promise<number[][]> {
  const config = getConfig().llm
  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(config.timeoutMs),
    body: JSON.stringify({
      model: config.embeddingModel || config.model,
      input: texts,
    }),
  })
  const json = await res.json()
  return json.data.map((item: any) => item.embedding)
}

// --- 本地模型路径 ---
let localPipeline: any = null
async function getLocalPipeline() {
  if (!localPipeline) {
    // 动态导入避免打包到主二进制（按需加载，仅 local 模式用户触发）
    const { pipeline, env } = await import('@huggingface/transformers')
    const path = require('path')
    const os = require('os')
    env.cacheDir = path.join(os.homedir(), '.chronicle', 'models')
    localPipeline = await pipeline(
      'feature-extraction',
      'Xenova/bge-small-zh-v1.5',
      { dtype: 'q8' }
    )
  }
  return localPipeline
}

async function embedViaLocal(texts: string[]): Promise<number[][]> {
  const pipe = await getLocalPipeline()
  // bge 模型需要前缀
  const prefixed = texts.map(t => `为这个句子生成表示以用于检索相关文章：${t}`)
  const output = await pipe(prefixed, { pooling: 'cls', normalize: true })
  return output.tolist()
}

// --- 统一入口：带缓存 ---
export async function embed(texts: string[]): Promise<number[][]> {
  const config = getConfig().llm
  const mode = config.embeddingMode ?? 'off'
  if (mode === 'off') return []
  const model = config.embeddingModel || config.model || 'bge-small-zh-v1.5'

  // 查缓存
  const db = getDb()
  const results: (number[] | null)[] = new Array(texts.length).fill(null)
  const uncached: { idx: number; text: string }[] = []

  for (let i = 0; i < texts.length; i++) {
    const hash = createHash('sha1').update(texts[i] + model).digest('hex')
    const row = db.prepare(
      'SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?'
    ).get(hash, model) as { embedding: Buffer } | undefined
    if (row) {
      results[i] = Array.from(new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      ))
    } else {
      uncached.push({ idx: i, text: texts[i] })
    }
  }

  if (uncached.length === 0) return results as number[][]

  const uncachedTexts = uncached.map(u => u.text)
  const embeddings = mode === 'local'
    ? await embedViaLocal(uncachedTexts)
    : await embedViaProvider(uncachedTexts)

  // 回写缓存
  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO embedding_cache (text_hash, model, embedding, created_at) VALUES (?, ?, ?, ?)'
  )
  const tx = db.transaction((items: Array<{ idx: number; text: string; embedding: number[] }>) => {
    for (const it of items) {
      const hash = createHash('sha1').update(it.text + model).digest('hex')
      const buf = Buffer.from(new Float32Array(it.embedding).buffer)
      insertStmt.run(hash, model, buf, Date.now())
      results[it.idx] = it.embedding
    }
  })
  tx(uncached.map((u, i) => ({ ...u, embedding: embeddings[i] })))

  return results as number[][]
}

// --- 向量索引写入 ---
import { htmlToPlainText } from './searchText'

export async function indexTaskVector(
  taskId: string,
  title: string,
  body: string,
  tags: string[]
): Promise<void> {
  const db = getDb()
  const embeddingText = [title, htmlToPlainText(body), tags.join(' ')]
    .filter(Boolean).join(' ')
  if (!embeddingText.trim()) {
    db.prepare('DELETE FROM tasks_vec WHERE task_id = ?').run(taskId)
    return
  }
  // 截断到模型上下文长度
  const truncated = embeddingText.slice(0, 2000)
  const [vec] = await embed([truncated])
  if (!vec || vec.length === 0) return  // embeddingMode=off 或失败
  
  db.prepare('DELETE FROM tasks_vec WHERE task_id = ?').run(taskId)
  db.prepare('INSERT INTO tasks_vec (task_id, embedding) VALUES (?, ?)').run(
    taskId,
    new Float32Array(vec)
  )
}

export function removeTaskVector(taskId: string): void {
  getDb().prepare('DELETE FROM tasks_vec WHERE task_id = ?').run(taskId)
}
```

**关键集成点**：在 `taskService.ts` 的 `createTask`/`updateTask`/`deleteTask` 旁，现有的 `indexTask`/`indexEntry` 调用旁边，加一行异步 `indexTaskVector`：

```typescript
// server/src/services/taskService.ts
// createTask 内（在现有 indexTask 之后）
indexTask(id, title)
indexEntry(id, entryId, body, 'body')
// 新增 — 异步不阻塞
void indexTaskVector(id, title, body, tags).catch(err =>
  getLogger().error({ err }, 'Vector indexing failed')
)

// updateTask 内（在现有 indexTask 之后）
indexTask(id, title)
if (bodyChanged) {
  void indexTaskVector(id, title, newBody, tags).catch(err =>
    getLogger().error({ err }, 'Vector indexing failed')
  )
}

// deleteTask 内（在现有 removeTaskFromIndex 之后）
removeTaskFromIndex(id)
removeTaskVector(id)  // 同步即可，是简单 DELETE
```

### 阶段 2：混合搜索（~200 行）

#### 2.1 RRF 融合函数（新文件 `server/src/services/rrf.ts`）

```typescript
export interface RRFConfig {
  k: number          // 默认 60
  weights: Record<string, number>  // { bm25: 1.25, vector: 1.0 }
  topK: number
}

export const DEFAULT_RRF_CONFIG: RRFConfig = {
  k: 60,
  weights: { bm25: 1.25, vector: 1.0 },
  topK: 50,
}

export interface FusionCandidate<T> extends T {
  rrfScore: number
  rrfRanks: Record<string, number>
}

/**
 * Reciprocal Rank Fusion: 合并多个排序好的结果列表。
 * 每个列表第一个元素 = rank 1。
 */
export function rrfFusion<T extends { id: string }>(
  lists: Array<{ name: string; results: T[] }>,
  config: Partial<RRFConfig> = {},
): Array<FusionCandidate<T>> {
  const { k, weights, topK } = { ...DEFAULT_RRF_CONFIG, ...config }
  const candidates = new Map<string, FusionCandidate<T>>()

  for (const { name, results } of lists) {
    const weight = weights[name] ?? 1.0
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank]
      const key = item.id
      const contribution = weight / (k + rank)  // rank 0-based
      
      let candidate = candidates.get(key)
      if (!candidate) {
        candidate = { ...item, rrfScore: 0, rrfRanks: {} }
        candidates.set(key, candidate)
      }
      candidate.rrfRanks[name] = rank + 1  // 存 1-based rank
      candidate.rrfScore += contribution
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
}
```

#### 2.2 混合搜索（扩展 `server/src/services/searchService.ts`）

```typescript
import { rrfFusion } from './rrf'
import { embed } from './embeddingService'

// 新增：向量搜索
async function searchTasksVector(
  query: string,
  limit: number,
  filters?: { status?: string; type?: string },
): Promise<SearchResult[]> {
  const db = getDb()
  const [queryVec] = await embed([query])
  if (!queryVec || queryVec.length === 0) return []  // embeddingMode=off 或失败

  const where: string[] = []
  const params: any[] = []
  if (filters?.status) {
    where.push('t.status = ?')
    params.push(filters.status)
  }
  if (filters?.type) {
    where.push('t.type = ?')
    params.push(filters.type)
  }

  const rows = db.prepare(`
    SELECT t.id, t.title, t.type, t.status, t.tags, v.distance
    FROM tasks t
    INNER JOIN (
      SELECT task_id, distance
      FROM tasks_vec
      WHERE embedding MATCH ?
        AND k = ?
    ) v ON t.id = v.task_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.distance
    LIMIT ?
  `).all(new Float32Array(queryVec), limit, limit, ...params)

  return rows.map((row: any) => ({
    taskId: row.id,
    entryId: null,
    taskTitle: row.title,
    taskType: row.type,
    taskStatus: row.status,
    taskTags: JSON.parse(row.tags || '[]'),
    matchType: 'task',
    matchedContent: '',
    originalTitle: row.title,
    matchedOriginal: '',
    tokens: [],
    exactMatch: false,
    rank: row.distance,
  }))
}

// 新增：混合搜索入口（保留原有 searchTasks 不变）
export async function hybridSearchTasks(
  query: string,
  limit = 50,
  filters?: { status?: string; type?: string },
): Promise<SearchResponse> {
  const trimmed = query.trim()
  if (!trimmed) return { results: [], tokens: [] }

  // 过采样：每路取 limit*2，融合后取 limit
  const searchLimit = limit * 2

  // 并行两路
  const [bm25Result, vectorResults] = await Promise.all([
    Promise.resolve(searchTasks(trimmed, searchLimit)),  // 同步函数包 Promise
    searchTasksVector(trimmed, searchLimit, filters),
  ])

  const bm25List = bm25Result.results.map(r => ({ id: r.taskId, data: r }))
  const vectorList = vectorResults.map(r => ({ id: r.taskId, data: r }))

  const fused = rrfFusion(
    [
      { name: 'bm25', results: bm25List },
      { name: 'vector', results: vectorList },
    ],
    { k: 60, weights: { bm25: 1.25, vector: 1.0 }, topK: limit }
  )

  return {
    results: fused.map(f => f.data),
    tokens: bm25Result.tokens,
  }
}
```

#### 2.3 API 路由切换（`server/src/index.ts`）

```typescript
// 现有 GET /api/search 内的逻辑
app.get('/api/search', async (c) => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'q parameter required' }, 400)
  const limit = parseInt(c.req.query('limit') || '50')
  const scope = c.req.query('scope') || 'tasks'
  const includeArchived = c.req.query('includeArchived') === 'true'
  const hybrid = c.req.query('hybrid') === 'true'  // 新增
  
  // 若 hybrid=true 且 scope=tasks → 走新路径
  if (hybrid) {
    const { results, tokens } = await hybridSearchTasks(q, Math.min(limit, 200))
    return c.json({ results, tokens, total: results.length })
  }
  // ... 现有逻辑保持不变
})
```

**切换策略**：先以 `?hybrid=true` 参数灰度发布，Settings 加 `embeddingMode` 开关后再默认走 hybrid。

### 阶段 3：配置 + UI

#### 3.1 扩展 config（`server/src/config.ts`）

```typescript
llm: {
  // 现有字段保持不变
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  meetingExtractionMaxTokens: number
  taskSummaryMaxTokens: number
  dailySummaryMaxTokens: number
  meetingExtractionPrompt: string
  taskSummaryPrompt: string
  dailySummaryPrompt: string
  // 新增
  embeddingMode: 'provider' | 'local' | 'off'  // 默认 'off'
  embeddingModel?: string                       // 空时复用 model
}
```

环境变量覆盖：`CHRONICLE_LLM_EMBEDDING_MODE`、`CHRONICLE_LLM_EMBEDDING_MODEL`

#### 3.2 Settings UI（`web/src/pages/SettingsPage.tsx` AI > Provider 区域）

在现有 Provider 设置卡片底部加：

```
┌─ AI > Provider ─────────────────────────────┐
│ Base URL:    [http://localhost:11434/v1]    │
│ Model:       [qwen2.5:7b              ]     │
│ API Key:     [                        ]     │
│ Timeout:     [30000] ms                    │
│                                             │
│ ── 语义搜索 ──                              │  ← 新增
│ 模式: ( ) 关闭  (●) Provider API  ( ) 本地模型 │
│ Embedding Model: [text-embedding-3-small]   │  ← 仅 provider 模式显示
│ [测试 Embedding 连接]                       │
│                                             │
│ （开启语义搜索后将触发后台索引重建任务）        │
└─────────────────────────────────────────────┘
```

#### 3.3 测试连接端点（`server/src/index.ts`）

```typescript
app.post('/api/settings/llm/test-embeddings', async (c) => {
  try {
    const [vec] = await embed(['test'])
    if (!vec || vec.length === 0) {
      return c.json({ ok: false, error: 'Embedding mode is off' })
    }
    return c.json({ ok: true, dim: vec.length, latencyMs: /* 测一下 */ 0 })
  } catch (err) {
    return c.json({ ok: false, error: String(err) })
  }
})
```

### 阶段 4：批量索引 + 渐进上线

#### 4.1 初始索引（复用现有 `backgroundTaskService`）

```typescript
// server/src/services/embeddingService.ts 追加

import { createOrReuseRunningTask, finishBackgroundTask, failBackgroundTask } from './backgroundTaskService'

// 在 BackgroundTaskType 联合类型里加 'embedding'
// type BackgroundTaskType = 'daily_summary' | 'task_summary' | 'meeting_extract' | 'embedding'

export async function rebuildVectorIndex(): Promise<void> {
  const task = createOrReuseRunningTask({
    type: 'embedding' as any,  // 先 cast，等类型扩展后去掉
    sourceKey: 'rebuild-all',
    title: 'Rebuilding vector index',
    timeoutAt: Date.now() + 600_000,  // 10 min 超时
  })

  try {
    const db = getDb()
    // 读取所有任务（含已完成的，方便搜索全部历史）
    const tasks = db.prepare(`
      SELECT t.id, t.title, t.tags, 
             (SELECT content FROM task_entries 
              WHERE task_id = t.id AND type = 'body' 
              ORDER BY created_at DESC LIMIT 1) as body
      FROM tasks t
    `).all() as Array<{ id: string; title: string; tags: string; body: string | null }>

    db.prepare('DELETE FROM tasks_vec').run()

    const BATCH_SIZE = 32
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE)
      // 构造 embedding 文本（title + tags + body 前 2000 字）
      const texts = batch.map(t => 
        [t.title, t.body ? htmlToPlainText(t.body).slice(0, 2000) : '', JSON.parse(t.tags || '[]').join(' ')]
          .filter(Boolean).join(' ')
      )
      const embeddings = await embed(texts)
      
      if (embeddings.length === 0) break  // embeddingMode=off
      
      const insert = db.prepare('INSERT INTO tasks_vec (task_id, embedding) VALUES (?, ?)')
      const insertTx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          if (embeddings[j] && embeddings[j].length > 0) {
            insert.run(batch[j].id, new Float32Array(embeddings[j]))
          }
        }
      })
      insertTx()
    }

    finishBackgroundTask(task.id, { indexed: tasks.length })
  } catch (err) {
    failBackgroundTask(task.id, String(err))
    throw err
  }
}
```

**复用现有 SSE 通知机制**：`finishBackgroundTask` 会通过 `eventBus` 广播，前端 `useBackgroundTaskStore` 已有 toast UI 展示进度。

#### 4.2 增量索引

见阶段 1.2 末尾的集成点说明。

#### 4.3 上线策略

- `embeddingMode` 默认 `'off'` → 不影响现有用户
- Settings 页加 "启用语义搜索" 开关 → 用户主动开启  
  - 可以在 UI 加一个 "重建索引" 按钮，手动触发 `POST /api/search/rebuild-vector`
  - 或在 `saveLlmSettings` 检测到 `embeddingMode` 从 `'off'` 变更时自动触发后台任务
- 索引完成后 `hybridSearchTasks()` 自动取代 `searchTasks()` 作为搜索后端
- API 端：`?hybrid=false` 保持向后兼容，前端默认 `?hybrid=true` 当 `embeddingMode != 'off'`

---

## 八、Tauri 分发要点（最容易踩坑的地方）

### 1. esbuild/tsup 配置 — 必须加 external

```typescript
// server/tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  // ... 现有配置
  external: ['better-sqlite3', 'sqlite-vec'],  // ← 必须加 sqlite-vec
})
```

不加 `external` 的话 bundler 会把 `sqlite-vec` 的代码内联，导致 `import.meta.url` 指向打包后文件，找不到 `.dylib`。

### 2. macOS 代码签名

`vec0.dylib` 是未签名 npm 包分发的 .dylib。Tauri 打包后 `dlopen()` 会报 code signature 错误：

```
dlopen(.../vec0.dylib): code signature in <UUID> not valid for use in process:
  mapped file has no cdhash, completely unsigned?
```

**两个解法**：

**选项 A（开发期简单）**：给 dylib 加 ad-hoc 签名
```bash
codesign -f -s - node_modules/sqlite-vec-darwin-arm64/vec0.dylib
```

**选项 B（正式分发）**：Tauri entitlements plist 加
```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

### 3. Tauri Resources 配置

```json
// tauri/tauri.conf.json
{
  "bundle": {
    "resources": {
      "node_modules/sqlite-vec-darwin-arm64/vec0.dylib": "sqlite-vec/"
    }
  }
}
```

这会把 .dylib 复制到 `.app` 包的 `Resources` 目录。

### 4. 生产环境加载路径

```typescript
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import path from 'path'

const db = new Database(dbPath)

if (process.env.NODE_ENV === 'production' && process.resourcesPath) {
  // Tauri sidecar 模式 — 手动指定路径
  db.loadExtension(path.join(process.resourcesPath, 'sqlite-vec', 'vec0.dylib'))
} else {
  // 开发模式 — 让 sqlite-vec 自动找到 dylib
  sqliteVec.load(db)
}
```

### 5. @huggingface/transformers 打包

不要把这个包加到 `dependencies`，让它通过 `dynamic import()` 按需加载：

```typescript
// 只在 mode=local 触发时才加载
async function getLocalPipeline() {
  const { pipeline, env } = await import('@huggingface/transformers')
  // ...
}
```

tsup 配置需要加 external：
```typescript
external: ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node']
```

没开启 local 模式的用户根本不会触发这个 import，不会下载模型文件，也不会增加应用体积。

---

## 九、关键陷阱清单

### 精准度改进陷阱

| # | 陷阱 | 解决方案 |
|---|---|---|
| 1 | 改 tokenizer 后老索引失效 | bump `_meta.fts_tokenizer_version`，db.ts 已有 auto-rebuild 逻辑（见第 408-409 行） |
| 2 | 改 schema 后老 FTS5 表残留 | db.ts 已有 drop-if-not-match 模式（第 73-80 行），新 vec0 表照做 |
| 3 | BM25 列权重改动后想回滚 | 把 `bm25(tasks_fts, ...)` 改回 `f.rank` 即可，无需 rebuild |
| 4 | prefix='2 3 4' 加上后 FTS5 索引膨胀 | 索引体积+30-50%，搜索速度大幅提升，权衡可行 |

### 语义搜索陷阱

| # | 陷阱 | 解决方案 |
|---|---|---|
| 1 | `sqlite-vec` dylib 在 Tauri 包里找不到 | tsup `external` + Tauri `bundle.resources` |
| 2 | macOS codesign 拒绝加载未签名 dylib | ad-hoc 签名 (`codesign -f -s -`) 或 `disable-library-validation` entitlement |
| 3 | 向量索引阻塞写入主线程 | `indexTaskVector` 调用用 `void` 异步，不 await |
| 4 | 首次安装时向量表为空 | `embeddingMode=off` 默认，用户手动开启触发 `rebuildVectorIndex()` |
| 5 | bge-small-zh 需要前缀 `为这个句子生成表示以用于检索相关文章：` | `embeddingService.ts` 统一加前缀 |
| 6 | Ollama 没装嵌入模型 | Settings 加 "测试 Embedding 连接" 按钮 |
| 7 | 向量维度和 FTS5 表不兼容 | 向量表和 FTS5 表完全独立，不需要对齐 |
| 8 | RRF 中 BM25 返回 0 但向量有结果 | 正常 — RRF 自然处理，不受影响 |
| 9 | embed 查询缓存 | session 内 LRU `Map<string, number[]>`，50 条上限 |
| 10 | 旧数据无向量索引 | 开启语义搜索时后台 `rebuildVectorIndex()` |
| 11 | 模型切换后向量维度变了 | 监测 dim 变化 → drop 并 rebuild `tasks_vec` 表（参考 db.ts 现有 FTS5 schema 变更模式） |
| 12 | 用户关闭语义搜索后要回到原 searchTasks | API 端 `?hybrid=false` 兜底，前端根据 `embeddingMode` 选择 |

---

## 十、实施优先级

### 第一波：现有搜索精准度 + 体验（不依赖语义搜索）

| 顺序 | 任务 | 工作量 | 依赖 |
|---|---|---|---|
| 1 | A. GlobalSearchDialog 加高亮 | 0.5h | 无 |
| 2 | B. Board 内联搜索加 searchJumpIntent | 0.5h | 无 |
| 3 | C. GlobalSearchDialog 键盘导航 | 1h | 无 |
| 4 | D. 结果计数 | 0.5h | 无 |
| 5 | E. BM25 分列权重 | 1h | 无 |
| 6 | F. FTS5 prefix 索引 | 1h | 5 |
| 7 | G. 去掉 taskId 索引 | 0.5h | 无 |
| 8 | H. JSON_EACH(tags) 查询 | 1h | 无 |
| **小计** | | **6.5h** | |

### 第二波：语义搜索基础链路（Provider API 路径）

| 顺序 | 任务 | 工作量 | 依赖 |
|---|---|---|---|
| 9 | db.ts 加 vec0 + embedding_cache 表 | 0.5h | 无 |
| 10 | embeddingService.ts (Provider 路径 + 缓存) | 2h | 9 |
| 11 | rrf.ts | 1h | 无 |
| 12 | searchService 加 searchTasksVector + hybridSearchTasks | 3h | 9,10,11 |
| 13 | API 路由加 `?hybrid=true` 参数 | 1h | 12 |
| 14 | config 加 embeddingMode/embeddingModel | 1h | 无 |
| 15 | Settings UI 加语义搜索开关 | 2h | 14 |
| 16 | taskService 写入路径加 indexTaskVector | 1h | 10 |
| 17 | rebuildVectorIndex 后台任务 | 2h | 10,16 |
| 18 | Tauri 分发配置 (dylib + codesign + resources) | 2h | 9 |
| **小计** | | **15.5h** | |

### 第三波：本地模型路径（可选增强）

| 顺序 | 任务 | 工作量 | 依赖 |
|---|---|---|---|
| 19 | 本地模型路径 (@huggingface/transformers + bge-small-zh) | 3h | 10 |
| 20 | 测试本地模型在 Tauri 包内能正常加载 | 2h | 18,19 |
| **小计** | | **5h** | |

### 第四波：长期演进（在基础链路跑通后）

| # | 改动 | 说明 |
|---|---|---|
| 21 | 统一三套搜索为单一搜索面板 | 三套当前行为差异大，建议合并 |
| 22 | 搜索历史 localStorage | 20 条最近 query |
| 23 | 高级过滤 status/type/date/tag | API 已有 `apiFetch` 模式可参考 |
| 24 | 列过滤语法 `title:foo` 前端解析 | FTS5 已支持 column filter |
| 25 | trigram 备表做 CJK 子串召回 | 二表并存，RRF 三路融合 |
| 26 | spellfix1 typo 容错 | 加一个 `search_aux` 表 |
| 27 | 搜索结果批量操作 | 选中状态 + 批量 update |
| 28 | MCP 输出加 `total` 字段 + `search_all` 工具 | 现有 `mcp-bridge.mjs` 缺 `search_notes` |

### 完整里程碑

- **里程碑 1**（第一波完成）：现有搜索体验显著提升，精准度翻倍 — **~6.5h**
- **里程碑 2**（第二波完成）：Provider 路径语义搜索全链路可用，用户开启后立即生效 — **~22h**
- **里程碑 3**（+ 本地模型）：完全离线语义搜索，无外部依赖 — **~27h**
- **里程碑 4**（长期演进）：进入 "专业级" 搜索水平 — 持续迭代

---

## 附录A：现有代码结构索引

### 后端

| 文件 | 用途 | 改动相关 |
|---|---|---|
| `server/src/db.ts` | SQLite schema + migration | 加 vec0/embedding_cache 表 |
| `server/src/services/searchService.ts` | `searchTasks()` 核心搜索 | 阶段 1 精准度改进 + hybridSearchTasks |
| `server/src/services/searchText.ts` | `htmlToPlainText()` 工具函数 | 落 plaintext 列时可复用 |
| `server/src/services/tokenizer.ts` | nodejieba 分词 | 改用 cutForSearch |
| `server/src/services/noteService.ts` | `searchNotes()` 笔记搜索 | 同样改造思路 |
| `server/src/services/llmService.ts` | `callChatCompletionsWithRaw()` | callEmbeddings 的模板 |
| `server/src/services/backgroundTaskService.ts` | 后台任务队列 | 加 'embedding' 类型 |
| `server/src/services/taskService.ts` | `indexTask` 调用点 | 加 indexTaskVector |
| `server/src/config.ts` | LLM 配置 | 加 embeddingMode/embeddingModel |
| `server/src/index.ts` | HTTP API 路由 | 在 `/api/search` 加 `hybrid` 参数；加 `test-embeddings` route |
| `server/src/mcp/mcp-bridge.mjs` | stdio MCP bridge | 加 `search_notes` 工具 |
| `server/src/mcp/start.ts` | HTTP MCP server | MCP search tools 升级 |
| `server/tsup.config.ts` | 打包配置 | 加 external: sqlite-vec |
| `server/package.json` | 依赖 | 加 `sqlite-vec`；可选：`@huggingface/transformers` |

### 前端

| 文件 | 用途 | 改动相关 |
|---|---|---|
| `web/src/App.tsx` | GlobalSearchDialog | 加高亮、键盘导航、计数 |
| `web/src/pages/BoardPage.tsx` | Board 内联搜索 | 加 searchJumpIntent、内容预览 |
| `web/src/pages/NotesPage.tsx` | Notes 搜索 | 搜索体验统一 |
| `web/src/pages/SettingsPage.tsx` | 设置 | 加语义搜索开关 |
| `web/src/lib/highlight.ts` | `highlightText`/`highlightHtml` | 在 GlobalSearchDialog 接入 |
| `web/src/lib/searchJump.ts` | searchJump 意图系统 | Board 搜索点击时调用 |
| `web/src/stores/taskStore.ts` | searchMode/doSearch | 加内容预览 state |
| `web/src/services/httpApi.ts` | searchTasks/searchAll/searchNotes | hybrid 参数 |
| `web/src/services/api.ts` | API 包装层 | hybrid 标志 |
| `web/src/types/index.ts` | SearchResult 等类型 | 可能加 rrfScore 等字段 |
| `web/src/shortcuts/registry.ts` | 快捷键注册 | 可能加 shortcut 打开搜索 |
| `web/src/index.css` | `.search-highlight` 样式 | 现有高亮 CSS 复用 |

### Tauri/Ops

| 文件 | 用途 |
|---|---|
| `tauri/tauri.conf.json` | Tauri 配置 — 加 dylib 到 `bundle.resources` |
| `server/scripts/with-node.sh` | Node 运行时管理 |

---

## 附录B：参考资料

### RRF 与混合搜索

- **原始 RRF 论文**: Cormack, Clarke, Büttcher (SIGIR 2009) "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods under Combining Rank-Based Retrieval Models"
- **Logseq 生产实现**: [logseq/logseq commit fd1906a](https://github.com/logseq/logseq/commit/fd1906a0c84135f30c34ae84a20876cc46057dbe) "feat: semantic search with zvec" — constants: `rrf-k=60`, `keyword-rrf-weight=1.25`, `vector-rrf-weight=1.0`
- **Logseq 向量搜索设计文档**: `docs/agent-guide/077-vector-embedding-context.md` — "Hybrid ranking should keep vector similarity as an auxiliary signal"
- **gbrain TypeScript RRF**: [garrytan/gbrain](https://github.com/garrytan/gbrain) — 含 post-fusion 阶段：normalize → boost → cosine re-score → backlink boost → dedup
- **ChatLab minimalist RRF**: [ChatLab/ChatLab](https://github.com/ChatLab/ChatLab) — 含 first-seen-order tiebreaker
- **retriv TypeScript library**: [skilld-dev/retriv](https://github.com/skilld-dev/retriv) — SQLite hybrid search 库
- **Obsidian Hybrid Search**: [dobryakov/obsidian-hybrid-search](https://github.com/dobryakov/obsidian-hybrid-search) — 3-way parallel retrieval + Cross-encoder reranking with bge-reranker-v2-m3
- **vault-search** (Obsidian fork): [mzazon/vault-search](https://github.com/mzazon/vault-search) — query expansion: 2× weight on original query
- **SIGIR 2023 fusion paper**: "An Analysis of Fusion Functions for Hybrid Retrieval" — CC (weighted sum) 超过 RRF on in-domain，但需要评估数据调 α

### sqlite-vec

- **官方文档**: https://alexgarcia.xyz/sqlite-vec/
- **JS 文档** (better-sqlite3 集成): https://alexgarcia.xyz/sqlite-vec/js.html
- **vec0 虚拟表**: https://alexgarcia.xyz/sqlite-vec/vec0.html
- **API 参考**: https://alexgarcia.xyz/sqlite-vec/api-reference.html
- **GitHub**: https://github.com/asg017/sqlite-vec
- **npm**: https://www.npmjs.com/package/sqlite-vec
- **Alex Garcia 混合搜索博文**: https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html
- **v0.1.10-alpha DiskANN**: https://github.com/asg017/sqlite-vec/issues/25
- **旧版 sqlite-vss** (已废弃): https://github.com/asg017/sqlite-vss

### 本地嵌入模型

- **Transformers.js**: https://huggingface.co/docs/transformers.js
- **bge-small-zh-v1.5 (Xenova)**: https://huggingface.co/Xenova/bge-small-zh-v1.5
- **multilingual-e5-small (Xenova)**: https://huggingface.co/Xenova/multilingual-e5-small
- **gte-small (Xenova)**: https://huggingface.co/Xenova/gte-small
- **C-MTEB 中文基准**: https://github.com/FlagOpen/FlagEmbedding/blob/master/C_MTEB/README.md
- **APSW fts5aux** (参考 rank 函数实现): https://rogerbinns.github.io/apsw/_modules/apsw/fts5aux.html

### FTS5 高级技巧（参见第一波改进）

- **SQLite FTS5 官方文档**: https://www.sqlite.org/fts5.html
  - §5.1.1 bm25() 函数和列权重
  - §5.1.2-5.1.3 highlight() 和 snippet()
  - §4.2 prefix 索引
  - §3.5 NEAR 查询
  - §6.11 rank 配置选项
  - §6.8-6.9 merge 命令（增量优化）
- **spellfix1 扩展**: https://sqlite.org/spellfix1.html
- **trigram tokenizer**: https://www.sqlite.org/fts5.html#the_trigram_tokenizer
- **CJK FTS5 Trigram + Hybrid 策略**: https://zenn.dev/kanseilink/articles/kanseilink-fts5-trigram-cjk-20260507
- **React Native FTS5 input handling**: https://dev.to/sathish_daggula/react-native-offline-first-instant-search-in-sqlite-35kd
- **Anamnesis CJK pre-tokenization pattern**: https://github.com/Trapezohe/Anamnesis/commit/9249065da7d4f3d72b0cb997365b5765c8954a0d
- **wangfenjin/simple jieba tokenizer**: https://www.wangfenjin.com/posts/simple-jieba-tokenizer/
- **better-trigram**: https://github.com/streetwriters/sqlite-better-trigram
- **FTS5 索引结构深度剖析**: https://darksi.de/13.sqlite-fts5-structure/
- **indutny FTS5 合并算法说明**: https://gist.github.com/indutny/ae44fd93dde2736205609d19a21b87cc
- **FTS5 bulk-load 优化研究**: https://github.com/mihaela-mj/cupertino/commit/9b9e6b79224d0e0130aa5f343932eea7ca08f9ab

### Tauri / better-sqlite3 分发

- **Tauri 资源打包**: https://tauri.app/v1/guides/distribution/file-resources/
- **better-sqlite3 codesigning issue #1110**: https://github.com/WiseLibs/better-sqlite3/issues/1110 — `disable-library-validation` entitlement 是关键
- **episodic-memory bundling issue**: https://github.com/obra/episodic-memory/issues/4 — `--external:sqlite-vec` 的来源
- **Midswirl SQLite-vec walkthrough**: https://www.midswirl.com/blog/road-to-sqlite-vec-exploring-sqlite-as-a-rag-vector-database