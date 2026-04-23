---
name: chronicle-send
description: Send content to a Chronicle task log
---

When the user asks you to "send xxx to chronicle" or "log xxx to chronicle", do the following:

## Step 1: Get current conversation ID

Run this bash command to get the current conversation ID:

```bash
pid=$$; while true; do ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' '); [ -z "$ppid" ] && break; comm=$(ps -o comm= -p $ppid 2>/dev/null | tr -d ' '); if [[ "$comm" == claude* ]]; then cat ~/.claude/sessions/${ppid}.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))"; break; fi; pid=$ppid; done
```

Save the output as `conversationId`.

## Step 2: Determine the target task

If the user explicitly provides a task ID (e.g. "send xxx to chronicle task: TXXXXXXXX"):
- Use that taskId directly.

Otherwise:
- Read `<target_root>/.chronicle/bindings/<conversationId>.json` to find the bound taskId.

`<target_root>` is the current working directory.

If no binding file exists and no explicit taskId was given, tell the user: "No task is bound to this conversation. Bind one first by saying 'chronicle taskId: TXXXXXXXX'."

## Step 3: Format content as HTML

Chronicle task logs use HTML format. Convert the content:
- Wrap each paragraph (separated by blank lines) in `<p>...</p>`
- Convert single line breaks to `<br>`
- Preserve any existing HTML tags (lists, code blocks, etc.)
- Do NOT leave raw newlines in the content — everything must be wrapped in HTML tags

Example:
```
User input:
Fixed the bug in auth.
Also updated the tests.

New feature added.
```

Becomes:
```html
<p>Fixed the bug in auth.<br>Also updated the tests.</p><p>New feature added.</p>
```

## Step 4: Send the log

Call the `add_log` MCP tool with:
- `taskId`: the target task ID (explicit or from binding)
- `content`: the HTML-formatted content from Step 3
- `type`: "log" (default) unless the user specifies "body"
- `conversationId`: the current conversation ID from Step 2

## Step 5: Confirm

Reply with a short confirmation, e.g. "Logged to Chronicle task {taskId}."
