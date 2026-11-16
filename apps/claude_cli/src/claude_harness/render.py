"""Render SDK events without printing complete assistant messages twice."""

import json
import re

from claude_agent_sdk import (
    AssistantMessage, ResultMessage, StreamEvent,
    TextBlock, ToolResultBlock, ToolUseBlock, UserMessage,
)


def safe_text(value) -> str:
    # Remote output must not execute terminal escape sequences (e.g. OSC clipboard).
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "", str(value))


class Renderer:
    def __init__(self, write):
        self.write = write
        self.streamed = False
        self.line_open = False

    def text(self, text):
        self.write(safe_text(text))
        self.line_open = not str(text).endswith("\n")

    def line(self, text=""):
        if self.line_open:
            self.write("\n")
        self.write(safe_text(text) + "\n")
        self.line_open = False

    def event(self, msg):
        if isinstance(msg, StreamEvent) and not msg.parent_tool_use_id:
            event = msg.event
            if event.get("type") == "message_start":
                if self.line_open:
                    self.line()
                self.streamed = False
            delta = event.get("delta", {})
            if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                self.text(delta.get("text", ""))
                self.streamed = True
        elif isinstance(msg, AssistantMessage):
            if msg.parent_tool_use_id:
                return
            for block in msg.content:
                if isinstance(block, TextBlock) and not self.streamed:
                    self.line(block.text)
                elif isinstance(block, ToolUseBlock):
                    self.line(f"[tool {block.name}] {json.dumps(block.input, ensure_ascii=False)[:2000]}")
            if msg.error:
                self.line(f"[assistant error: {msg.error}]")
            self.streamed = False
        elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    status = "error" if block.is_error else "done"
                    self.line(f"[tool {block.tool_use_id}: {status}] {str(block.content or '')[:2000]}")
        elif isinstance(msg, ResultMessage):
            usage = msg.usage or {}
            cost = f" | ${msg.total_cost_usd:.4f}" if msg.total_cost_usd is not None else ""
            self.line(f"[{msg.subtype} | input {usage.get('input_tokens', 0)} | "
                      f"output {usage.get('output_tokens', 0)}{cost}]")
            if msg.is_error:
                self.line("[Request failed; check gateway, credentials, model and permissions.]")
