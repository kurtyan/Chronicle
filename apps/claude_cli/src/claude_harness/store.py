"""Store only session metadata; transcripts belong to the SDK runtime."""

import json
import os
import re
import tempfile
from pathlib import Path


class SessionStore:
    def __init__(self, root: Path):
        self.root = root

    def path(self, session_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
            raise ValueError("Invalid session ID")
        return self.root / f"{session_id}.json"

    def load(self, session_id: str) -> dict:
        path = self.path(session_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}  # SDK sessions created outside this CLI can also be resumed.
        if not isinstance(data, dict) or data.get("session_id") != session_id:
            raise ValueError("Invalid session metadata")
        if data.get("model") is not None and not isinstance(data["model"], str):
            raise ValueError("Invalid saved model")
        return data

    def save(self, session_id: str, cwd: Path, model: str | None):
        target = self.path(session_id)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=".session-", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump({"session_id": session_id, "cwd": str(cwd), "model": model}, out)
                out.write("\n")
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
