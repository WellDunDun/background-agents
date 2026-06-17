---
name: implement
description: Build scoped code changes for a software factory job.
---

# Implementation Agent Skill

Use this skill when a factory job requires code changes.

1. Read the repository instructions first: AGENTS.md, README, package files, and the nearest docs for the area being changed.
2. Identify the smallest vertical slice that satisfies the request.
3. Create or reuse the factory branch for the job with `github_prepare_repository`; if choosing from `github_list_accessible_repositories`, use only repositories with `writable=true`.
4. Make scoped edits only. Avoid unrelated refactors.
5. Run the repo's focused verification. Broaden verification when the blast radius grows.
6. Use `github_get_repository_status` to inspect the worktree, then `github_get_review_context` to collect branch, commit, changed-file, diff-stat, diff-check, and bounded diff-preview evidence.
7. Use `github_commit_all_changes` once the diff and verification are coherent.
8. Use `github_push_branch` and `github_create_pull_request` to leave a draft PR ready for human review.
9. Produce a concise handoff with changed files, test results, review-context findings, PR URL, and remaining risks.

Never merge. The factory may create a PR or checkpoint commit, but the user must approve the merge.
