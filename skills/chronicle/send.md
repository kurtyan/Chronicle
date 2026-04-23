---
name: chronicle-send
description: Send content to a Chronicle task log
---

When the user asks you to "send xxx to chronicle" or "log xxx to chronicle", do the following:

## Step 1: Find the bound task

Run this bash command to get the current conversation ID:

```bash
pid=$$; while true; do ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' '); [ -z "$ppid" ] && break; comm=$(ps -o comm= -p $ppid 2>/dev/null | tr -d ' '); if [[ "$comm" == claude* ]]; then cat ~/.claude/sessions/${ppid}.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))"; break; fi; pid=$ppid; done
```

Then read `<project>/.chronicle/bindings/<conversationId>.json` to find the bound taskId.

If no binding file exists, tell the user: "No task is bound to this conversation. Bind one first by saying 'chronicle taskId: TXXXXXXXX'."

## Step 2: Send the log

Call the `add_log` MCP tool with:
- `taskId`: the bound task ID
- `content`: the content the user wants to send
- `type`: "log" (default) unless the user specifies "body"
- `conversationId`: the current conversation ID from Step 1

## Step 3: Confirm

Reply with a short confirmation, e.g. "Logged to Chronicle task {taskId}."
