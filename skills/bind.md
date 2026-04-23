---
name: chronicle-bind
description: Bind a Chronicle task ID to this Claude conversation
---

When the user provides a Chronicle task ID (e.g. "chronicle taskId: TXXXXXXXX" or "bind task TXXXXXXXX"), do the following:

## Step 1: Get current conversation ID

Run this bash command to find your Claude Code parent process's session ID:

```bash
pid=$$; while true; do ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' '); [ -z "$ppid" ] && break; comm=$(ps -o comm= -p $ppid 2>/dev/null | tr -d ' '); if [[ "$comm" == claude* ]]; then cat ~/.claude/sessions/${ppid}.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))"; break; fi; pid=$ppid; done
```

Save the output as `conversationId`.

## Step 2: Save binding

Write the binding to `<target_root>/.chronicle/bindings/<conversationId>.json`:

```json
{ "taskId": "<the task ID>", "boundAt": "<ISO timestamp>" }
```

`<target_root>` is the current working directory.

## Step 3: Confirm

Reply: "Bound Chronicle task {taskId} to this conversation."

Do NOT query any Chronicle APIs. Just save the binding and confirm.

## Recovery after compaction

If the conversation was compacted and the user references a task:
1. Run the same bash command to get the current `conversationId`
2. Read `<target_root>/.chronicle/bindings/<conversationId>.json` to find the bound taskId
3. Use that taskId for subsequent Chronicle operations

## Important

- Every time you call a Chronicle MCP tool (get_task, add_log, takeover_task, etc.), pass `conversationId` as a parameter. Get it by running the bash command in Step 1.
- Each conversation has its own binding file — they are completely isolated.
- A new conversation will not find an existing binding and needs the user to bind a task first.
