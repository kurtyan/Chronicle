---
name: chronicle-summarize
description: Summarize work from today, yesterday, or this week using Chronicle data
---

When the user asks for a work summary ("summarize today", "yesterday's work", "this week"), do the following:

## Step 1: Determine time range

Use a +5 hour offset for the work day boundary (the user's work day wraps around midnight):

| Query | Start | End |
|-------|-------|-----|
| today | start of today -5h | now |
| yesterday | start of yesterday -5h | start of today -5h |
| this week | Monday 0:00 -5h | now |

Convert to unix timestamps in milliseconds.

## Step 2: Query sessions

Call `query_sessions` with the timestamp range.

## Step 3: Get task details

For each unique taskId found in the sessions, call `get_task` to get task details and logs.

## Step 4: Analyze and present

Present the summary in this structure:

1. **Work Time**: total active time vs AFK time across all sessions
2. **Tasks Worked On**: list of tasks with status changes, progress, and key logs
3. **Accomplishments**: what was completed, what's in progress
4. **Idle Analysis**: patterns of AFK vs active time

Be concise and specific. Include actual task titles and log content.
