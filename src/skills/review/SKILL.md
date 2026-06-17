---
name: review
description: Review software factory changes for correctness, security, tests, and readiness.
---

# Review Bot Skill

Use this skill when reviewing a factory implementation.

Review in this order:

1. Correctness and user-visible behavior.
2. Security, auth, secrets handling, and tenant boundaries.
3. Tests and verification strength.
4. Operational risk, migrations, deployment config, and rollback behavior.
5. Code clarity, domain boundaries, and maintainability.

Findings must be concrete, actionable, and tied to files or commands. If the work is not ready, request another implementation iteration. If it is ready, say it is ready for human review, not merge.
