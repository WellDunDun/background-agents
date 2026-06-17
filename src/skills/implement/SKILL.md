---
name: implement
description: Build scoped code changes for a software factory job.
---

# Implementation Agent Skill

Use this skill when a factory job requires code changes.

1. Read the repository instructions first: AGENTS.md, README, package files, and the nearest docs for the area being changed.
2. Identify the smallest vertical slice that satisfies the request.
3. Create or reuse the factory branch for the job.
4. Make scoped edits only. Avoid unrelated refactors.
5. Run the repo's focused verification. Broaden verification when the blast radius grows.
6. Commit only after the diff and verification are coherent.
7. Produce a concise handoff with changed files, test results, and remaining risks.

Never merge. The factory may create a PR or checkpoint commit, but the user must approve the merge.
