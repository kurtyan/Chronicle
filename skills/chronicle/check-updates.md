---
name: chronicle-check-updates
description: Check for Chronicle skill updates
---

When the user runs `/chronicle-check-updates` or asks "check chronicle skill updates", do the following:

## Step 1: Read current version

Read `<project>/skills/manifest.json` to get the latest version and skill list.

Read `~/.chronicle/skills-version` to get the currently installed version.

## Step 2: Compare

If the versions match: "Chronicle skills are up to date (v{version})."

If the manifest version is newer: "New Chronicle skills available (v{installed} → v{latest}). Skills: {list of skill names}. Run 'Install Chronicle skills' to update."

If `~/.chronicle/skills-version` doesn't exist: "Chronicle skills are not installed. Run 'Install Chronicle skills' to set them up."
