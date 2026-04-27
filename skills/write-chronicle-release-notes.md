---
name: chronicle-write-release-notes
description: Write or update Chronicle release notes by diffing since the last release commit
---

When asked to write or update release notes for the Chronicle project, follow these steps:

## Step 1: Find the latest release note file

List all `release-notes-*.md` files in the project root:

```bash
ls /Users/yanke/IdeaProjects/Chronicle/release-notes-*.md
```

Parse the semver from each filename (e.g. `release-notes-1.2.0.md` → `1.2.0`). Determine the latest version by comparing major/minor/patch numbers (highest wins).

## Step 2: Read the latest release note

```bash
cat /Users/yanke/IdeaProjects/Chronicle/release-notes-<version>.md
```

Understand what's already documented so you know what's covered vs. what's new.

## Step 3: Find the release commit

Use `git log --all --follow` to find the commit that added or last modified the release note file:

```bash
cd /Users/yanke/IdeaProjects/Chronicle && git log --all --follow --oneline -- release-notes-<version>.md
```

The latest commit touching this file is the release commit.

## Step 4: Get the diff since release

List all commits after the release commit:

```bash
cd /Users/yanke/IdeaProjects/Chronicle && git log --oneline <release-commit-hash>..HEAD
```

For detailed diff stats:

```bash
cd /Users/yanke/IdeaProjects/Chronicle && git diff <release-commit-hash>..HEAD --stat
```

Read each commit message with full body:

```bash
cd /Users/yanke/IdeaProjects/Chronicle && git log --format="%H %s%n%b---" <release-commit-hash>..HEAD
```

For any files you need more detail on:

```bash
cd /Users/yanke/IdeaProjects/Chronicle && git diff <release-commit-hash>..HEAD -- <file-path>
```

## Step 5: Categorize and summarize changes

Group changes into logical categories:
- **New Features** — new user-facing functionality
- **Improvements** — enhancements to existing features
- **Bug Fixes** — bug fixes and corrections
- **Security** — security hardening
- **Build & Infrastructure** — build process, CI/CD, config changes
- **API Changes** — API endpoint or response changes
- **Tech Stack Updates** — dependency changes
- **Migration** — database migration or data migration notes

For each group, write concise bullet points describing WHAT changed and WHY it matters. Reference specific UI components, API endpoints, or commands where relevant.

## Step 6: Write into the release note file

Update the file at `/Users/yanke/IdeaProjects/Chronicle/release-notes-<version>.md`:

- If the release note covers the latest release and there are new changes after it: add a `## Post-v<version> Changes` section at the end
- If you're creating a new version: copy the file to `release-notes-<new-version>.md` and update the header and summary at the top

## Step 7: Verify

```bash
cat /Users/yanke/IdeaProjects/Chronicle/release-notes-<version>.md
```

Confirm the file reads well and covers all changes.
