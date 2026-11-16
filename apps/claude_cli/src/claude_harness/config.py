"""Validate the JSON envelope; let Claude Code interpret settings semantics."""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions


@dataclass
class Config:
    settings: dict[str, Any]
    settings_source: str
    cwd: Path
    state_dir: Path
    setting_sources: list[str]
    model: str | None = None
    resume: str | None = None
    mcp_config: Path | None = None

    def options(self, permission_callback, model=None, resume=None):
        return ClaudeAgentOptions(
            settings=json.dumps(self.settings, ensure_ascii=False),
            setting_sources=self.setting_sources,
            cwd=self.cwd,
            model=model,
            resume=resume,
            system_prompt={"type": "preset", "preset": "claude_code"},
            include_partial_messages=True,
            can_use_tool=permission_callback,
            mcp_servers=str(self.mcp_config) if self.mcp_config else {},
            strict_mcp_config=True,
            stderr=lambda _line: None,  # Raw runtime diagnostics may contain credentials.
        )


def read_object(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON at line {exc.lineno}, column {exc.colno}") from None
    if not isinstance(value, dict):
        raise ValueError("Settings must be a JSON object")
    if "env" in value and (
        not isinstance(value["env"], dict)
        or any(not isinstance(v, str) for v in value["env"].values())
    ):
        raise ValueError("settings.env must be an object with string values")
    if "model" in value and (not isinstance(value["model"], str) or not value["model"].strip()):
        raise ValueError("settings.model must be a non-empty string")
    return value


def parse_config(argv=None) -> Config:
    parser = argparse.ArgumentParser(description="Interactive Claude Agent SDK CLI")
    settings = parser.add_mutually_exclusive_group(required=True)
    settings.add_argument("--settings", type=Path, help="Claude Code settings.json file")
    settings.add_argument("--settings-json", help="Inline Claude Code settings JSON")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--model", help="Initial model override; also accepts intranet model IDs")
    parser.add_argument("--resume", help="Resume a persisted SDK session ID")
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".claude-harness")
    parser.add_argument("--setting-sources", default="", help="Opt in: user,project,local (default: none)")
    parser.add_argument("--mcp-config", type=Path, help="Separate Claude Code MCP configuration JSON")
    args = parser.parse_args(argv)
    try:
        sources = args.setting_sources.split(",") if args.setting_sources else []
        if any(source not in {"user", "project", "local"} for source in sources):
            raise ValueError("--setting-sources accepts only user,project,local")
        cwd = args.cwd.expanduser().resolve()
        if not cwd.is_dir():
            raise ValueError("--cwd must be an existing directory")
        if args.model is not None and not args.model.strip():
            raise ValueError("--model must be non-empty")
        path = args.settings.expanduser().resolve() if args.settings else None
        value = read_object(path.read_text(encoding="utf-8-sig") if path else args.settings_json)
        mcp = args.mcp_config.expanduser().resolve() if args.mcp_config else None
        if mcp:
            read_object(mcp.read_text(encoding="utf-8-sig"))
        return Config(value, str(path) if path else "inline JSON", cwd,
                      args.state_dir.expanduser().resolve(), sources,
                      args.model, args.resume, mcp)
    except (OSError, ValueError):
        # Do not echo file contents, inline JSON, or credential-bearing paths.
        parser.error("Cannot load configuration: check JSON structure, paths, model and setting sources")
