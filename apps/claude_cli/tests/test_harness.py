import asyncio
import json
import signal
from pathlib import Path

import pytest
from claude_agent_sdk import (
    AssistantMessage, ResultMessage, StreamEvent, SystemMessage, TextBlock,
)
from claude_agent_sdk.types import ToolPermissionContext

from claude_harness.app import Harness
from claude_harness.config import Config, parse_config
from claude_harness.render import Renderer, safe_text
from claude_harness.store import SessionStore


class Terminal:
    def __init__(self, answers=()):
        self.answers = iter(answers)
        self.output = []

    async def ask(self, prompt, multiline=False):
        answer = next(self.answers, EOFError())
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def write(self, text):
        self.output.append(text)


def result(session="session-1"):
    return ResultMessage("success", 10, 8, False, 1, session, usage={"input_tokens": 5, "output_tokens": 2})


class Client:
    def __init__(self, options):
        self.options = options
        self.prompts = []
        self.models = []
        self.closed = False

    async def connect(self):
        pass

    async def disconnect(self):
        self.closed = True

    async def query(self, text):
        self.prompts.append(text)

    async def receive_response(self):
        # Real runtime repeats its startup model even after set_model().
        yield SystemMessage("init", {"session_id": "session-1", "model": "internal-a"})
        yield AssistantMessage([TextBlock("hello")], "internal-a")
        yield result()

    async def set_model(self, model):
        if model == "bad":
            raise RuntimeError("credential should not be printed")
        self.models.append(model)

    async def get_server_info(self):
        return {"models": [{"value": "internal-a", "displayName": "Internal A"}]}


@pytest.fixture
def config(tmp_path):
    return Config({"env": {"ANTHROPIC_AUTH_TOKEN": "secret"}}, "inline JSON", tmp_path,
                  tmp_path / "state", [])


def test_settings_pass_through_and_isolation(tmp_path):
    raw = {"env": {"ANTHROPIC_BASE_URL": "http://gateway"},
           "permissions": {"deny": ["Bash(rm *)"]}, "futureSetting": True}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(raw))
    cfg = parse_config(["--settings", str(path), "--cwd", str(tmp_path)])
    options = cfg.options(None)
    assert json.loads(options.settings) == raw
    assert options.setting_sources == []
    assert options.strict_mcp_config is True
    assert options.system_prompt == {"type": "preset", "preset": "claude_code"}


@pytest.mark.parametrize("raw", ["[]", '{"env": {"TOKEN": 3}}', '{"model":false}', '{"TOKEN":"secret",'])
def test_invalid_settings_do_not_echo_secrets(raw, capsys):
    with pytest.raises(SystemExit) as error:
        parse_config(["--settings-json", raw])
    assert error.value.code == 2
    assert "secret" not in capsys.readouterr().err


def test_sources_mcp_and_cli_model(tmp_path):
    mcp = tmp_path / "mcp.json"
    mcp.write_text('{"mcpServers": {}}')
    cfg = parse_config(["--settings-json", '{"model":"sonnet"}', "--model", "custom",
                        "--setting-sources", "user,project,local", "--mcp-config", str(mcp)])
    assert cfg.model == "custom"
    assert cfg.setting_sources == ["user", "project", "local"]
    assert cfg.options(None).mcp_servers == str(mcp)


def test_metadata_atomic_private_and_no_transcript(config):
    store = SessionStore(config.state_dir)
    store.save("session-1", config.cwd, "internal-a")
    store.save("session-1", config.cwd, "internal-b")
    data = store.load("session-1")
    assert data == {"session_id": "session-1", "cwd": str(config.cwd), "model": "internal-b"}
    assert store.path("session-1").stat().st_mode & 0o777 == 0o600
    assert config.state_dir.stat().st_mode & 0o777 == 0o700
    assert len(list(config.state_dir.iterdir())) == 1
    with pytest.raises(ValueError):
        store.load("../elsewhere")
    assert store.load("external-session") == {}


async def test_multi_turn_switch_and_resume(config):
    clients = []

    def factory(options):
        clients.append(Client(options))
        return clients[-1]

    terminal = Terminal(["first", "/model internal-b", "/model bad", "/model", "second"])
    harness = Harness(config, terminal, factory)
    await harness.run()
    assert len(clients) == 1
    assert clients[0].prompts == ["first", "second"]
    assert clients[0].models == ["internal-b"]
    assert clients[0].closed
    assert "credential" not in "".join(terminal.output)
    assert "keeping internal-b" in "".join(terminal.output)
    assert harness.model == "internal-b"
    config.resume = "session-1"
    resumed = Harness(config, Terminal(), factory)
    await resumed.run()
    assert clients[-1].options.resume == "session-1"
    assert clients[-1].options.model == "internal-b"
    config.model = "explicit-override"
    await Harness(config, Terminal(), factory).run()
    assert clients[-1].options.model == "explicit-override"


async def test_new_disconnects_and_does_not_delete_history(config):
    clients = []

    def factory(options):
        clients.append(Client(options))
        return clients[-1]

    await Harness(config, Terminal(["first", "/new"]), factory).run()
    assert len(clients) == 2
    assert all(client.closed for client in clients)
    assert clients[-1].options.resume is None
    assert SessionStore(config.state_dir).load("session-1")


@pytest.mark.parametrize("answer,expected,interrupt", [("y", "allow", False), ("", "deny", False),
                                                       ("yes", "deny", False),
                                                       (KeyboardInterrupt(), "deny", True),
                                                       (EOFError(), "deny", True)])
async def test_permissions_fail_closed(config, answer, expected, interrupt):
    harness = Harness(config, Terminal([answer]), Client)
    permission = await harness.permission("Bash", {"command": "echo test"}, ToolPermissionContext())
    assert permission.behavior == expected
    assert getattr(permission, "interrupt", False) == interrupt


async def test_unknown_slash_commands_are_not_sent_to_model(config):
    client = Client(config.options(None))
    await Harness(config, Terminal(["/help", "/exit", "/status"]), lambda _: client).run()
    assert client.prompts == []


async def test_ctrl_c_interrupts_and_drains_before_next_turn(config):
    class InterruptClient(Client):
        def __init__(self, options):
            super().__init__(options)
            self.released = asyncio.Event()
            self.interrupted = False

        async def receive_response(self):
            signal.raise_signal(signal.SIGINT)
            await self.released.wait()
            yield result()

        async def interrupt(self):
            self.interrupted = True
            self.released.set()

    client = InterruptClient(config.options(None))
    harness = Harness(config, Terminal(), lambda _: client)
    await harness.connect()
    try:
        await asyncio.wait_for(harness.turn("work"), timeout=3)
        assert client.interrupted
        assert harness.session_id == "session-1"
    finally:
        await harness.disconnect()


async def test_failure_always_disconnects(config):
    class BrokenClient(Client):
        async def query(self, text):
            raise ConnectionError("secret")

    client = BrokenClient(config.options(None))
    with pytest.raises(ConnectionError):
        await Harness(config, Terminal(["work"]), lambda _: client).run()
    assert client.closed


def test_streaming_dedup_and_message_boundaries():
    output = []
    renderer = Renderer(output.append)
    for text in ["first", "second"]:
        renderer.event(StreamEvent("id", "session-1", {"type": "message_start"}))
        renderer.event(StreamEvent("id", "session-1", {
            "type": "content_block_delta", "delta": {"type": "text_delta", "text": text},
        }))
        renderer.event(AssistantMessage([TextBlock(text)], "internal-a"))
    renderer.event(AssistantMessage([TextBlock("fallback")], "internal-a"))
    assert "".join(output).count("first") == 1
    assert "".join(output).count("second") == 1
    assert "fallback" in "".join(output)
    assert "\x1b" not in safe_text("\x1b]52;c;clipboard\x07")
