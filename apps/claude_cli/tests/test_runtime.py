"""Opt-in real SDK/runtime test against a local fake Anthropic gateway.

No paid API calls or company credentials. Requires loopback networking and
permission to run the SDK's bundled executable, unavailable in some sandboxes.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from claude_harness.app import Harness
from claude_harness.config import Config
from claude_harness.store import SessionStore

pytestmark = pytest.mark.skipif(
    os.environ.get("CLAUDE_HARNESS_RUNTIME_TEST") != "1",
    reason="Set CLAUDE_HARNESS_RUNTIME_TEST=1 to run the bundled runtime with a local gateway",
)


async def test_real_runtime_gateway_model_and_disk_resume(tmp_path, monkeypatch):
    requests = []

    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if "/messages" not in self.path or "count_tokens" in self.path:
                encoded = json.dumps({"input_tokens": 10}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            requests.append(body)
            message = {"id": "msg_test", "type": "message", "role": "assistant",
                       "model": body["model"], "content": [], "stop_reason": None,
                       "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
            if not body.get("stream"):
                # set_model validates custom IDs using a non-streaming probe.
                message.update(content=[{"type": "text", "text": "gateway reply"}], stop_reason="end_turn")
                encoded = json.dumps(message).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            events = [
                ("message_start", {"message": message}),
                ("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "gateway reply"}}),
                ("content_block_stop", {"index": 0}),
                ("message_delta", {"delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                   "usage": {"output_tokens": 2}}),
                ("message_stop", {}),
            ]
            encoded = "".join(f"event: {name}\ndata: {json.dumps({'type': name, **data})}\n\n"
                              for name, data in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    class Terminal:
        def __init__(self, answers):
            self.answers = iter(answers)
            self.output = []

        async def ask(self, prompt, multiline=False):
            try:
                return next(self.answers)
            except StopIteration:
                raise EOFError from None

        def write(self, text):
            self.output.append(text)

    config = Config({"model": "test-model-a", "env": {
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}",
        "ANTHROPIC_API_KEY": "test-placeholder-not-a-real-key",
    }}, "inline JSON", tmp_path, tmp_path / "metadata", [])
    try:
        terminal = Terminal(["hello", "/model test-model-b", "second turn"])
        app = Harness(config, terminal)
        await app.run()
        assert app.session_id
        assert any(body["model"] == "test-model-a" for body in requests)
        assert any(body["model"] == "test-model-b" for body in requests)
        assert requests[-1]["model"] == "test-model-b"
        assert {tool["name"] for tool in requests[0]["tools"]} >= {"Bash", "Read", "Edit"}
        assert "gateway reply" in "".join(terminal.output)
        assert SessionStore(config.state_dir).load(app.session_id)["model"] == "test-model-b", (
            app.model, "".join(terminal.output))
        transcripts = list((tmp_path / "runtime" / "projects").rglob("*.jsonl"))
        assert transcripts, "SDK must persist a transcript"
        assert any("hello" in path.read_text() for path in transcripts)
        config.resume = app.session_id
        resumed = Harness(config, Terminal(["after restart"]))
        await resumed.run()
        assert resumed.session_id == app.session_id
        assert requests[-1]["model"] == "test-model-b"
        serialized = json.dumps(requests[-1]["messages"])
        assert "hello" in serialized and "second turn" in serialized
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
