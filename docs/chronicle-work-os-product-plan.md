# Chronicle Work OS Product Plan

## 1. Product Positioning

Chronicle should be treated as a local-first personal work operating system, not only a task tracker.

The central product question is:

> How do I spend my work time, what should I do now, what did I learn, and how can I work better next time?

The current system already contains strong signals for this direction:

- `take over` means a task is actively consuming work time.
- `afk` means the user explicitly leaves active work.
- `work_sessions` already provide an auditable time record.
- Report already includes idle time, proving time management is part of the product core.
- Task logs capture raw work evidence.

The next product stage should connect these into one loop:

```text
Time session -> Task/Meeting/KTLO -> Log -> Note/Reminder -> Report -> Optimization
```

## 2. Design Principles

### 2.1 Time Is The Backbone

Tasks, meetings, KTLO work, idle time, focus blocks, and AFK periods should all map to the same work timeline.

The product should not only answer:

```text
What tasks did I complete?
```

It should answer:

```text
Where did my time go?
What interrupted my planned work?
Which areas consumed most focus time?
Was the day fragmented?
What should I adjust tomorrow?
```

### 2.2 Area + Tags Replace Rigid Task Types

The old task types, such as task / toread / dailyimprove, do not match actual usage. They are too rigid and mutually exclusive.

Actual work has multiple dimensions:

- Which direction or project does it belong to?
- Is it KTLO?
- Is it a requirement?
- Is it a research task?
- Is it a meeting?
- Does it need follow-up?
- Is it a bug?

Recommended model:

```text
area: Chronicle / Project A / Team / Personal
tags: ktlo, requirement, research, meeting, follow-up, bug, reading, urgent
status: pending, doing, done, dropped, on_hold
priority: low, medium, high
```

`area` is a primary aggregation dimension. `tags` are flexible task attributes.

### 2.3 Capture Must Be Lightweight

Chronicle should fit the user's real work flow instead of forcing work to fit Chronicle.

High-frequency capture paths must be fast:

- Record meeting.
- Quick capture KTLO task.
- Create follow-up from a log.
- Add a Day Script block.
- Convert task/log into note.

The goal is to avoid switching from execution mode into heavy management mode.

### 2.4 LLM Is A Converter And Analyst

The local LLM should be used for:

- Classification.
- Extraction.
- Planning.
- Summarization.
- Context recovery.
- Efficiency analysis.

It should not silently mutate critical data. Generated plans, notes, reminders, and tags should be drafts or suggestions unless explicitly confirmed.

## 3. Core Domain Concepts

### 3.1 Task

A task is a work object.

Recommended future fields:

```text
id
title
status
priority
area_id nullable
tags json/text
estimated_minutes nullable
deadline nullable
planned_date nullable
created_at
updated_at
started_at
completed_at
```

Legacy `type` can remain for compatibility but should be de-emphasized in UI.

### 3.2 Work Session

A work session is a time interval that should be used for reporting and efficiency analysis.

Current sessions are task-oriented. Future sessions should support session kinds:

```text
kind: focus | meeting | ktlo | afk | idle | manual
task_id nullable
area_id nullable
started_at
ended_at
source: takeover | meeting_record | manual_adjustment | day_script | system
```

Important invariant:

> Time intervals used for reporting should not overlap.

When a new session overlaps existing sessions, the existing sessions should be split or trimmed according to a deterministic policy.

### 3.3 Task Log Entry

A log entry is raw work evidence.

It may include:

- Progress.
- Meeting notes.
- Decisions.
- Investigation findings.
- Commands.
- Follow-up statements.
- Knowledge worth preserving.

LLM and rule-based detectors can analyze log entries after save.

### 3.4 Area

An Area represents a work direction or project-like container.

Recommended model:

```text
areas
- id
- name
- description
- color
- created_at
- archived_at nullable
```

Each task can belong to zero or one area initially. Many-to-many can be added later if needed.

Area pages should aggregate:

- Pending tasks.
- Recent logs.
- Time spent.
- Meetings.
- Notes.
- Open follow-ups.
- LLM-generated context summary.

### 3.5 Tags

Tags describe task attributes. They are non-exclusive.

Recommended built-in tags:

```text
ktlo
requirement
research
meeting
follow-up
bug
reading
urgent
decision
note-worthy
```

Tags can be manually assigned or suggested by LLM.

### 3.6 Reminder / Follow-up

A reminder is an actionable future attention item.

Recommended model:

```text
reminders
- id
- source_type: task_entry | task | note | meeting
- source_id
- task_id nullable
- area_id nullable
- remind_at
- content
- status: pending | done | dismissed
- created_at
- updated_at
```

Follow-up reminders should be visible in Today and on the source log entry.

### 3.7 Note

A note is long-term knowledge, not raw work history.

Recommended model:

```text
notes
- id
- title
- content
- area_id nullable
- tags json/text
- note_type: general | project | decision | procedure | investigation | meeting | learning
- created_at
- updated_at
```

Link tables:

```text
note_task_links
- note_id
- task_id

note_entry_links
- note_id
- entry_id
```

## 4. Key User Scenarios

### 4.1 Record Meeting

Problem:

The user may be pulled into a meeting for tens of minutes. During that time, they cannot operate Chronicle. Afterward, they need to record what happened and make the time accounting accurate.

Product entry:

```text
Record Meeting
```

Inputs:

```text
meeting title
started_at
ended_at
meeting notes
area optional
tags optional
participants optional later
```

Generated outputs:

```text
task: [Meeting] {title}
log entry: meeting notes
work session: kind=meeting, started_at, ended_at
tags: meeting
area: selected or LLM-suggested
```

Overlap handling:

If the meeting session overlaps existing sessions, split existing sessions to preserve non-overlapping report intervals.

Example:

```text
Existing: 10:00-11:30 Task A
Meeting: 10:30-11:00 Meeting

Result:
10:00-10:30 Task A
10:30-11:00 Meeting
11:00-11:30 Task A
```

Recommended policy:

- Meeting sessions have priority over focus sessions when explicitly recorded.
- Existing sessions are split, trimmed, or removed if fully covered.
- Zero-length fragments are discarded.
- All changes should be deterministic and covered by tests.

### 4.2 KTLO Quick Capture

Problem:

KTLO tasks are often sudden and interruptive. The user needs a fast path to capture them and optionally start working.

Product entry:

```text
Quick Capture
```

Input:

```text
Handle user feedback and check whether search API is abnormal.
```

LLM suggestion:

```text
title: Check search API abnormality
area: Chronicle
tags: ktlo, investigation
priority: high
estimated_minutes: 30
```

Actions:

- Create only.
- Create and take over.
- Create and put into Today.
- Create as Day Script block.

### 4.3 Replace Failed Task Types

Current task types are not useful in daily work. Do not immediately delete them because existing data and UI may depend on them.

Migration plan:

1. Keep `task.type` for compatibility.
2. De-emphasize type in UI.
3. Add Area and stronger Tags.
4. Map old types into tags if useful:

```text
TOREAD -> reading
DAILYIMPROVE -> improvement
TODO -> no special tag
```

New primary navigation should use:

- Status.
- Area.
- Tags.
- Today / planned state.
- Follow-up state.

### 4.4 Follow-up Detection From Logs

Problem:

The user writes natural language follow-up intent inside a task log:

```text
I sent it to Jack. Follow up in 2 hours.
```

Expected behavior:

- Chronicle detects a possible follow-up.
- It shows a suggestion near the saved log.
- The user confirms or ignores it.
- Confirmed reminders appear in Today and on the source log.

Detection strategy:

First use rules for clear expressions:

```text
2 小时后
明天上午
下周一
下午 3 点
later today
in 2 hours
tomorrow morning
follow up
```

Then use LLM for ambiguous cases:

```text
等他回复后再看
晚点确认一下
今天结束前检查
```

Default behavior:

LLM creates suggestions, not automatic reminders.

### 4.5 Day Script For ADHD / Procrastination Resistance

Problem:

The existing plan board is too heavy. The user's real habit is a lightweight notepad with 10-20 minute work blocks.

Recommended module:

```text
Day Script / Focus Plan
```

Principles:

- Editable like raw text.
- Current block highlighted.
- Countdown visible.
- Easy to shift remaining blocks.
- Easy to mark current block done or skipped.
- Blocks may optionally link to tasks but do not have to.

Initial format:

```text
09:30-09:45  Review yesterday's leftover work
09:45-10:05  Inspect searchService diff
10:05-10:15  Break
10:15-10:35  Write data integrity test
```

## 5. Product Modules

### 5.1 Today

Purpose:

Help the user execute the current day.

Should include:

- Current active session.
- Day Script.
- Pending reminders.
- Meeting record entry.
- KTLO quick capture.
- Today's time summary.
- Unfinished carry-over items.

### 5.2 Board

Purpose:

Manage task state.

Changes:

- De-emphasize old task type.
- Add area and tag filters.
- Show KTLO and follow-up badges.
- Show ETA/deadline when available.
- Keep status workflow.

### 5.3 Task Detail

Purpose:

Record evidence and operate on one task.

Additions:

- Entry-level follow-up indicators.
- Entry-level extract-to-note action.
- LLM suggestions after log save.
- Session timeline for the task.
- Linked notes.

### 5.4 Areas

Purpose:

Aggregate work directions and restore context.

Area dashboard should include:

- Overview.
- Pending tasks.
- Recent logs.
- Recent meetings.
- Related notes.
- Time spent this week.
- Open follow-ups.
- LLM-generated progress/context summary.

### 5.5 Notes

Purpose:

Preserve long-term useful knowledge.

Core features:

- Note CRUD.
- Area association.
- Task/log links.
- Tags.
- Search.
- LLM-generated note drafts from tasks/logs/meetings.

### 5.6 Reports

Purpose:

Explain time usage and suggest improvements.

Report dimensions:

```text
focus time
meeting time
idle time
afk time
ktlo time
planned vs unplanned
area time
session fragmentation
task switching frequency
estimate vs actual later
```

LLM output should include evidence-based suggestions:

```text
Observation:
- Meeting time consumed 35% of the day.
- KTLO interrupted two focus sessions.
- Six sessions were shorter than 8 minutes.

Suggestion:
- Reserve a 90-minute focus block tomorrow morning.
- Batch KTLO checks after lunch.
- Split the Notes MVP into four 20-minute blocks.
```

### 5.7 Settings

Purpose:

Configure behavior and LLM.

Settings:

- Local LLM endpoint.
- Model.
- Optional API key.
- Work hours.
- Default focus block length.
- Follow-up detection on/off.
- Auto tag suggestion on/off.
- Area/tag taxonomy management.

## 6. LLM Usage Model

### 6.1 Creation-Time Classification

Used by Quick Capture and Meeting Record.

Inputs:

- User text.
- Existing areas.
- Existing tags.
- Optional current context.

Outputs:

- Suggested title.
- Suggested area.
- Suggested tags.
- Suggested priority.
- Suggested estimated minutes.
- Whether it is KTLO / meeting / research / requirement.

### 6.2 Record-Time Extraction

Used after saving task logs or meeting notes.

Outputs:

- Follow-up suggestions.
- Action items.
- Decisions.
- Risks.
- Note-worthy information.
- Suggested note draft.

### 6.3 Planning-Time Generation

Used by Day Script and Planner.

Inputs:

- Current time.
- Work hours.
- Pending tasks.
- Meetings.
- Reminders.
- Existing Day Script.
- Estimates / deadlines if available.

Outputs:

- Day Script draft.
- Replanned remaining day.
- Task split into 10-20 minute blocks.

### 6.4 Review-Time Summary

Used by Reports and Areas.

Outputs:

- Daily summary.
- Weekly summary.
- Area progress summary.
- Time-use analysis.
- Optimization suggestions.

### 6.5 Query-Time Recall

Used by Search / Ask Chronicle.

Rules:

- Retrieve candidate tasks/logs/notes/meetings first.
- LLM answers only with source references.
- Avoid unsupported claims.

## 7. Implementation Roadmap

### 7.1 Near Term: 1-3 Weeks

Goal:

Make Chronicle capture real daily work more accurately.

#### 1. Record Meeting

Scope:

- Add record meeting API.
- Add simple UI form.
- Create meeting task.
- Create task log.
- Create meeting work session.
- Implement overlap split for work sessions.
- Add tests for session splitting.

Acceptance criteria:

- A meeting can be recorded after it happened.
- Report time does not double count overlapping sessions.
- Meeting task and log are visible in normal task views.

#### 2. Area + Tags Foundation

Scope:

- Add areas table.
- Add `area_id` to tasks.
- Keep existing `tags`.
- Update task create/edit UI.
- Add filters for area and tags.
- De-emphasize legacy task type in UI.

Acceptance criteria:

- User can assign task to an area.
- User can filter board by area.
- User can tag task as ktlo / requirement / research / meeting.

#### 3. Follow-up Reminder MVP

Scope:

- Add reminders table.
- Rule-based detection after log save.
- Reminder suggestion UI.
- Today pending reminders section.
- Source log badge.

Acceptance criteria:

- Log text containing "2 小时后跟进" produces a reminder suggestion.
- Confirmed reminder appears in Today.
- Reminder links back to source task entry.

#### 4. KTLO Quick Capture

Scope:

- Add quick capture entry point.
- Rule or LLM suggestion for `ktlo` tag.
- Create task and optionally take over.

Acceptance criteria:

- User can capture a sudden KTLO task within a few seconds.
- Created task has ktlo tag suggestion.

#### 5. Report Time Categories

Scope:

- Add session kind to reporting.
- Show focus / meeting / KTLO / idle totals.
- Show area time if area exists.

Acceptance criteria:

- Daily report distinguishes focus and meeting time.
- KTLO-tagged sessions can be summarized separately.

### 7.2 Mid Term: 1-3 Months

Goal:

Build the full daily work loop.

#### 1. Day Script

Scope:

- Add focus plan raw text by date.
- Parse time blocks.
- Highlight current block.
- Add done / skip / shift controls.
- Optional task linking.
- LLM-generated Day Script draft.

#### 2. Notes MVP

Scope:

- Add notes table.
- CRUD UI.
- Link notes to tasks/logs/areas.
- Extract note from task/log.
- LLM task summary to note draft.

#### 3. Area Dashboard

Scope:

- Area overview page.
- Pending tasks.
- Recent logs and meetings.
- Related notes.
- Time spent.
- Open follow-ups.
- LLM area summary.

#### 4. Time Analytics v1

Scope:

- Planned vs actual.
- Focus vs meeting vs idle.
- KTLO ratio.
- Session fragmentation.
- Task switch frequency.
- LLM efficiency suggestions.

### 7.3 Long Term: Think Big

Goal:

Make Chronicle a personal work intelligence system.

#### 1. Planner / Timeline / Gantt

Add:

- ETA.
- Deadline.
- Dependencies.
- Weekly planner.
- Timeline/Gantt.
- Overload detection.
- LLM planning assistant.

#### 2. Work Pattern Intelligence

Analyze:

- Procrastinated tasks.
- Estimate drift.
- High-output time windows.
- Fragmented work days.
- Meeting pressure.
- KTLO overload.

#### 3. Knowledge Graph

Connect:

- Areas.
- Tasks.
- Logs.
- Notes.
- Meetings.
- Reminders.
- Sessions.

Use this graph for context recovery and source-backed answers.

#### 4. API / MCP For External Agents

Expose Chronicle capabilities for local agents.

Possible scopes:

```text
read_tasks
write_tasks
read_sessions
write_sessions
read_notes
write_notes
read_reports
write_reminders
```

Built-in workflows should handle common actions. External agents should handle exploratory and cross-tool automation.

## 8. Suggested Data Changes

Near-term tables / columns:

```text
areas
- id
- name
- description
- color
- created_at
- archived_at

tasks
- area_id nullable
- estimated_minutes nullable later
- deadline nullable later
- planned_date nullable later

work_sessions
- kind default 'focus'
- source nullable

reminders
- id
- source_type
- source_id
- task_id nullable
- area_id nullable
- remind_at
- content
- status
- created_at
- updated_at

focus_plans later
- id
- date
- raw_text
- created_at
- updated_at

notes later
- id
- title
- content
- area_id nullable
- tags
- note_type
- created_at
- updated_at
```

## 9. Product Success Criteria

Chronicle should be considered improved if:

- Meeting time can be recorded after the fact without corrupting reports.
- Sudden KTLO work can be captured and started quickly.
- The user can see where work time went by area and category.
- Log entries that imply follow-up do not disappear into history.
- Task organization reflects real work directions and attributes.
- Day Script becomes lighter than the existing plan board and can be used daily.
- Notes preserve reusable knowledge instead of leaving everything fragmented in logs.
- LLM features reduce manual organization work without silently making risky changes.

## 10. Product North Star

> Timeline is the skeleton. Tasks are the work objects. Logs are evidence. Notes are durable knowledge. Areas are context containers. LLM is the converter and analyst.

Chronicle should help the user:

- Capture real work.
- Stay focused on the current action.
- Recover context quickly.
- Preserve useful knowledge.
- Understand time usage.
- Improve personal work strategy over time.
