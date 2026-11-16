# Claude Harness

独立的 Python 交互式 CLI，使用 Claude Agent SDK 提供编码 agent 的会话、内置工具和权限执行能力。与 Chronicle 的 Node 服务、Web UI、数据库及构建流程独立。

## 安装

需要 Python 3.11+。首版面向 Linux / macOS 的交互式终端，使用 POSIX 信号处理执行中的 Ctrl+C。

在仓库根目录执行：

```bash
python3 -m venv apps/claude_cli/.venv
source apps/claude_cli/.venv/bin/activate
python -m pip install ./apps/claude_cli
```

全部应用及测试依赖均可用 pip 安装。固定的 `claude-agent-sdk==0.2.182` 平台 wheel 包含 Claude Code 运行时，无需 npm、Node.js、uv 或手动安装 Claude Code。底层运行时是原生可执行文件，因此安装环境必须有该 SDK 版本支持的系统/架构 wheel，并允许运行可执行文件；应用本身是 Python。

开发与测试安装：

```bash
python -m pip install -e './apps/claude_cli[test]'
```

离线内网安装：先在与目标系统、架构及 Python 版本匹配的联网机器准备完整 wheel 目录，再拷入内网：

```bash
python -m pip wheel --wheel-dir wheelhouse ./apps/claude_cli
# 在内网目标机器的虚拟环境中执行：
python -m pip install --no-index --find-links ./wheelhouse chronicle-claude-harness
```

`pip wheel` 会准备应用及传递依赖的 wheel。SDK wheel 包含运行时，体积较大。依赖安装齐全不代表模型可用：运行时仍需要访问配置的模型网关，以及所启用的 MCP 服务。

## 启动及配置

```bash
claude-harness --settings /path/to/settings.json --cwd /path/to/project
claude-harness --settings-json '{"model":"sonnet"}' --cwd /path/to/project
# 等价模块入口：
python -m claude_harness --settings /path/to/settings.json
```

`--settings` 和 `--settings-json` 必须且只能选择一个。推荐用文件传递带凭证的配置，避免凭证出现在 shell 历史或进程参数中。应用不会输出 settings 内容，也不打印原始异常及运行时 stderr。

配置格式为 Claude Code `settings.json`，参考 [examples/settings.json](examples/settings.json)。将示例的网关地址、模型改成公司实际值。凭证可通过进程环境中的 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 提供，也可以放在 settings 的 `env` 中。公司网关需要兼容 Anthropic Messages API 和流式响应。

settings 对象原样交给 SDK 的 `settings` 参数，模型、`env`、权限、hooks 等语义由固定版本的 Claude Code 运行时处理。应用只验证 JSON 对象、`env` 字符串值及模型字段，不维护另一套 settings schema；未来或未知字段是否生效以运行时支持为准。MCP 配置使用独立的 `--mcp-config /path/to/mcp.json`，结构为 `{"mcpServers": {...}}`。

默认不加载用户级或项目级 settings。需要时显式启用：

```bash
claude-harness --settings ./settings.json --setting-sources user,project,local
```

settings 的合并由运行时执行：显式 settings 的优先级高于所启用的磁盘 settings；CLI `--model` 高于保存的会话模型，保存的会话模型高于 settings 模型；会话中的 `/model` 改变之后请求所用的模型。进程环境仍会被 SDK 继承，因此未加载用户 settings 不等于隔离所有环境。MCP 使用严格配置模式，只加载显式 `--mcp-config` 指定的服务。

`/status` 显示配置来源、额外启用的 settings 来源、工作目录、会话 ID、模型和元信息目录。运行时 preset 使用 `claude_code`，支持其内置编码工具。项目级 `CLAUDE.md` 等行为遵循 SDK / 运行时的配置加载规则。

## 交互

| 操作 | 行为 |
| --- | --- |
| 普通输入，Enter | 发送，继续当前会话 |
| Alt+Enter | 输入换行；也支持粘贴多行文本 |
| `/model` | 查看当前模型和运行时公布的模型列表 |
| `/model <model-id>` | 原会话内切换模型，可使用内网自定义 ID |
| `/new` | 新建会话，保留旧会话磁盘记录及当前选择的模型 |
| `/status` | 查看当前状态 |
| Ctrl+C（输入中） | 清空本次输入 |
| Ctrl+C（执行中） | 请求 SDK 中断，收完本轮结束事件后返回输入 |
| Ctrl+D（输入中） | 退出并关闭 SDK 子进程 |

不提供 `/help` 或 `/exit`。未知斜杠命令在本地提示，不转发给模型。命令行参数帮助仍可用 `claude-harness --help`。

权限规则先由运行时判定，需要人工决定的工具调用才进入终端确认。显示工具和参数后输入 `y` 仅允许本次执行，其余回答拒绝；确认时 Ctrl+C / Ctrl+D 拒绝并请求结束本轮。应用不自动启用 bypass 权限模式；显式 settings 中的权限模式仍由运行时执行。

模型切换通过 SDK `set_model()` 完成，失败时不更新本地模型状态。运行时可能使用非流式请求验证自定义模型，因此网关需要同时支持普通和流式 Messages 请求。切换成功不保证之后请求始终可用，初始化模型列表也不是公司网关的实时模型清单。

## 会话存储与恢复

完整对话及工具调用由 SDK 内附运行时保存，通常在 `~/.claude/projects/` 下；设置 `CLAUDE_CONFIG_DIR` 时位置随之改变。使用 SDK 默认本地存储，不实现第二套上下文或重复保存聊天副本。

CLI 在 `~/.claude-harness/<session-id>.json` 保存 session ID、工作目录、当前模型；可用 `--state-dir` 改目录。新建目录权限为 `0700`，元信息文件为 `0600`，采用原子替换写入。输入历史仅保存在当前进程内存，不生成额外历史文件。元信息保存失败时提示，SDK 的会话存储独立处理。

从首轮初始化信息及 `/status` 获取 session ID，恢复时使用原来的工作目录、运行时配置目录，以及能访问同一网关的 settings：

```bash
claude-harness --settings /path/to/settings.json --cwd /original/project --resume <session-id>
```

支持恢复外部创建的 SDK 会话，即使没有本 CLI 的元信息。`/new` 和退出都不会删除记录；清理时需分别处理 SDK transcript 和 CLI 元信息。对话记录及工具输出可能含源码、命令输出和凭证，终端会展示工具参数及结果，应用不对模型内容做完整的秘密识别或脱敏。

## 验证及排错

```bash
cd apps/claude_cli
python -m pytest -q
# 可选：真实 SDK 运行时 + 本地模拟 Anthropic 网关，无真实模型调用或公司凭证
CLAUDE_HARNESS_RUNTIME_TEST=1 python -m pytest tests/test_runtime.py -q
```

默认测试覆盖配置、会话元信息、模型切换、多轮对话、权限确认、流式去重、中断收尾和连接失败清理。可选集成测试要求允许执行 SDK 二进制和本地回环网络，验证原生运行时的多轮请求、模型切换、transcript 落盘及跨进程恢复。

连接或请求错误时，检查网关连通性、认证配置、模型 ID、TLS 证书和原工作目录。运行中断后若运行时 15 秒内未响应或未结束本轮，CLI 退出，避免下一轮混入旧事件，可通过 session ID 恢复。部分受限沙箱可能禁止内附运行时启动；这与 Python 依赖能否用 pip 安装是两回事。

## 代码结构

- `config.py`：CLI 参数、JSON 校验及 SDK options。
- `app.py`：会话生命周期、命令、权限确认和中断。
- `render.py`：流式事件、工具结果及用量输出。
- `store.py`：仅会话元信息的原子存储。
- `cli.py`：终端输入和可执行入口。

首版没有 IDE 集成、插件市场或多 agent 编排。真实公司网关认证、模型输出及工具行为需要在内网联调。
