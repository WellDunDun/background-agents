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

## Current Blocker

Codex subscription-backed model calls do not complete from the Cloudflare Worker runtime.

Observed production stream behavior:

- The agent starts and selects `openai-codex/gpt-5.5`.
- The first model call reaches the `openai-codex-responses` provider.
- `transport: "auto"` first failed through the Worker WebSocket path.
- Forcing `transport: "sse"` removed the WebSocket failure, but `chatgpt.com/backend-api` still returned a Cloudflare block page to the Worker.

The same Codex refresh token works from local Node with the same `openai-codex/gpt-5.5` model and `transport: "sse"`, so the token itself is valid.

## Implication

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

The next production proof requires hosting the Node runner, setting FACTORY_RUNNER_URL on the Worker, then rerunning the no-repo smoke job. A passing run should show model output instead of a chatgpt.com Cloudflare block page.

Daytona runner deployment is scripted with npm run runner:deploy:daytona. The script creates or reuses a public Daytona sandbox named signal-factory-runner, uploads the committed source archive, writes runner secrets to .runner.env inside the sandbox, builds dist-node, starts npm run start:node as a Daytona background session, and returns the public preview URL. The Worker should store that URL in FACTORY_RUNNER_URL and the shared token in FACTORY_RUNNER_TOKEN.

Sentry is not fully actionable until `SENTRY_DEFAULT_REPO` or a per-project routing table is configured.
