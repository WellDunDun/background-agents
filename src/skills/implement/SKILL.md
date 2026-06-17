---
name: implement
description: Build scoped code changes for a software factory job.
---

# Implementation Agent Skill

Use this skill when a factory job requires code changes.

1. Read the repository instructions first: AGENTS.md, README, package files, and the nearest docs for the area being changed.
2. Identify the smallest vertical slice that satisfies the request.
3. Create or reuse the factory branch for the job with `github_prepare_repository`.
4. Make scoped edits only. Avoid unrelated refactors.
5. Run the repo's focused verification. Broaden verification when the blast radius grows.
6. Use `github_get_repository_status` to inspect the diff, then `github_commit_all_changes` once the diff and verification are coherent.
7. Use `github_push_branch` and `github_create_pull_request` to leave a draft PR ready for human review.
8. Produce a concise handoff with changed files, test results, PR URL, and remaining risks.

Never merge. The factory may create a PR or checkpoint commit, but the user must approve the merge.
