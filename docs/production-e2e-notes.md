# Production E2E Notes

Last checked: 2026-06-18

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

Sentry routing proof:

- Worker deploy succeeded after Sentry route-map support: version `8ee8dcd8-0d18-443d-b2bd-b47ffc25237c`.
- `GET /api/config/status` reports `sentry.webhookConfigured=true`, `sentry.repoMapConfigured=false`, and `sentry.defaultRepo=null`.
- A signed synthetic webhook could not be sent from this machine because local `.dev.vars` does not currently include `SENTRY_WEBHOOK_SECRET`. Production does have the secret configured, so an end-to-end Sentry delivery test should be run from Sentry or from a local environment that has the matching webhook secret.

Job ledger proof:

- Worker deploy succeeded after the runner job ledger slice: version `fa8dd7e1-519f-4bc5-91e5-facedfb48fae`.
- Daytona runner deploy succeeded and keeps the job ledger at `/home/daytona/signal-factory-runner-data/jobs.jsonl`, outside the uploaded source directory so runner deploys do not wipe session history.
- `npm run smoke:production` passed against the live Worker and runner.
- The smoke admitted a no-repository job with `executionTarget=runner`, streamed 31 events from `openai-codex/gpt-5.5`, saw `agent_end`, and saw no provider/auth error.
- `GET /api/jobs?limit=10` returned the newly admitted smoke job, and `GET /api/jobs/{instanceId}` returned 200 for the same job.
- The read-only repository guard still rejected `WellDunDun/canary-compact` with 403 before runner dispatch because the GitHub App installation lacks write access.

Readiness proof:

- Worker deploy succeeded after the production readiness slice: version `81076617-4eef-489a-a7ea-14be79997adb`.
- Daytona runner deploy succeeded and refreshed the Worker's runner URL/token secrets.
- `npm run smoke:production` passed against the live Worker and runner with the new `GET /api/readiness` check.
- `GET /api/readiness` returned `state=blocked` with exactly one blocker, `worker:github-repositories`, because the GitHub App installation still has no writable repositories.
- `GET /api/readiness` returned exactly one warning, `worker:sentry-route`, because Sentry is signed/configured but still has no `SENTRY_REPO_MAP` or `SENTRY_DEFAULT_REPO`.
- The same smoke still admitted a no-repository runner job, streamed 31 events from `openai-codex/gpt-5.5`, saw `agent_end`, saw no provider/auth error, listed the new job through the app-owned ledger, and rejected the known read-only repo with 403.

Idempotency proof:

- Worker deploy succeeded after the idempotent admission slice: version `0752f257-8837-4d8f-9510-5e897afa03fe`.
- Daytona runner deploy succeeded after adding stage-level runner deploy logs and refreshed the Worker's runner URL/token secrets.
- `npm run smoke:production` passed against the live Worker and runner.
- The smoke sent a no-repository job with `Idempotency-Key`, streamed the original job to `agent_end`, then resent the same request with the same key.
- The duplicate admission returned 202 with `duplicateReused=true` and the same `manual:smoke-...` instance id instead of starting a second agent run.
- The same smoke still reached `openai-codex/gpt-5.5`, saw no provider/auth error, listed the smoke job through the app-owned ledger, and rejected the known read-only repo with 403.

Review-context tooling proof:

- Worker deploy succeeded after adding `github_get_review_context`: version `7ae6919f-cb9e-4496-a30f-48e3b48a1fcf`.
- Daytona runner deploy succeeded with the same toolset and refreshed the Worker's runner URL/token secrets.
- `npm run smoke:production` passed after deployment.
- The agent smoke still reached `openai-codex/gpt-5.5`, completed with `agent_end`, returned `duplicateReused=true` on the retry-safe admission check, listed the smoke job through the ledger, and rejected the known read-only repo with 403.
- Repo-backed use of `github_get_review_context` still requires a writable GitHub App repository because the tool operates on a prepared checkout and target branch before draft PR creation.

Automation controls proof:

- Worker deploy succeeded after adding GitHub/Sentry automation controls: version `338b07ad-a777-4363-ade2-17009c13b42e`.
- Daytona runner deploy succeeded with `FACTORY_AUTOMATION_STATE_PATH=/home/daytona/signal-factory-runner-data/automations.json` and refreshed the Worker's runner URL/token secrets.
- `npm run smoke:production` passed after deployment.
- The smoke listed two automation sources, paused Sentry through `PATCH /api/automations/sentry`, restored it through the same Worker route, and confirmed both updates returned 200.
- The same smoke still reached `openai-codex/gpt-5.5`, completed with `agent_end`, returned `duplicateReused=true` on the retry-safe admission check, listed the smoke job through the ledger, and rejected the known read-only repo with 403.
- GitHub and Sentry webhook paths now acknowledge paused automations with `skipped=true` and do not dispatch long-running agent work.

Runtime Sentry route config proof:

- Worker deploy succeeded after adding app-owned Sentry route configuration: version `85c9c02f-2db4-4478-8483-7a7cd11f752f`.
- Daytona runner deploy succeeded with `FACTORY_SENTRY_ROUTE_CONFIG_PATH=/home/daytona/signal-factory-runner-data/sentry-routes.json` and refreshed the Worker's runner URL/token secrets.
- `npm run smoke:production` passed against the live Worker and runner on 2026-06-18.
- The smoke read the current Sentry route config, patched a temporary `smoke-project` route to the visible GitHub App repository, verified the route persisted, and restored the original config. Both PATCH calls returned 200.
- The same smoke still reached `openai-codex/gpt-5.5`, completed with `agent_end`, returned `duplicateReused=true` on the retry-safe admission check, listed the smoke job through the ledger, and rejected the known read-only repo with 403.
- `GET /api/readiness` remains blocked only by `worker:github-repositories` because the GitHub App installation still has no writable repositories. It still warns on `worker:sentry-route` after the smoke restores the route config to its original empty state.

Runtime GitHub trigger config proof:

- Worker code deploy succeeded after adding app-owned GitHub trigger configuration: version `4354a5e5-c3f6-483f-a308-9cc3f0a98613`.
- Daytona runner deploy succeeded with `FACTORY_GITHUB_TRIGGER_CONFIG_PATH=/home/daytona/signal-factory-runner-data/github-trigger.json` and refreshed the Worker's runner URL/token secrets.
- `npm run smoke:production` passed against the live Worker and runner on 2026-06-18.
- The smoke read the current GitHub trigger config, patched a temporary `/factory-smoke` trigger phrase and `factory-smoke-bot` bot username, verified both persisted, and restored the original `/factory` trigger with no bot username. Both PATCH calls returned 200.
- The same smoke still reached `openai-codex/gpt-5.5`, completed with `agent_end`, returned `duplicateReused=true` on the retry-safe admission check, listed the smoke job through the ledger, proved Sentry route PATCH/restore, and rejected the known read-only repo with 403.
- `GET /api/readiness` remains blocked only by `worker:github-repositories` because the GitHub App installation still has no writable repositories.

Remaining product setup:

- Update the GitHub App installation so at least one target repository has write access. Then run the repo-backed production proof that creates a draft PR and stops before merge.
- Set `SENTRY_REPO_MAP` or `SENTRY_DEFAULT_REPO`, then run a real or signed synthetic Sentry webhook proof.
