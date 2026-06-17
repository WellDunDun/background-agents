# Flue-Native Software Factory Plan

## Status

This is the clean-room plan for a Flue-native software factory. It intentionally does not extend the
checkpointed retrofit branch, codex/flue-runtime, where Flue was embedded inside the existing
background-agents sandbox runtime. That checkpoint remains useful as reference, but the design below
uses Flue's own primitives first.

## Docs Reviewed

- Flue Cloudflare deploy: https://flueframework.com/docs/ecosystem/deploy/cloudflare/
- Flue Cloudflare target: https://flueframework.com/docs/guide/targets/cloudflare/
- Flue Daytona sandbox: https://flueframework.com/docs/ecosystem/sandboxes/daytona/
- Flue sandboxes: https://flueframework.com/docs/guide/sandboxes/
- Flue agents: https://flueframework.com/docs/guide/building-agents/
- Flue subagents: https://flueframework.com/docs/guide/subagents/
- Flue skills: https://flueframework.com/docs/guide/skills/
- Flue workflows: https://flueframework.com/docs/guide/workflows/
- Flue channels: https://flueframework.com/docs/guide/channels/
- Flue GitHub channel: https://flueframework.com/docs/ecosystem/channels/github/
- Flue Linear channel: https://flueframework.com/docs/ecosystem/channels/linear/
- Flue Sentry tooling: https://flueframework.com/docs/ecosystem/tooling/sentry/
- Flue observability: https://flueframework.com/docs/guide/observability/
- Flue durable execution: https://flueframework.com/docs/concepts/durable-execution/
- Flue add command: https://flueframework.com/docs/cli/add/

Local source of truth used while writing this: installed docs under node_modules/@flue/sdk/docs,
matching the installed Flue package version.

## Product Definition

The factory is autonomous only after explicit user or signal admission. It can plan, edit code, open
a PR, and iterate based on review feedback. It must not merge without explicit user approval.

Core capabilities:

- Start from a command, GitHub issue/comment, PR review event, or selected external signal.
- Create or reuse a Daytona sandbox for the target repo/project.
- Run a specialized implementation agent with repo-aware skills.
- Run a specialized review bot before handoff.
- Push a branch and create/update a PR.
- Iterate from review comments until it reaches a ready-for-human-review state.
- Preserve observable history, errors, model/tool usage, and job state.

## What Flue Gives Us

Flue gives us the core agent runtime that we should stop rebuilding:

- Cloudflare target with generated Durable Object-backed agents and workflows.
- Durable per-agent submission queue for direct prompts and dispatch inputs.
- Durable event streams replayable by offset.
- Agent modules in src/agents.
- Workflow modules in src/workflows.
- Channels in src/channels.
- dispatch for asynchronous signals.
- Subagents through agent profiles.
- Skills imported at build time or discovered from cwd/.agents/skills.
- Hono routing through src/app.ts and flue routing.
- observe for workflow and continuing-agent telemetry.
- Blueprints through flue add, including Daytona, GitHub, Linear, and Sentry.

## What We Still Own

Flue deliberately leaves product policy and provider lifecycle to the application:

- GitHub App installation, repo authorization, and least-privilege access policy.
- Daytona sandbox creation, image/snapshot choice, region, retention, env, and cleanup.
- Mapping an external signal to a factory job and agent instance id.
- Repo checkout/bootstrap inside the sandbox.
- Idempotency for external effects such as comments, branches, commits, PRs, and deploys.
- Human approval policy for merges.
- UI and operator controls.
- Secret management and rotation.
- Sentry alert ingestion if we want Sentry to trigger work. The installed Flue docs expose Sentry as
  error-reporting tooling, not an inbound Sentry alert channel.

## Architecture

Operator UI, GitHub channel, Linear channel, and custom Sentry alert routes all enter the Flue
Cloudflare Worker. The Worker dispatches durable input to an orchestrator agent Durable Object. The
orchestrator creates or resumes a Daytona sandbox through application-owned lifecycle code,
delegates to implementation and review specialists, and uses narrow GitHub App tools for comments,
branches, commits, and PRs. Observability flows through observe, Sentry, and later OpenTelemetry or
Braintrust if we choose to export richer traces.

Recommended first deployment shape:

- One Cloudflare-targeted Flue app.
- src/app.ts mounts authenticated app routes plus Flue routes.
- wrangler.jsonc owns Cloudflare migrations and bindings.
- Generated Flue Durable Objects own continuing agent queues and session history.
- Application-owned metadata store tracks factory jobs, repo config, sandbox ids, PR ids, and
  approval state. Use D1 or an application-owned Durable Object; do not put product metadata into
  Flue internals.

## Source Layout

Use a clean Flue app layout at the project root or in a new standalone repo:

- src/app.ts
- src/agents/orchestrator.ts
- src/agents/implementation-agent.ts
- src/agents/review-bot.ts
- src/channels/github.ts
- src/channels/linear.ts
- src/workflows/start-factory-job.ts
- src/workflows/create-project.ts
- src/workflows/review-pr.ts
- src/sandboxes/daytona.ts
- src/skills/implement/SKILL.md
- src/skills/review/SKILL.md
- src/skills/scaffold-project/SKILL.md
- src/skills/debug-failure/SKILL.md
- src/skills/security-review/SKILL.md
- src/shared/github-app.ts
- src/shared/job-store.ts
- src/shared/sandbox-lifecycle.ts
- src/shared/repo-policy.ts
- src/shared/idempotency.ts
- wrangler.jsonc
- flue.config.ts
- package.json

If we keep this inside /Users/danielpetro/Documents/flue-factory, the cleanest path is to make that
directory the Flue project root on the new branch. The old background-agents packages should be
treated as reference material, not as the active runtime.

## Agents

### orchestrator

Continuing agent. Owns the job thread and coordinates factory work.

Responsibilities:

- Understand the requested outcome.
- Validate repo/project authorization.
- Decide whether to scaffold, modify, review, or ask for clarification.
- Create or reuse a Daytona sandbox through application tools.
- Delegate implementation to the implementation specialist.
- Delegate review to the review specialist.
- Decide when a PR is ready for user review.

Instance id:

- Existing repo work: repo owner/repo plus issue or PR number.
- New project work: an idea id until a repo exists, then a stored mapping.

### implementation-agent

Specialized coding agent/profile. Runs inside a Daytona sandbox via Flue's Daytona adapter.

Responsibilities:

- Inspect the codebase first.
- Use project skills and repo-discovered skills.
- Make scoped code changes.
- Run relevant tests.
- Commit changes to a branch only through approved tools/policy.

### review-bot

Specialized review agent/profile.

Responsibilities:

- Review diffs and test evidence.
- Produce findings with file and line references.
- Decide whether more implementation is needed.
- Never merge.

## Workflows

Use workflows for bounded, inspectable jobs, not for the whole long-running factory loop.

Good workflow candidates:

- start-factory-job: validate a UI/API request and dispatch to orchestrator.
- create-project: bounded repo/scaffold/bootstrap operation.
- review-pr: bounded review pass for one PR snapshot.
- rotate-or-clean-sandbox: cleanup and maintenance task.

The docs are explicit that Flue workflows are finite invocations and do not resume arbitrary
TypeScript execution after interruption. Long-running autonomous work should live in continuing
agents using durable direct or dispatched input.

## Triggers And Channels

### GitHub

Use flue add channel github as the starting point.

Use cases:

- Issue comment triggers a factory job.
- PR review comment dispatches iteration input to the same job.
- PR review requested triggers review-bot.
- GitHub tools post comments, create or update branches, and open PRs.

Security:

- Prefer GitHub App installation tokens over broad PATs.
- Subscribe to the minimum webhook event set.
- Use delivery id as an idempotency key.

### Linear

Hold for later unless GitHub Issues proves insufficient. The Flue Linear channel exists and supports
resource webhooks plus agent-session webhooks.

### Sentry

Use flue add tooling sentry for reporting Flue workflow failures and explicit error logs.

For Sentry as an inbound trigger, implement an application-owned Hono route or custom channel:

- Verify Sentry webhook signatures.
- Normalize alert or issue payload.
- Dispatch to orchestrator with an id based on project plus Sentry issue id.

This is application code because the installed Flue docs describe Sentry as tooling, not as an
inbound signal channel.

### UI Commands

Use app-owned authenticated routes in src/app.ts to admit work:

- POST /api/jobs
- GET /api/jobs/:id
- POST /api/jobs/:id/cancel
- POST /api/jobs/:id/approve-merge

Those routes can call dispatch and use Flue SDK/run APIs for streaming and inspection.

## Daytona Integration

Use Flue's Daytona blueprint:

- flue add sandbox daytona

Important docs constraint: the adapter takes an already-initialized Daytona sandbox. The application
still owns lifecycle:

- Create sandbox with @daytona/sdk.
- Pick snapshot/image, region, env, volume, and retention.
- Clone or mount repo.
- Pass the sandbox to the Daytona adapter.
- Persist sandbox id against the factory job.
- Delete or archive based on policy.

This is the design that replaces the retrofit branch's local sandbox approach.

## Cloudflare Deployment

Use Flue's Cloudflare target:

- npx flue build --target cloudflare
- npx wrangler deploy --dry-run --config dist/<worker-name>/wrangler.json
- npx wrangler deploy --config dist/<worker-name>/wrangler.json

Key requirements from the docs:

- Install agents version 0.14.x.
- Enable nodejs_compat.
- Let Flue generate Durable Object classes and bindings.
- Declare generated Durable Object migrations in wrangler.jsonc.
- Always include FlueRegistry in the initial migration.
- Deploy the generated Wrangler config under dist, not the source-root config.
- Use flue dev --target cloudflare locally; flue run is Node-only.
- Store production secrets with Wrangler or Cloudflare secret binding, not checked-in files.

## Observability

Start with:

- observe in src/app.ts.
- flue add tooling sentry for workflow failures and explicit error logs.
- Structured log calls in workflows.
- Correlation ids: job id, repo, issue or PR, dispatch id, sandbox id, branch, PR number.

Then decide whether to add:

- OpenTelemetry if we want vendor-neutral traces and ClickHouse ingestion.
- Braintrust if we want content-bearing agent traces and eval-oriented debugging.

Data handling policy:

- Do not export prompts, code, tool args, or secrets by default.
- Log outcome and cost first.
- Expand trace content only after we decide retention and access rules.

## Security And Approval

Hard rules:

- No merge without explicit user approval.
- No broad environment exposure to model-directed shells.
- Use narrow tools for GitHub side effects.
- All external side effects need idempotency keys.
- Sandbox credentials should be scoped per job and repo where possible.
- Webhook routes verify signatures before dispatch.
- Job admission checks repo installation and user authorization.

## First Vertical Slice

Build the smallest useful factory:

1. Create clean Flue Cloudflare app.
2. Add Daytona sandbox blueprint.
3. Add GitHub channel blueprint.
4. Add Sentry tooling blueprint.
5. Implement orchestrator with imported implement and review skills.
6. Implement Daytona lifecycle service that creates one sandbox per job.
7. Implement GitHub App tools for checkout metadata, branch creation, commit/push, PR open/update,
   and PR comments.
8. Implement UI/API route to start a job manually.
9. Implement GitHub issue-comment trigger.
10. Run one e2e production test: create issue/comment, dispatch job, create Daytona sandbox, make a
    small code edit, run tests, push branch, open PR, run review bot, and mark ready for human
    review.

## Implementation Branch Strategy

- codex/flue-runtime: checkpointed retrofit branch.
- codex/flue-native-plan: this plan.
- Next branch should be codex/flue-native-slice-1, starting from this plan branch or a clean repo
  scaffold, depending on whether we want the plan committed in the target repo.

## Open Decisions

1. Is /Users/danielpetro/Documents/flue-factory the final standalone repo, or should we create a new
   clean GitHub repo for the Flue-native implementation?
2. Should the first production target use Cloudflare Sandbox or Daytona? Current product direction
   says Daytona; Cloudflare Sandbox is a viable later simplification if its container/runtime limits
   match our needs.
3. Should content-bearing traces go to Braintrust, OpenTelemetry/ClickHouse, or stay disabled until
   the first e2e factory job works?
4. Which model/provider should the first implementation agent use: openai-codex/gpt-5.5,
   openai/gpt-5.5, or another Flue-supported provider?
5. Which trigger ships first: manual UI/API command or GitHub issue comment? Recommendation: manual
   first, GitHub issue comment second.
