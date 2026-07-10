# Chronicle 搜索增强：调查结论与实施计划

> **状态**：调查完成，方案已决策，待按阶段实施<br>
> **调查日期**：2026-07-10<br>
> **代码基线**：`main@70cd9e8`（Chronicle 2.2.5）<br>
> **目标读者**：接手实现的 agent / 开发者<br>
> **前置阅读**：`README.md`、`AGENTS.md`

---

## Agent 快速开始

阅读路线：先读本节，再读“已完成能力”“旧方案纠正”“已锁定决策”和“完整实施顺序”；开始具体
commit 时只需展开对应 Phase 的数据模型、接口和验收小节。调查细节保留在前半部分，供遇到设计疑问时
回查，不要求实现前逐字重读。

不要从旧版本文档的任务清单逐项实现。调查确认其中一部分已经在
`dd8fec0 Improve search indexing and result navigation` 完成，另一部分的技术设计与当前
架构不兼容。

正确推进顺序：

1. 先修复当前 Notes 新建/自动保存竞态，使现有搜索相关回归稳定全绿。
2. 建立统一 `search_documents + search_fts`，删除搜索请求中的全表扫描和混合 rank。
3. 在统一搜索核心之上补齐 Global / Board / Notes 的高亮、键盘导航、计数和精确跳转。
4. Phase 1 验收通过后，再接 Provider embedding、可靠后台索引和 RRF 混合搜索。
5. 首版语义搜索只实现 OpenAI-compatible Provider，覆盖任务标题、task entries 和 notes；
   不实现内置 Transformers.js 模型。

开始实现前必须知道的五件事：

- Task ID 是用户需要的搜索能力，必须保留，不能按旧方案删除。
- Chronicle 桌面端始终通过 HTTP 连接独立安装的 Node server；`sqlite-vec` 属于 server npm 包，
  不属于 Tauri `.app` resources。
- 现有 FTS 内容是 nodejieba 预分词后的字符串，不能直接拿 FTS `snippet()` 当可读摘要。
- `backgroundTaskService` 目前是后台任务状态登记器，不是一个能恢复 payload 的 durable queue。
- 语义结果也必须能落到具体 task entry 或 note 内容，不能只返回一个 task 级向量结果。

### 第一批应打开的文件

- `server/src/services/searchService.ts`
- `server/src/services/noteService.ts`
- `server/src/services/tokenizer.ts`
- `server/src/db.ts`
- `server/src/index.ts`
- `web/src/App.tsx`
- `web/src/pages/BoardPage.tsx`
- `web/src/pages/NotesPage.tsx`
- `web/src/lib/searchJump.ts`
- `tests/data-integrity.test.ts`
- `tests/notes.test.ts`

---

# 第一部分：调查结果

## 1. 调查范围与验证方式

本次调查不是只阅读旧方案，而是与当前 `main` 的实现逐项比对，覆盖：

- FTS schema、tokenizer、任务与笔记索引写入路径。
- `/api/search` 的 tasks / notes / all 三种 scope。
- Global Search、Board 内联搜索、Notes 搜索及 jump/highlight 消费链路。
- HTTP MCP、stdio MCP、Node server 构建发布和 Tauri 连接方式。
- 当前搜索相关 Playwright 基线。
- `sqlite-vec@0.1.9` 在当前 Node 25 + `better-sqlite3@12.9.0` 下的实际加载和 schema 创建。

调查时工作树为 clean，`main` 与 `origin/main` 一致。

### 当前测试基线

执行：

```bash
./scripts/with-node.sh npx playwright test \
  tests/data-integrity.test.ts \
  tests/notes.test.ts \
  tests/search-done-detail.test.ts
```

调查期间完整运行分别出现过 **27 passed / 1 failed** 和 **28 passed**；该用例属于现有 flaky
baseline，而不是稳定失败。失败项：

```text
Notes page creates and autosaves a note
```

单独重复三次后为 **1 passed / 2 failed**，独立 `--repeat-each=10` 复核为 **7 passed / 3 failed**。
失败截图显示标题变成：

```text
Untitled noteUiNote-<timestamp>
```

这不是 FTS 召回本身的问题，而是新建 note 后 route、active note 和 draft 初始化之间存在竞态；
UI 已显示 `saved`，但保存的是被重复初始化后的标题。它必须作为 Phase 0 修复，否则后续搜索回归没有
稳定基线。

---

## 2. 当前真实架构

### 2.1 后端搜索

当前有两个 FTS5 表：

```text
tasks_fts(task_id, entry_id, source, content)
notes_fts(note_id, source, content)
```

两表都使用 `unicode61`。中文和技术文本先由 TypeScript `tokenize()` 预分词，再把以空格连接的
token 字符串写进 FTS。

`searchTasks()` 当前流程：

1. FTS5 MATCH，按默认 `f.rank` 排序。
2. 扫描全部 task title，在 JS 中做大小写不敏感 `includes()`。
3. 扫描全部 task entries，每次把 HTML 转 plain text 后做 `includes()`。
4. 多 token 查询再重复扫描 title 和 entries，要求所有 token 都出现。
5. 用 `tags LIKE '%query%'` 补召回。
6. 把 `-1.0`、`-0.5`、`0.5` 和 FTS BM25 原始值混在一起排序。
7. `bestPerTask` 每个 task 只保留一个 hit。

`searchNotes()` 同样先走 FTS，然后扫描全部 notes，对 title、序列化 tags 和每次转换后的 plain text
做 substring fallback。

因此当前主要性能问题仍然存在：请求时间与 task / entry / note 总量线性相关，并且 HTML 清洗在
查询时重复执行。

### 2.2 前端搜索入口

| 入口 | 当前行为 | 已有能力 | 仍缺失 |
|---|---|---|---|
| Board `Cmd+F` | 输入后按 Enter 搜索 | 标题 token 高亮、上下选择 | 即时搜索、entry 摘要、精确 entry jump |
| Global `Cmd+Shift+F` | 180ms debounce | task / entry / note 分组、点击后精确跳转 | 结果内高亮、Arrow/Enter、分组计数 |
| Notes 搜索框 | 250ms debounce | 搜 note title/body | 与统一搜索的排序和交互一致性 |

Global Search 点击 task entry 时已经携带 `entryId`。Task workspace 和 Notes page 会消费一次性的
`SearchJumpIntent`，RichEditor 用 ProseMirror decorations 做只读高亮，不会把 `<mark>` 写回 HTML。

### 2.3 API 与 MCP

- `/api/search` 已支持 `scope=tasks|notes|all` 和 `includeArchived`。
- HTTP MCP 已有 `search_tasks`、`search_notes`。
- stdio bridge 只有 `search_tasks`，没有 `search_notes` 和 `search_all`。
- HTTP API 的 `total` 目前只是返回数组长度，不代表 limit 之前的真实匹配数。

### 2.4 运行与分发

`web/src/services/api.ts` 明确规定所有环境都走 HTTP API；旧的 embedded sql.js path 已停用。
Tauri 只从配置读取 Node server URL，并不在 Rust/Tauri 进程内打开 Chronicle SQLite 数据库。

发布流程：

1. `server/tsup.config.ts` 构建 Node server。
2. `publish.js` 把 server dist、public、MCP bridge 和 production dependencies 组装为 npm 包。
3. `npm install -g` 安装并运行独立的 Chronicle Node server。
4. Tauri app 通过 HTTP 连接该 server。

因此任何 SQLite extension 都应作为 server npm dependency 被安装和加载。旧方案中把 `vec0.dylib`
复制到 `tauri.conf.json` resources、从 `process.resourcesPath` 加载、修改 Tauri library validation 的
设计均不适用于当前 Chronicle 架构。

---

## 3. 已经完成、必须保留的能力

以下内容已由 `dd8fec0` 实现，不应重复或回滚：

1. **技术 ASCII token 单独提取**
   - ID、URL、path、package-like token、带数字单词不再交给 nodejieba 拆成单字母。
   - 当前正则：`/[a-z0-9]+(?:[._:/@+-][a-z0-9]+)*/g`。

2. **索引前 HTML 纯文本化**
   - task entries 和 notes 通过共享 `htmlToPlainText()` 处理。
   - `<code>`、`<p>` 等标签名不再成为搜索噪声。

3. **Task ID 可搜索**
   - task FTS row 中包含 task ID。
   - 这是有意加入的产品能力，不是应删除的噪声。

4. **精确 entry 定位元数据**
   - `SearchResult` 已返回 `entryId`。

5. **Global Search 跳转并高亮**
   - sessionStorage one-shot intent + `chronicle:search-jump` window event。
   - task entry 可滚动到具体 entry；note 内容用 ProseMirror decoration 高亮。

6. **FTS 版本化重建**
   - 当前 `CURRENT_TOKENIZER_VERSION = '4'`。
   - tokenizer 变化会重建 task 和 note FTS。
   - `db.ts` 已兼容旧 contentless `notes_fts`，避免启动时 DELETE 失败。

7. **相关回归覆盖**
   - 中文多 token。
   - OAuth2、react-native、node_modules、URL、task ID。
   - HTML tag 噪声。
   - 短英文 `AI` 不命中 `repair/pair/stairs`。
   - Global Search 打开 DONE task、note body 和 task entry。

---

## 4. 经代码确认仍存在的问题

### P0：必须在 Phase 1 解决

1. **tasks 和 notes fallback 都会全表扫描。**
2. **默认 BM25 无字段权重，且现有 schema 没有独立 title/content/tag 字段。**
3. **人工 rank 和负数 BM25 直接混排，排序不可解释。**
4. **查询时重复 HTML 纯文本化。**
5. **每个 task 只保留一个 hit，Global Search 无法展示同 task 的多个 entry 命中。**
6. **Global Search 结果不高亮、没有键盘导航和 section counts。**
7. **Board 仍是 Enter-to-search，entry hit 没摘要，也没把 entryId 写入 jump intent。**
8. **Notes 新建/自动保存竞态导致当前搜索测试不稳定。**

### P1：与 Phase 1 一并完成

1. 当前 tokenizer 丢弃所有单字符 token，并只放行少数两字母英文，导致 `js`、`ts` 等无法搜索。
2. FTS 没有 prefix index；即使添加 prefix index，当前查询也没有生成 `token*`。
3. tags 使用序列化 JSON substring，而不是独立索引字段和 exact-tag 排序信号。
4. snippet 固定从正文开头截取，未围绕命中位置。
5. stdio MCP 缺 notes/all 搜索，HTTP/stdio 能力不一致。
6. 异步搜索只用 UI boolean 忽略结果，未取消请求；快速输入时仍会制造无用后端负载。

### 暂不作为当前里程碑的问题

- 搜索历史。
- status/type/date 高级过滤语法。
- trigram 备表。
- spellfix1。
- NEAR/phrase 高级语法。
- 批量操作。
- attachments / work sessions / day scripts / agent conversations 索引。

这些功能只有在统一搜索文档层和相关性评测稳定之后才有安全的落点。

---

## 5. 旧方案中必须纠正的结论

| 旧方案 | 调查结论 |
|---|---|
| 删除 task ID 索引 | 不采用。ID 搜索已被明确实现并有测试，应放入独立高权重 identifier 字段。 |
| `bm25(tasks_fts, 3,0,1,1.5)` 可提高标题权重 | 不成立。当前列是 task_id / entry_id / source / content，没有 title 列；必须先改 schema。 |
| 加 `prefix='2 3 4'` 即可即时前缀搜索 | 不完整。查询端必须安全地产生最后一个 token 的 `*`。 |
| 使用 FTS `snippet()` 返回可读上下文 | 不采用。FTS 保存的是预分词 token 串，会显示不自然的空格；摘要应来自原始纯文本。 |
| index/query 都改 `cutForSearch` 后直接加 NEAR | 暂不采用。预分词的重叠 token 会改变 token position 语义，先只用于召回。 |
| 每个 task 一个向量 | 不采用。会丢失具体 entry/note hit，破坏“高亮并定位”。 |
| `void indexTaskVector()` 即可非阻塞增量索引 | 不采用。并发请求可能让旧 embedding 后写覆盖新内容，也无法在进程重启后恢复。 |
| `backgroundTaskService` 已是后台队列 | 不准确。它持久化状态，但不持久化可恢复的 embedding job payload。 |
| embedding model 缺省复用 chat model | 不采用。chat model 通常不能调用 embeddings，必须显式配置。 |
| vec0 固定 512 维并在模型变化时 drop/rebuild | Provider 维度不固定。首版使用普通 BLOB + sqlite-vec cosine function，profile 记录维度。 |
| sqlite-vec dylib 放进 Tauri resources | 不采用。扩展随独立 Node server npm 包分发。 |
| 动态 import Transformers.js，但不加 dependency | 不可发布。首版直接不实现内置模型。 |
| BGE 索引和查询都加中文 instruction | 错误。BGE model card 说明 instruction 只加 query，不加 passage；本地模型已延期。 |
| searchJump 10 秒 TTL 导致用户在结果里停留后失效 | 不成立。intent 在点击时才创建，并立即由目标页面消费。 |

---

## 6. 外部技术核验结论

### SQLite FTS5

- BM25 支持按列传权重。
- prefix index 只优化带 `*` 的 prefix query。
- UNINDEXED 列不会进入倒排索引，适合保存 doc key。
- 当前预分词设计下，原始文本和索引 token 必须分开保存。

参考：<https://www.sqlite.org/fts5.html>

### sqlite-vec

- 截至调查时最新 stable 为 `0.1.9`，项目仍是 pre-v1，必须精确 pin 版本。
- 已在临时目录验证 `sqlite-vec@0.1.9 + better-sqlite3@12.9.0`：
  - `sqliteVec.load(db)` 成功。
  - `vec_version()` 返回 `v0.1.9`。
  - TEXT PRIMARY KEY 和 FLOAT vector schema 可创建。
- npm 包通过 platform optional dependency 安装对应 dylib；Chronicle 发布脚本会把 production dependencies
  带进 Node server npm artifact。

参考：

- <https://alexgarcia.xyz/sqlite-vec/js.html>
- <https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9>

### Provider embeddings

- Ollama 的 OpenAI compatibility 当前支持 `/v1/embeddings`，input 可为字符串或字符串数组。
- 仍必须配置真正的 embedding model，不能把默认 `qwen2.5:7b` chat model 当 embedding model。

参考：<https://docs.ollama.com/api/openai-compatibility>

---

# 第二部分：作为结论的实施计划

## 7. 已锁定的产品与技术决策

| 决策 | 结论 |
|---|---|
| 交付方式 | 两阶段：关键词/交互先交付，Provider hybrid 后交付。 |
| 搜索范围 | task title、task body/log/pinned、notes title/content/tags。 |
| Task ID | 保留并作为最高权重 identifier。 |
| 关键词索引 | 统一 `search_documents + search_fts`。 |
| 结果粒度 | 核心返回 document hit；Board 再按 task 聚合。 |
| 语义粒度 | task title 和每个 entry/note 的内容 chunks，不做 task-only vector。 |
| Embedding v1 | OpenAI-compatible Provider；显式 embedding model；默认关闭。 |
| 本地模型 | 不在当前计划内；本机 Ollama 走 Provider 路径。 |
| 向量存储 | 普通 SQLite BLOB + sqlite-vec cosine function。 |
| 混合排序 | keyword + vector 的 RRF，精确 ID/title 在 RRF 之前固定优先。 |
| 失败策略 | semantic disabled/building/error/timeout 时完整降级到 keyword。 |
| 分发 | sqlite-vec 随 Node server npm 包；Tauri 无资源或 entitlement 改动。 |

---

## 8. Phase 0：先获得可信基线

### 8.1 修复 Notes draft 初始化竞态

目标：`saved` 只在当前用户可见 draft 的相同 revision 已持久化后出现。

实现要求：

1. `applyNoteDraft()` 只在 note ID 真正变化时初始化一次。
2. `handleCreateNote()`、URL effect 和 `activeNote` effect 不得对同一 note 重复初始化 draft。
3. title/tags 的 ref 在 input `onChange` 中同步更新，不能只等待 React effect。
4. save 操作串行化并携带 local revision；旧 save response 不得覆盖更新的 draft 或把状态标成 `saved`。
5. note 切换前继续 flush 当前 draft，但 stale `setActiveNote()` response 不能切回旧 note。

验收：

- 现有 autosave test `--repeat-each=10` 全绿。
- 新增“创建后立即改标题并输入正文”回归，API title 必须与 input 完全一致。
- 新增“连续快速改标题”回归，最终保存值必须等于最后一次输入。

### 8.2 锁定相关性 fixture 和 benchmark 规格

Phase 0 先锁定以下数据和 expected ordering；可执行的 `tests/search-relevance.test.ts` 与 benchmark
在统一索引完成的 Commit B 一起提交，避免 Commit A 引入注定失败的测试。fixture 固定创建互相竞争的
task / entry / note 数据，验证：

- 完整 ID > title exact > title token > exact tag > content exact > 其他 FTS。
- `neo4j` 的 title 精确命中排在只在长正文中出现的 task 前。
- 一个 task 的多个 entry hit 在 Global Search 都可见，Board 只显示一个聚合 task 并显示 hit count。
- 中文、英文、技术 token、HTML、archived scope 的原有行为不回退。

新增独立 benchmark 脚本，用临时 DB 生成约 4 万 search documents；它不进入每次 CI，但必须作为
Phase 1 验收运行并记录结果。

---

## 9. Phase 1：统一关键词索引和搜索体验

### 9.1 数据模型

在 `server/src/db.ts` 增加：

```sql
CREATE TABLE search_documents (
  doc_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('task', 'task_entry', 'note')),
  task_id TEXT,
  entry_id TEXT,
  note_id TEXT,
  source TEXT NOT NULL,
  identifier_text TEXT NOT NULL DEFAULT '',
  title_text TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE INDEX idx_search_documents_kind
  ON search_documents(kind);
CREATE INDEX idx_search_documents_task
  ON search_documents(task_id);
CREATE INDEX idx_search_documents_note
  ON search_documents(note_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  doc_key UNINDEXED,
  identifier,
  title,
  content,
  tags,
  tokenize = 'unicode61',
  prefix = '2 3 4'
);
```

`doc_key` 格式固定：

```text
task:<taskId>
entry:<entryId>
note:<noteId>
```

写入规则：

- task document：identifier = task ID，title = task title，tags = task tags，content 为空。
- task entry document：task_id + entry_id + source，content 为一次性清洗后的 plain text；title 为空，
  展示时 join parent task title；`updated_at` 使用 entry 的 `created_at`。
- note document：identifier = note ID，title/content/tags 分字段保存。
- `search_documents` 保存原始可读纯文本；`search_fts` 保存对对应字段调用 `tokenize()` 后的 token 串。

`content_hash` 固定为以下 UTF-8 字符串的 SHA-256 hex：

```text
kind + "\0" + identifier_text + "\0" + title_text + "\0" + content_text + "\0" + canonical_tags_json
```

`canonical_tags_json` 是 trim 后、保持业务数据顺序的 JSON array；所有空值写为空字符串/空数组，保证
rebuild 和 incremental indexing 得到相同 hash。

新增共享服务，职责固定为：

```text
upsertTaskSearchDocument
upsertTaskEntrySearchDocument
upsertNoteSearchDocument
removeSearchDocument
removeTaskSearchDocuments
rebuildSearchIndex
```

task/note source write和搜索文档写入必须在同一 better-sqlite3 transaction 内完成。不能先提交业务数据，
再用 fire-and-forget 更新关键词索引。

### 9.2 迁移

使用新的 `_meta.search_index_version = 1`，不要继续让所有结构变化只依赖 tokenizer version。

启动迁移顺序：

1. 检查 `search_documents/search_fts` 是否存在且列形状正确。
2. 不兼容则 drop 新搜索表并重新创建。
3. 在 transaction 中从 tasks / task_entries / notes 重建。
4. 写入 `search_index_version=1`。
5. 新索引可查询后，删除不再使用的 `tasks_fts/notes_fts`。

迁移必须同时替换所有 legacy hooks，不能只换搜索读路径：

- `taskService.ts` 和 `meetingService.ts` 的 `indexTask/indexEntry/remove*` 调用。
- `noteService.ts` 的 note FTS 写入、删除和 rebuild。
- `appService.ts` 暴露的旧 note rebuild wrapper。
- `/api/search/rebuild`，改为只调用统一 `rebuildSearchIndex()`。
- server startup 的 `CURRENT_TOKENIZER_VERSION` task/note 双 rebuild，改为统一 search index version 检查。

完成以上替换、验证没有旧 symbol/table 引用后，才允许 drop `tasks_fts/notes_fts`。

必须有从以下历史状态启动的测试：

- 没有搜索表。
- 旧 `tasks_fts` 无 `entry_id`。
- 旧 contentless `notes_fts`。
- tokenizer version 3/4，但没有统一 search index。

### 9.3 Tokenizer 与 query builder

保留当前 technical token 正则，并作以下调整：

1. 中文索引/查询统一使用 `nodejieba.cutForSearch()`。
2. 不再维护两字母 allowlist；`js`、`ts`、`db` 等作为完整 token。
3. 单字符字母/数字允许作为完整 token，但绝不走 substring LIKE。
4. 去重时保持 token 首次出现顺序。
5. FTS query 的每个 token 都必须安全转义。
6. 始终先构造完整 token 的 exact query；最后一个 ASCII token 长度至少 2 时，再构造一条
   `"token"*` 的 supplemental prefix query。
7. exact/prefix query 内的其他 token 都使用 AND 语义；本阶段不暴露用户自定义 FTS 运算符。

返回给前端高亮的 tokens 使用原查询中可读 token，不使用加 `*` 后的 FTS 表达式。

### 9.4 召回与排序

删除当前 Phase 2/3 全表 fallback 和 tags LIKE。

查询过程固定为：

1. exact FTS query 先召回 candidates；符合条件时再用 prefix query 补召回。两路合并后最多保留
   `min(limit * 4, 400)` 个 documents，并记录 `exactFtsHit/prefixOnly`，exact hit 永远优先于仅 prefix hit。
2. 使用 `bm25(search_fts, 0, 8, 5, 1, 3)`；`doc_key` 权重为 0，identifier/title/content/tags
   依次为 8/5/1/3。
3. join `search_documents` 取得原始文本和 scope 元数据。
4. 只在 candidates 上计算精确特征，不扫描全库。
5. 用确定性 tuple 排序：

```text
identifierExact DESC
titleExactPhrase DESC
exactFtsHit DESC
titleHasAllTokens DESC
tagExact DESC
contentExactPhrase DESC
bm25 ASC
updatedAt DESC
docKey ASC
```

6. snippet 从 title/content 原文中第一个命中位置向前后扩展，总长不超过 240 字；没有 literal 命中时
   使用正文开头。
7. 搜索核心返回 document hits，不在 service 内按 task 去重。
8. `counts/total/matchCount` 使用独立的 FTS COUNT/GROUP 查询计算，不能从最多 400 个排序 candidates
   推算。exact 与 prefix 两路按 doc_key UNION 去重后计数。

Board adapter 按 task ID 取最佳 hit，返回：

- 最佳 entryId/source/snippet。
- `matchCount`。
- task metadata。

Board 为满足 task-group limit，应按排名分批读取 document hits，直到得到 limit 个 distinct task 或达到
400 个 candidate 上限；不能只裁剪前 limit 个 documents 后再分组。

Global Search 保留 task、task_entry、note 三种独立 hits；同 task 的多个 entry 可以同时出现。

limit 语义固定：

- `scope=all`：limit 是统一排序后的全局 hit 上限，裁剪后再按三类分 section。
- `scope=notes`：limit 是 note hit 上限。
- 默认 task/Board scope：limit 是聚合后的 task 数上限；`matchCount` 是该 task 在 limit 前命中的
  document 数。

### 9.5 API 和类型

保留现有 `/api/search` query 参数和响应大结构，所有变化尽量 additive。

新增通用字段：

```ts
type SearchRetrieval = 'keyword' | 'semantic' | 'hybrid'

interface SearchHitMeta {
  hitId: string
  snippet: string
  matchCount: number
  retrieval: SearchRetrieval
  exactMatch: boolean
  rank: number
  semanticAnchor?: {
    documentHash: string
    startOffset: number
    endOffset: number
    anchorText: string
  }
}

interface SearchCounts {
  tasks: number
  taskEntries: number
  notes: number
}
```

`scope=all` 响应增加：

```ts
{
  results: { tasks, taskEntries, notes },
  tokens,
  counts,
  total,              // limit 前的真实 hit 总数
  retrievalMode,      // Phase 1 固定 keyword
  semanticStatus      // Phase 1 固定 disabled
}
```

旧字段 `taskId/entryId/noteId/matchType/matchedOriginal/tokens` 保留，避免前端和 MCP 一次性破坏。
Phase 2 时，`GET /api/notes/:id` 返回的 Note 增加只读 `searchContentHash`，由 server 使用与
`search_documents.content_hash` 完全相同的 builder 计算；它不写入 notes table。NotesPage 用它判断搜索
结果 offsets 是否仍对应当前内容，避免前端重复实现 server 的 HTML normalization/hash 算法。

### 9.6 Global Search

在 `web/src/App.tsx`：

1. title 和 snippet 都用 `highlightText()`。
2. section 标题显示真实 counts。
3. 将三组结果映射成一个 flattened selection list。
4. ArrowUp/Down 循环选择，Enter 打开，Escape 关闭。
5. 选中项使用可见样式、`aria-selected`，并 `scrollIntoView({ block: 'nearest' })`。
6. query 或结果变化时把 selection 重置为第一项。
7. 关闭后把焦点还给打开搜索前的元素。
8. 对请求使用 AbortController 或 request sequence，旧响应不得覆盖新 query。

点击后继续使用现有 `setSearchJumpIntent()`；task entry 必须携带 entryId，note 必须携带 matchedSource。

### 9.7 Board 搜索

1. 从 Enter-to-search 改为与 Global 一致的 180ms debounce。
2. 保留上下选择快捷键。
3. 结果卡增加围绕命中的 snippet 和 `×N hits`。
4. click/Enter 时先写 search jump intent，再 `setActiveTask()`。
5. entry hit 打开后滚动到具体 entry 并高亮；title hit 聚焦标题区域。
6. Escape 退出搜索后恢复原 task，并把焦点还给 Board 搜索触发点。

### 9.8 Notes 搜索

Notes 列表仍只展示 note，但必须复用统一后端排序和 snippet。debounce 统一为 180ms，旧 response
不能覆盖新 query。Global Search 打开 note 时继续使用 ProseMirror decoration，不修改 note HTML。

### 9.9 MCP parity

stdio bridge 增加：

- `search_notes(query, limit?, includeArchived?)`
- `search_all(query, limit?, includeArchived?)`

HTTP MCP 的 `search_notes` 增加 `includeArchived`。所有工具直接复用统一 search service/API 语义，返回
`total/counts`，不得单独实现另一套搜索排序。

### 9.10 Phase 1 验收门槛

功能：

- 旧搜索测试和新 relevance tests 全绿。
- Global Search 结果高亮、键盘操作、分组计数可用。
- Board 从 entry hit 打开后准确滚动并高亮。
- task ID、中文、AI/JS/TS、URL/path、tags、notes 都有确定性结果。
- 同 task 多 entry hit 在 Global 可见，Board 显示聚合次数。

性能：

- 搜索 request path 不再执行 `SELECT all tasks/entries/notes` 后 JS filter。
- 4 万 search documents 的 warm keyword P95 < 150ms。
- query 时不调用全库 `htmlToPlainText()`。

构建与回归：

```bash
./scripts/with-node.sh npm --prefix server run build
./scripts/with-node.sh npm --prefix web run build
./scripts/with-node.sh npx playwright test \
  tests/search-relevance.test.ts \
  tests/data-integrity.test.ts \
  tests/notes.test.ts \
  tests/search-done-detail.test.ts
```

Phase 1 未满足以上门槛前，不开始 Phase 2。

---

## 10. Phase 2：Provider 语义搜索与 Hybrid RRF

### 10.1 配置

扩展 `ChronicleConfig.llm`、Settings API 和前端 `LlmSettings`：

```ts
semanticSearchEnabled: boolean   // default false
embeddingModel: string           // default ''，enabled 时必填
```

首版复用已有：

```text
llm.baseUrl
llm.apiKey
llm.timeoutMs
```

环境变量：

```text
CHRONICLE_SEMANTIC_SEARCH_ENABLED
CHRONICLE_LLM_EMBEDDING_MODEL
```

规则：

- 不允许 enabled=true 且 embeddingModel 为空。
- 不自动把 `llm.model` 当 embedding model。
- Settings 启用前先测试 embedding endpoint。
- 非 localhost/127.0.0.1 base URL 必须显示“内容会发送给该 Provider”的确认提示。
- API key 继续沿用现有脱敏返回策略，不写日志。

### 10.2 sqlite-vec 加载与发布

在 `server/package.json` 精确依赖：

```json
"sqlite-vec": "0.1.9"
```

在 `server/tsup.config.ts` external 中加入 `sqlite-vec`。DB 初始化时：

1. 尝试 `sqliteVec.load(db)`。
2. 验证 `vec_version()`。
3. 加载失败只把 semantic status 设为 error；keyword search 和 server 启动必须继续工作。

不要修改：

- `tauri/src-tauri/tauri.conf.json` resources。
- Tauri entitlements。
- `process.resourcesPath`。

发布验证必须走 `publish.js` 生成的 npm artifact：先确认 `npm pack` tarball 声明了 `sqlite-vec`
dependency，再把 tarball 安装到临时 prefix，确认安装阶段解析出的 platform optional package 可被 server
实际加载。

### 10.3 向量数据模型

首版不使用固定维度 vec0 table。增加普通表：

```sql
CREATE TABLE semantic_profiles (
  profile_hash TEXT PRIMARY KEY,
  base_url_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  index_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'ready_with_errors', 'error')),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE embedding_cache (
  profile_hash TEXT NOT NULL,
  chunk_input_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(profile_hash, chunk_input_hash),
  FOREIGN KEY(profile_hash) REFERENCES semantic_profiles(profile_hash) ON DELETE CASCADE
);

CREATE TABLE search_embedding_chunks (
  profile_hash TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  document_hash TEXT NOT NULL,
  chunk_input_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  anchor_text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile_hash, doc_key, chunk_index),
  FOREIGN KEY(profile_hash) REFERENCES semantic_profiles(profile_hash) ON DELETE CASCADE,
  FOREIGN KEY(doc_key) REFERENCES search_documents(doc_key) ON DELETE CASCADE
);

CREATE TABLE semantic_index_jobs (
  profile_hash TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile_hash, doc_key),
  FOREIGN KEY(profile_hash) REFERENCES semantic_profiles(profile_hash) ON DELETE CASCADE,
  FOREIGN KEY(doc_key) REFERENCES search_documents(doc_key) ON DELETE CASCADE
);
```

`profile_hash` 必须包含：规范化 base URL、embedding model、dimensions、chunk/index version；不包含
API key 明文。`document_hash` 对应 `search_documents.content_hash`；`chunk_input_hash` 对实际送给 Provider
的单个 chunk UTF-8 输入计算 SHA-256 hex，避免同一 document 的多个 chunks 在 cache 中互相覆盖。

### 10.4 Embedding service

新增 `embeddingService.ts`，Provider 请求规则：

```text
POST {baseUrl without trailing slash}/embeddings
Authorization: Bearer <apiKey>     // 非空时
body: { model: embeddingModel, input: string[] }
```

实现要求：

- response 必须校验 HTTP status、data 顺序、每个 embedding 类型和统一维度。
- rebuild batch size 固定 16；Provider 明确拒绝 batch 时可以降为 1，并记录 profile error/context。
- query embedding 使用最多 50 项的进程内 LRU。
- 每个 chunk embedding 优先用 `chunk_input_hash` 查 `embedding_cache`。
- timeout/abort/error 不得暴露 API key 或正文到日志。

新增测试端点：

```text
POST /api/settings/llm/test-embeddings
```

request body 使用尚未保存的 Settings draft：

```ts
{
  baseUrl: string
  apiKey: string
  embeddingModel: string
  timeoutMs: number
}
```

端点只验证这组临时参数，不落盘；字段缺失或类型错误返回 400。Settings UI 必须先用 draft 测试成功，
再保存并启用 semantic search。

返回：

```ts
{ ok: true, model: string, dimensions: number, latencyMs: number }
```

失败返回可操作错误，但不回显 secret。

### 10.5 Chunk 规则

基于 `search_documents` 的 plain text 生成 chunks：

- task title/tags：一个 document chunk。
- task entry：按内容块切分。
- note：title/tags 作为上下文，正文按内容块切分。
- 每 chunk 最多 400 Unicode code points。
- 相邻 chunk overlap 60 code points。
- 优先在换行/段落边界切分。
- `anchor_text` 保存该 chunk 开头最多 160 个规范化字符，用于 note 内定位。
- `start_offset/end_offset` 使用规范化 plain-text projection 的 UTF-16 code-unit offset；前后端必须使用
  同一 whitespace/newline normalization 规则。
- embedding 输入不超过 provider/model 已知限制；若 Provider 没提供限制，使用上述保守 chunk。

### 10.6 Durable indexing worker

不能在 `createTask/updateNote` 中直接 `void embed()`。

业务写入时：

1. transaction 内更新 `search_documents`。
2. 为 active profile UPSERT 一条 pending job，携带最新 document_hash。
3. 不删除旧 embedding，但查询时只允许 chunk document_hash 与当前 search document hash 一致，因此旧
   vector 自动失效。

单并发 worker：

1. server 启动时把遗留 `running` job 恢复为 `pending`。
2. 按 batch 取 pending jobs。
3. embed 前后都检查当前 `search_documents.content_hash` 是否仍等于 job document_hash。
4. 若内容已变，丢弃旧 response 并让最新 job 保持 pending。
5. transaction 写 cache/chunks；cache key 使用 chunk_input_hash，chunk row 同时写 document_hash 和
   chunk_input_hash。
6. source 删除时删除 job 和 chunks。
7. 最多重试 3 次，指数退避；超过后记录 error，但继续处理其他 documents。

job 成功写入后直接删除对应 `semantic_index_jobs` row；失败 row 保留 error/attempts 供 UI 和手动重建
诊断。全量 rebuild 的总进度由 `embedding_index` background task 记录，不依赖已删除的成功 job rows。
全部 documents 都失败时 profile=`error`，搜索 keyword-only；部分失败时 profile=`ready_with_errors`，
允许用成功 vectors 做 hybrid，同时在 status/progress 中显示失败数并允许重试。

扩展 `BackgroundTaskType`：

```text
embedding_index
```

增加 background task progress 更新能力；meta 至少包含 total/completed/failed/model，SSE UI 展示进度。

模型或维度变化时创建新 profile 并全量 enqueue。新 profile ready 前搜索只走 keyword；不要混用旧模型
向量。新 profile ready 后保留当前和上一个 ready profile 作为一次回滚余地，删除更旧 profiles，并依靠
foreign-key cascade 清理 cache/chunks/jobs。

### 10.7 Vector search 与 RRF

向量检索：

```sql
SELECT doc_key,
       chunk_index,
       anchor_text,
       vec_distance_cosine(embedding, ?) AS distance
FROM search_embedding_chunks
WHERE profile_hash = ?
  AND document_hash = (
    SELECT content_hash FROM search_documents d
    WHERE d.doc_key = search_embedding_chunks.doc_key
  )
ORDER BY distance
LIMIT ?;
```

先按 doc_key 保留 distance 最小的 chunk，再进入融合。

scope 与 `includeArchived` 必须在 keyword/vector 两条召回路径上同时生效。vector SQL 需要 join
`search_documents` 及必要的 source table，在 top-K 之前排除不属于当前 scope 的 documents 和 archived
notes，不能先占用 top-K 名额后再在应用层过滤。

RRF 固定参数：

```text
k = 60
keyword weight = 1.25
vector weight = 1.0
rank 使用 1-based
```

融合 key 为 `doc_key`，不是 task ID。否则同 task 的不同 entry 会再次被错误折叠。

排序顺序：

1. keyword 的 identifierExact/titleExactPhrase 固定置顶。
2. 其余结果按加权 RRF score 降序。
3. score 相同按 keyword rank、vector rank、doc_key 稳定排序。

每路取 `limit * 2`，融合后再裁剪到 limit。

semantic query 有独立 1500ms deadline。任一情况完整返回 keyword：

- semantic disabled。
- profile building/error。
- sqlite-vec 未加载。
- Provider timeout/error。
- query embedding 为空或维度不匹配。

传给 `vec_distance_cosine()` 的查询参数使用 `new Float32Array(queryEmbedding).buffer`，与
`sqlite-vec` 的 Node binding 约定一致。

### 10.8 Semantic API 与 UI

新增：

```text
GET  /api/search/semantic/status
POST /api/search/semantic/rebuild
```

搜索响应：

- `retrievalMode = keyword | hybrid`。
- `semanticStatus = disabled | building | ready | ready_with_errors | error | timeout`。
- 每个 hit 的 `retrieval = keyword | semantic | hybrid`。
- semantic-only hit 的 tokens 可以为空，但必须返回 snippet、doc key 和 best chunk anchor。

Settings：

- 开关、embedding model、测试连接、重建索引、状态/进度。
- enabled 但 building 时明确显示“关键词搜索仍可用”。

跳转：

- task entry semantic hit：按 entryId 滚动并闪烁整个 entry 容器；不要尝试高亮不存在的 query 词。
- task title semantic hit：打开 task 并闪烁标题区。
- note semantic hit：返回 documentHash、start/end UTF-16 offsets 和 anchor_text。加载后的 Note
  `searchContentHash` 与结果 documentHash 一致时，RichEditor 遍历 ProseMirror doc 构造同规范化
  projection 及 offset→ProseMirror-position mapping，用 offsets 装饰并滚动到精确范围。
- note hash 已变化时只能使用 anchor fallback；anchor 在当前 projection 中恰好唯一且上下文校验一致才
  高亮。零次或多次出现时只打开 note 并保留结果 snippet，不猜测位置。

### 10.9 Phase 2 验收门槛

自动测试：

- mock OpenAI-compatible embedding server：batch、维度、timeout、401、invalid JSON、乱序/缺项。
- cache hit 不重复请求 Provider。
- stale job response 不能覆盖新 content hash。
- server restart 可恢复 pending/running jobs。
- 删除 task/entry/note 清理 jobs/chunks。
- 模型变化新建 profile，ready 前 keyword-only。
- RRF 使用 1-based rank，权重和稳定 tie-break 正确。
- semantic failure 不改变 keyword 结果和 HTTP success。
- task entry / note semantic hit 精确定位。

质量评测：

- 建立至少 20 条中英文同义/概念查询与 expected doc keys。
- 选定 Provider 模型后 Recall@5 >= 80%。
- Phase 1 keyword golden set 零回退。
- exact task ID/title 不被弱 semantic hit 挤下第一名。

发布烟测：

1. `publish.js` 生成 npm artifact。
2. `npm pack` 只验证 tarball 中有正确 dependency declaration；再把 tarball 安装到临时 prefix，由 npm
   在安装阶段解析对应 platform optional package。
3. 从临时 prefix 安装后的 artifact 启动 Node server，使用隔离 config/DB。
4. 验证 `vec_version()`、embedding test、rebuild、hybrid search。
5. 启动 Tauri client 连接该 server；不依赖 repo `node_modules`。

---

## 11. 完整实施顺序与交接点

严格按以下顺序提交，避免一个超大不可审查 change：

1. **PR/Commit A — Baseline stability**
   - 修 Notes draft/save 竞态。
   - 新增只针对该竞态的稳定性回归。

2. **PR/Commit B — Unified keyword index**
   - search_documents/search_fts schema、迁移、事务性 indexer。
   - tokenizer/query builder、候选排序、snippet、多 hit。
   - 新增 relevance fixtures/tests 和 benchmark；不能在新索引实现前提交注定失败的排序断言。

3. **PR/Commit C — Search UX and MCP parity**
   - Global keyboard/highlight/counts。
   - Board instant search/snippet/jump。
   - Notes debounce 一致性。
   - stdio/HTTP MCP parity。
   - 完成 Phase 1 build/test/benchmark。

4. **PR/Commit D — Semantic infrastructure**
   - config、sqlite-vec load/package、profiles/cache/chunks/jobs。
   - Provider embedding service、测试连接、durable worker。

5. **PR/Commit E — Hybrid retrieval and semantic UX**
   - vector search、RRF、fallback。
   - Settings progress、semantic result/jump。
   - Phase 2 quality、failure 和 packaging 验收。

6. **PR/Commit F — Documentation closeout**
   - 把本文状态更新为实际完成状态。
   - 记录最终模型、benchmark、Recall@5 和验证命令结果。
   - 未完成项明确移动到 future work，不保留模糊“可能做”。

每个交接点都必须在 commit message/PR description 说明：

- 当前完成到哪个阶段。
- schema/index version。
- 实际执行的测试和结果。
- 是否需要重建索引。
- semantic 是否默认关闭以及 fallback 状态。

---

## 12. 非目标与后续方向

当前两阶段明确不包含：

- 内置 Transformers.js / ONNX 模型。
- trigram 第三路召回。
- spellfix1。
- 用户可写的 FTS5/NEAR/column-filter 语法。
- 搜索历史和 query suggestions。
- status/type/date UI filter。
- 搜索结果批量修改。
- attachments OCR/PDF、work sessions、day scripts、agent conversations 搜索。
- ANN / DiskANN。

未来增加这些能力时，必须复用 `search_documents` 的 doc key、scope、snippet、jump anchor 和评测框架，
不能再建立一套平行搜索实现。

---

## 13. 构建和环境注意事项

- 所有 Node/npm 命令使用 `./scripts/with-node.sh`，避免系统旧 Node 6。
- Playwright 已隔离 `CHRONICLE_CONFIG_DIR/CHRONICLE_CONFIG_PATH`；新增测试继续使用隔离 DB。
- localhost/127.0.0.1 请求必须设置 `NO_PROXY` 或使用 `curl --noproxy '*'`。
- 不运行 `npm run release`，除非用户明确要求完整 release；该脚本包含 `git checkout -- ...`。
- benchmark、Provider mock 和 packaging smoke 都使用临时目录，不读取或改写 `getDbPath()` 解析出的
  用户生产 DB。不要假设固定路径：配置可能指向 `~/.chronicle/data.db`，默认路径则是
  `~/.chronicle/data/tasks.db`。
- tokenizer/schema 变更后必须验证旧 `.dev-data/tasks-dev.db` 启动迁移，不只验证全新 DB。

---

## 14. 参考资料

### 当前 Chronicle 代码

- `server/src/services/searchService.ts`
- `server/src/services/noteService.ts`
- `server/src/services/searchText.ts`
- `server/src/services/tokenizer.ts`
- `server/src/services/backgroundTaskService.ts`
- `server/src/db.ts`
- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/mcp/mcp-bridge.mjs`
- `server/src/mcp/start.ts`
- `web/src/App.tsx`
- `web/src/pages/BoardPage.tsx`
- `web/src/pages/NotesPage.tsx`
- `web/src/components/TaskDetailWorkspace/index.tsx`
- `web/src/components/RichEditor/index.tsx`
- `web/src/lib/highlight.ts`
- `web/src/lib/searchJump.ts`
- `publish.js`
- `tests/data-integrity.test.ts`
- `tests/notes.test.ts`
- `tests/search-done-detail.test.ts`

### 外部资料

- SQLite FTS5：<https://www.sqlite.org/fts5.html>
- sqlite-vec Node：<https://alexgarcia.xyz/sqlite-vec/js.html>
- sqlite-vec v0.1.9：<https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9>
- sqlite-vec KNN / manual vector table：<https://alexgarcia.xyz/sqlite-vec/features/knn.html>
- Ollama OpenAI compatibility：<https://docs.ollama.com/api/openai-compatibility>
- BGE small zh model card：<https://huggingface.co/BAAI/bge-small-zh-v1.5>
- RRF 原始论文：Cormack, Clarke, Büttcher, SIGIR 2009,
  *Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods*。
