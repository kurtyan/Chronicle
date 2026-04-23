---
name: chronicle-summarize
description: Summarize work from today, yesterday, or this week using Chronicle data
---

## Trigger phrases

"daily summary" / "today's summary" / "end of day summary" / "daily review" / "summarize today's work" / "today's feedback" / "working hours analysis" / "work status" / "AFK analysis" / "how much did I work today" / "yesterday's work" / "this week's work" / "summarize yesterday" / "weekly review"

## Overview

Use the `query_sessions` MCP tool to fetch Chronicle work sessions for the requested time range. Produce two outputs:
1. **AFK/time analysis** — session timeline, AFK gaps, hourly activity, focus ratio
2. **Task review** — per-task feedback on what's done/in-progress, plus tomorrow's suggestions

Always produce both parts together unless the user explicitly asks for only one.

## Timezone offset

Workday = TODAY 05:00:00 to TOMORROW 05:00:00 (+5h from midnight). If current time is before 05:00, workday belongs to the previous calendar day.

Calculate unix timestamps (ms):
```python
import datetime
now = datetime.datetime.now()
today = now.date() if now.hour >= 5 else (now - datetime.timedelta(days=1)).date()
start = datetime.datetime(today.year, today.month, today.day, 5, 0, 0)
end = start + datetime.timedelta(days=1)
start_ms = int(start.timestamp() * 1000)
end_ms = int(end.timestamp() * 1000)
```

For "yesterday": shift `today` back by one day, end = start + 1 day.
For "this week": start = Monday 05:00, end = now.

## Step 1: Fetch sessions

Call `query_sessions` with the calculated timestamps.

## Step 2: Fetch tasks + logs

For each unique taskId found in sessions (preserve order of first appearance):
- Call `get_task` to get task details and logs
- Compute session duration per task from the sessions response
- Strip HTML tags from log content (remove tags, decode `&amp;`/`&lt;` etc., collapse whitespace)

## Step 3: Merge rapid-fire sessions

Same-task sessions within 5s of each other are UI artifacts — merge them into one before analysis.

## Output Part 1 — AFK & Time Analysis

### Sessions table
Chronological list: `HH:MM:SS - HH:MM:SS [duration] task_name`

### AFK gaps (skip <1min)
- Short (<5m): no marker
- Medium (5-30m): `·` marker
- Long (>30m): `1` marker

### Time by task
Sorted descending by total session time.

### Daily summary stats
- Work window: first session → last session (span)
- Active work time
- Total AFK: short/medium/long breakdown
- Focus ratio = active / span × 100%
- Tasks touched count

### Hourly activity bar chart
Distribute session time across clock hours, render as `█` bars (1 block = 3min).

### AFK evaluation
List notable breaks (>5m) sorted by duration, call out patterns.

### Time analysis verdict
- Comment on start time, peak productive block, dead zones
- Flag context switching (many short sessions across tasks)
- Note focus ratio interpretation

## Output Part 2 — Task Review & Tomorrow's Plan

### Today's work review
Split into:
- **✅ Completed** (status == DONE)
- **🔁 In Progress** (status == DOING)

For each task:
- Title, priority, time spent
- Key progress from logs (summarized, not raw dump)
- **Feedback**: 1-3 sentences on efficiency, issues, outcomes

End with **Overall Feedback**: completion rate, most valuable work, highlights, areas to improve.

### Tomorrow's suggestions
All unfinished tasks (DOING + PENDING), grouped:
- **P0-Must do**: deadlines, blocking others, high-stakes (1on1, cross-team commitments)
- **P1-Should do**: clear next action, meaningful progress
- **P2-Schedule time**: lower urgency but shouldn't keep slipping
- **Defer**: no clear next action or genuinely low priority

For each: specific actionable next step, blockers, follow-up dates if relevant.

## Analysis heuristics

- Task with 0 logs + <1min session = not actually started, flag it
- Task DOING but logs show completion ("已反馈", "跑完了", "✅") = suggest marking DONE
- Cross-team tasks (meetings, PRs, deployments) = flag follow-up dates
- 1on1/planning docs = always P0 if 1on1 is upcoming
- Task untouched 2+ days = call out slippage explicitly
- Back-to-back long AFK gaps = call out as dead zone
