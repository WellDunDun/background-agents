# Production E2E Notes

Last checked: 2026-06-17

## What Works

- The Cloudflare Worker deploys from the generated Flue config at `dist/flue_factory/wrangler.json`.
- `GET /health` returns 200 in production.
- `GET /api/config/status` returns 200 with the production `FACTORY_API_TOKEN`.
- Runtime Worker secrets are configured for:
  - Codex refresh-token auth
  - Daytona
  - GitHub App access
  - GitHub webhook verification
  - Sentry webhook verification
- A no-repository `POST /api/jobs` production smoke request returns 202 and opens a durable Flue agent event stream.

## Historical Codex Worker Blocker

Codex subscription-backed model calls do not complete from the Cloudflare Worker runtime.

Observed production stream behavior:

- The agent starts and selects `openai-codex/gpt-5.5`.
- The first model call reaches the `openai-codex-responses` provider.
- `transport: "auto"` first failed through the Worker WebSocket path.
- Forcing `transport: "sse"` removed the WebSocket failure, but `chatgpt.com/backend-api` still returned a Cloudflare block page to the Worker.

The same Codex refresh token works from local Node with the same `openai-codex/gpt-5.5` model and `transport: "sse"`, so the token itself is valid.

## Architecture Implication

For the Codex subscription path, the factory should not execute ChatGPT/Codex provider calls inside Cloudflare Workers. Keep the Worker as the secure ingress/control plane, but run the subscription-backed coding runtime in a normal Node environment, ideally the Daytona runner/sandbox layer, then stream durable events back through the Worker.

The alternative is to use an official OpenAI API key or Cloudflare AI Gateway-compatible provider from the Worker. That is not equivalent to the user's Codex subscription.

## Follow-Up Architecture

- Cloudflare Worker:
  - GitHub/Sentry/manual signal admission
  - auth and configuration status
  - durable job records and event relay
- Daytona/Node runner:
  - Flue or Codex harness execution
  - Codex subscription refresh token use
  - repository checkout, implementation, review, commits, and PR creation
- UI:
  - read job status/events from the Worker
  - link directly to runner logs or Flue/agent stream coordinates

## Implemented Runner Boundary

The codebase now supports this split:

- Set FACTORY_RUNNER_URL and FACTORY_RUNNER_TOKEN on the Worker to forward admitted jobs to a Node runner.
- Start the Node runner from the same source with npm run build:node and npm run start:node.
- Leave FACTORY_RUNNER_URL unset on the runner so /api/runner/jobs dispatches the Flue orchestrator locally.
- Read runner-backed job streams through the Worker at /api/jobs/{instanceId}/events.

Daytona runner deployment is scripted with npm run runner:deploy:daytona. The script creates or reuses a public Daytona sandbox named signal-factory-runner, uploads the committed source archive, writes runner secrets to .runner.env inside the sandbox, builds dist-node, starts npm run start:node as a Daytona background session, and returns the public preview URL. The Worker should store that URL in FACTORY_RUNNER_URL and the shared token in FACTORY_RUNNER_TOKEN.

## Production Proof on 2026-06-17

Proven:

- Cloudflare Worker deploy succeeds and serves /health.
- /api/config/status is protected by FACTORY_API_TOKEN and reports runner.configured=true.
- Daytona runner deploy succeeds on a public Daytona sandbox and starts the Flue Node target.
- Worker /api/jobs forwards admission to the Daytona runner and returns executionTarget=runner.
- Worker /api/jobs/{instanceId}/events proxies the runner's Flue event stream with FACTORY_API_TOKEN.
- Runner workspace mode avoids nested Daytona sandbox proxy failures by using the Daytona runner sandbox as the Flue local workspace boundary.
- The stream reaches the openai-codex provider; there is no longer a Cloudflare Worker block page.

Resolved credential issue:

- The runner now uses an unexpired Codex access token first and refreshes only when the access token is missing or near expiry. This avoids consuming one-time Codex refresh tokens unnecessarily.
- Run `npm run auth:sync-codex` after `codex login` to copy the local Codex CLI OAuth token pair into the ignored `.dev.vars` file without printing token values.
- The runner still persists rotated Codex credentials to `.runner.env` through `FACTORY_CODEX_CREDENTIALS_PATH` after a successful refresh.

Latest production smoke:

- `npm run auth:sync-codex` succeeded from `~/.codex/auth.json`.
- `npm run verify` succeeded.
- `npm run runner:deploy:daytona -- --configure-worker` succeeded and refreshed `FACTORY_RUNNER_URL` / `FACTORY_RUNNER_TOKEN` on the Worker.
- A no-repository `POST /api/jobs` returned 202 with `executionTarget=runner`.
- `GET /api/jobs/{instanceId}/events?offset=-1&live=sse` returned a live Flue event stream with `operation_start`, `agent_start`, `turn_start`, `text_delta`, `turn_messages`, `turn`, and `agent_end`.
- The stream reached `openai-codex/gpt-5.5`, produced the expected smoke-test text, and had no Codex provider/auth/Cloudflare block error.

Latest deployed version after repo lifecycle hardening:

- Worker deploy succeeded: version `21b47edd-585f-4c95-a850-21c8e246c085`.
- Daytona runner deploy succeeded and refreshed `FACTORY_RUNNER_URL` / `FACTORY_RUNNER_TOKEN` on the Worker.
- `GET /api/github/repositories` returned 200 in production and exposed repository write-readiness for the operator UI.
- The current GitHub App installation exposes `WellDunDun/canary-compact`, but GitHub reports `writable=false` with no pull/push/triage/maintain/admin permissions. A repo-backed PR proof requires installing or updating the GitHub App with write access to at least one target repository.
- A post-deploy no-repository smoke still returned 202 with `executionTarget=runner`, streamed 45 live SSE events, reached `openai-codex/gpt-5.5`, emitted `agent_end`, and had no provider/auth/Cloudflare block error.

Admission guard proof:

- Worker deploy succeeded after the read-only repo admission guard: version `9b29cfb0-61de-40d5-88a4-a535e56a05d3`.
- A repo-backed `POST /api/jobs` against the known read-only repository `WellDunDun/canary-compact` returned 403 before runner dispatch.
- The 403 response explains that the GitHub App installation has no write access and must be updated before repo-backed jobs can create branches or draft PRs.

Remaining product setup:

- Update the GitHub App installation so at least one target repository has write access. Then run the repo-backed production proof that creates a draft PR and stops before merge.
- Sentry is not fully actionable until `SENTRY_DEFAULT_REPO` or a per-project routing table is configured.
