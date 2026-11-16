import asyncio
import sys

from prompt_toolkit import PromptSession
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.patch_stdout import patch_stdout

from .app import Harness
from .config import parse_config
from .render import safe_text


class Terminal:
    def __init__(self):
        bindings = KeyBindings()

        @bindings.add("enter")
        def submit(event):
            event.current_buffer.validate_and_handle()

        @bindings.add("escape", "enter")
        def newline(event):
            event.current_buffer.insert_text("\n")

        @bindings.add("c-d")
        def quit_input(event):
            event.app.exit(exception=EOFError)

        # In-memory history only: no duplicate prompt transcript on disk.
        self.session = PromptSession(key_bindings=bindings)

    async def ask(self, prompt, multiline=False):
        return await self.session.prompt_async(prompt, multiline=multiline)

    def write(self, text):
        print(safe_text(text), end="", flush=True)


def main(argv=None):
    config = parse_config(argv)
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("claude-harness requires an interactive terminal.", file=sys.stderr)
        return 2
    try:
        with patch_stdout():
            asyncio.run(Harness(config, Terminal()).run())
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        # Exception strings may contain request bodies, settings or credentials.
        print(f"Harness stopped ({type(exc).__name__}). Check configuration, SDK runtime, "
              "gateway connectivity and original --cwd for resumed sessions.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
