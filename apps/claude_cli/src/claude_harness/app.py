import asyncio
import json
import signal

from claude_agent_sdk import ClaudeSDKClient, ResultMessage, SystemMessage
from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

from .render import Renderer
from .store import SessionStore


class Harness:
    def __init__(self, config, terminal, client_factory=ClaudeSDKClient):
        self.config = config
        self.terminal = terminal
        self.client_factory = client_factory
        self.store = SessionStore(config.state_dir)
        self.renderer = Renderer(terminal.write)
        self.client = None
        self.session_id = config.resume
        self.model = config.model or config.settings.get("model")
        self.permission_lock = asyncio.Lock()
        self.metadata_warning = False

    async def permission(self, tool_name, tool_input, context):
        # The runtime has already applied allow/deny rules before asking here.
        # Serialize prompts when multiple tools request permission concurrently.
        async with self.permission_lock:
            self.renderer.line(f"[permission: {tool_name}]")
            self.renderer.line(json.dumps(tool_input, ensure_ascii=False))
            if context.decision_reason:
                self.renderer.line(context.decision_reason)
            try:
                answer = await self.terminal.ask("Allow once? [y/N] ")
            except (EOFError, KeyboardInterrupt):
                return PermissionResultDeny(message="Cancelled by user", interrupt=True)
            if answer.strip().lower() == "y":
                return PermissionResultAllow(updated_input=tool_input)
            return PermissionResultDeny(message="Denied by user")

    def persist(self):
        if self.session_id:
            try:
                self.store.save(self.session_id, self.config.cwd, self.model)
            except (OSError, ValueError):
                if not self.metadata_warning:
                    self.renderer.line("[Cannot save CLI metadata; SDK transcript storage is separate.]")
                    self.metadata_warning = True

    async def connect(self):
        self.client = self.client_factory(self.config.options(
            self.permission, model=self.model, resume=self.session_id,
        ))
        await self.client.connect()

    async def disconnect(self):
        if self.client is not None:
            client, self.client = self.client, None
            await client.disconnect()

    async def models(self, argument):
        if argument:
            try:
                await self.client.set_model(argument)
            except Exception as exc:
                self.renderer.line(f"[Model switch failed ({type(exc).__name__}); keeping {self.model or 'default'}.]")
                return
            self.model = argument
            self.persist()
            self.renderer.line(f"[model {argument}]")
        else:
            self.renderer.line(f"Current model: {self.model or 'runtime default'}")
            info = await self.client.get_server_info() or {}
            models = info.get("models", [])
            for model in models:
                if isinstance(model, dict):
                    self.renderer.line(f"  {model.get('value', '?')}: {model.get('displayName', '')}")
            self.renderer.line("Use /model <model-id>; custom intranet model IDs are accepted.")

    async def command(self, text):
        name, _, argument = text.partition(" ")
        argument = argument.strip()
        if name == "/model":
            await self.models(argument)
        elif name == "/status" and not argument:
            self.renderer.line(f"Session: {self.session_id or '(new; no messages yet)'}")
            self.renderer.line(f"Model: {self.model or 'runtime default'}")
            self.renderer.line(f"Working directory: {self.config.cwd}")
            self.renderer.line(f"Settings: {self.config.settings_source}")
            self.renderer.line(f"Additional settings: {','.join(self.config.setting_sources) or '(none)'}")
            self.renderer.line(f"Metadata directory: {self.config.state_dir}")
        elif name == "/new" and not argument:
            await self.disconnect()
            self.session_id = None
            await self.connect()
            self.renderer.line("[New session; previous transcript retained.]")
        else:
            self.renderer.line("Commands: /model [model-id], /new, /status. Ctrl+D to quit.")

    async def consume_turn(self, text):
        await self.client.query(text)
        got_result = False
        async for msg in self.client.receive_response():
            if isinstance(msg, SystemMessage) and msg.subtype == "init":
                self.session_id = msg.data.get("session_id") or self.session_id
                # Init events may keep reporting the startup model even after
                # set_model() has changed subsequent requests. Preserve our
                # acknowledged selection instead of overwriting it each turn.
                self.model = self.model or msg.data.get("model")
                self.persist()
                self.renderer.line(f"[session {self.session_id} | model {self.model or 'runtime default'}]")
                continue
            elif isinstance(msg, ResultMessage):
                self.session_id = msg.session_id
                self.persist()
                got_result = True
            self.renderer.event(msg)
        if not got_result:
            raise ConnectionError("Runtime closed before completing the turn")

    async def turn(self, text):
        loop = asyncio.get_running_loop()
        interrupted = asyncio.Event()
        # A turn runs separately so Ctrl+C can interrupt the runtime without
        # cancelling the task that owns the SDK's AnyIO connection scopes.
        previous = signal.getsignal(signal.SIGINT)
        loop.add_signal_handler(signal.SIGINT, interrupted.set)
        task = asyncio.create_task(self.consume_turn(text))
        waiter = asyncio.create_task(interrupted.wait())
        try:
            done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
            if waiter in done and not task.done():
                self.renderer.line("[Interrupting…]")
                await asyncio.wait_for(self.client.interrupt(), timeout=15)
                # Drain to ResultMessage, otherwise the next prompt could receive
                # events belonging to the interrupted turn.
                await asyncio.wait_for(asyncio.shield(task), timeout=15)
            else:
                await task
        finally:
            loop.remove_signal_handler(signal.SIGINT)
            signal.signal(signal.SIGINT, previous)
            waiter.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, waiter, return_exceptions=True)

    async def run(self):
        if self.config.resume:
            saved = self.store.load(self.config.resume)
            if saved.get("cwd") and saved["cwd"] != str(self.config.cwd):
                raise ValueError("Resume requires the original --cwd")
            if not self.config.model and saved.get("model"):
                self.model = saved["model"]
        try:
            await self.connect()
            self.renderer.line("Claude harness | /model [id], /new, /status | Alt+Enter: newline | Ctrl+D: quit")
            while True:
                try:
                    text = (await self.terminal.ask("> ", multiline=True)).strip()
                except KeyboardInterrupt:
                    continue  # Cancel input, keep the session alive.
                except EOFError:
                    break
                if not text:
                    continue
                if text.startswith("/"):
                    await self.command(text)
                else:
                    await self.turn(text)
        finally:
            await self.disconnect()
