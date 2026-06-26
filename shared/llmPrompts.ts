export const DEFAULT_MEETING_EXTRACTION_PROMPT = `You extract meeting notes from raw user input.
The user input may contain HTML rich text. Use both the HTML and plain-text versions when provided.
Return only valid JSON matching this shape:
{
  "title": "string",
  "startedAt": "ISO 8601 string | null",
  "endedAt": "ISO 8601 string | null",
  "content": "HTML string",
  "participants": ["string"],
  "tags": ["string"],
  "warnings": ["string"]
}
Rules:
- title is required. If the input does not contain an explicit title, infer a short, descriptive title from the meeting topic or first key discussion point.
- If the input only contains a time range such as 10:00-11:00, use today's local date.
- If participants are missing, return an empty array.
- The content field must be safe, simple HTML suitable for a rich-text editor. Prefer <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>, <h2>, and <h3>.
- Preserve meaningful formatting from the raw HTML. Do not return Markdown in content.
- Suggest relevant tags when clear, but include "meeting" if this is a meeting.
- Put unresolved ambiguity in warnings.
- Do not include markdown fences or prose outside JSON.
- Answer in Chinese.`

export const TASK_SUMMARY_DEFAULT_PROMPT_VERSION = 'task_summary_default_v2'

export const DEFAULT_TASK_SUMMARY_PROMPT = `Summarize the latest task state.
Return only valid JSON matching this exact shape:
{
  "latestProgress": "non-empty string",
  "nextStep": "string",
  "recommendedNextStep": "string"
}
Rules:
- Return exactly these three keys: latestProgress, nextStep, and recommendedNextStep.
- Do not add, remove, rename, or nest fields.
- Write latestProgress and recommendedNextStep in Chinese.
- Base the answer only on the supplied task data.
- latestProgress must synthesize the current task state from all supplied Recent Task Entries, not only the latest entry.
- latestProgress should include important progress, decisions, feedback, and current outcome from the full entry history.
- latestProgress must be concise, ideally 1-2 short sentences.
- latestProgress must not be empty.
- nextStep must represent the latest explicit next step that is still pending at the end of the supplied entry timeline.
- nextStep must be extracted verbatim from the task logs. Use the exact wording of the latest pending explicit next-step statement whenever possible.
- Do not paraphrase, expand, or add actions to nextStep that are not explicitly stated in the supplied entries.
- If nextStep is copied from non-Chinese logs, keep it in the original language.
- For nextStep, read entries in Submitted At order and reason about whether later entries completed, solved, canceled, replaced, or superseded earlier next-step items.
- If a later entry clearly completes, solves, cancels, replaces, or supersedes an earlier next step, do not return that earlier next step.
- If a later entry records unrelated progress but does not complete, solve, cancel, replace, or supersede an earlier next step, keep that earlier next step.
- If a later entry states a new explicit next step, that new next step replaces earlier next steps unless it is itself completed, canceled, or replaced by an even later entry.
- Do not use the latest entry as the sole basis for latestProgress unless it is the only supplied entry.
- If there is no explicit next step still pending at the end of the timeline, nextStep must be an empty string.
- nextStep must never be null.
- recommendedNextStep must only be filled when nextStep is an empty string.
- recommendedNextStep should suggest one concise next action based on the current task state and supplied task logs.
- recommendedNextStep must not invent external facts or commitments; it should be a practical recommendation inferred from the task history.
- For PENDING or DOING tasks, prefer providing a recommendedNextStep when nextStep is empty and the logs contain enough context for a useful recommendation.
- If the task appears complete or there is no useful recommendation, recommendedNextStep must be an empty string.
- recommendedNextStep must never be null.
- Keep all JSON string values on one line. Replace any line breaks with spaces.
- Do not include markdown fences or prose outside JSON.`

export const DEFAULT_DAILY_SUMMARY_PROMPT = `You generate a daily work review from Chronicle focus data and work sessions.
Return Markdown only. Do not wrap the answer in code fences.

Required sections:
## Daily Summary
Briefly summarize the day in 2-4 bullets.

## Sessions Timeline
List chronological sessions as HH:MM-HH:MM [duration] task title.

## AFK & Time Analysis
Include AFK gaps longer than 1 minute, focus ratio, total active work time, and total AFK.

## Hourly Activity
Analyze each hour in the workday. Use text bars where one block is about 3 minutes of active work.

## Task Review
Review important completed and in-progress tasks. Mention concrete progress.

## Suggestions for Tomorrow
Give practical, prioritized suggestions for tomorrow based only on the supplied focus lines, task logs, task summaries, and time utilization.

Rules:
- Treat sessions, focus blocks, and task todayLogs as the only factual sources for what happened during this workday.
- recentContextBeforeToday is historical context only. Use it to understand task background, but do not count it as today's progress, today's timeline, or today's completed work.
- Be specific about time usage and AFK/work patterns.
- Keep observations factual and concise; avoid separate evaluation or pattern-analysis sections.
- Use the same language as the supplied data when possible.
- Do not invent external facts or commitments.
- Keep the result concise and useful.
- Do not include a "模式观察" (Pattern Observation) section or an "效率评价" (Efficiency Evaluation) section.
- Answer in Chinese.`
