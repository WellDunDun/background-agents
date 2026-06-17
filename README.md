# Flue Factory

Flue Factory is a Flue-native software factory for durable autonomous coding jobs.

This branch intentionally starts clean instead of retrofitting the old background-agents control plane. The product shape stays the same: a signal creates a job, an orchestrator admits work to a durable agent instance, implementation and review agents iterate, and a human explicitly approves any merge.

## First slice

- Cloudflare Worker entrypoint with a manual job API.
- Durable Flue agents for orchestration, implementation, and review.
- Daytona-backed workspaces for repo execution.
- GitHub App tools for repo access, checkout, branch push, PR creation, and PR comments.
- Runtime-verified GitHub webhook ingress for issue and PR review signals.
- Runner-aware admission: Cloudflare can forward jobs to a Node runner for Codex subscription execution.
- A finite kickoff workflow for Studio/CLI smoke tests.
- Project skills for implementation, review, and scaffolding work.
- Cloudflare migrations for Flue-generated Durable Objects.

## Commands

- npm install
- npm run typecheck
- npm run build:cloudflare
- npm run build:node
- npm run dev
- npm run dev:node
- npm run deploy:dry-run
- npm run deploy
- npm run smoke:production

Cloudflare development uses .dev.vars; production secrets should be set through Wrangler secrets or the deployment platform, not committed files.

Flue builds the deployable Cloudflare Worker into dist/flue_factory. The deploy scripts run flue build first, then pass the generated Wrangler config in that output directory to Wrangler.

Flue builds the Node runner into dist-node. Start it with npm run start:node after supplying runtime environment variables.

Run npm run smoke:production after a deploy to verify the live Worker health route, protected config status, production readiness endpoint, GitHub repository readiness endpoint, read-only repository guard when applicable, job ledger list/detail, and a non-repository Codex-backed live agent stream. The smoke script reads secrets from .dev.vars or the process environment and does not print token values.

## Configuration

Set these as local .dev.vars values for development and as Cloudflare Worker secrets for production:

- FACTORY_API_TOKEN: bearer token required for manual API and config-status routes.
- FACTORY_RUNNER_URL and FACTORY_RUNNER_TOKEN: set on the Cloudflare Worker when jobs should execute on the Node runner instead of inside the Worker.
- OPENAI_CODEX_ACCESS_TOKEN or OPENAI_CODEX_REFRESH_TOKEN: ChatGPT/Codex subscription credential for openai-codex models. OPENAI_API_KEY is only for direct openai/* models.
- DAYTONA_API_KEY: Daytona workspace provider key.
- GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: GitHub App credentials for repository access and PR creation.
- GITHUB_WEBHOOK_SECRET: GitHub webhook secret for verified inbound signal delivery.
- SENTRY_WEBHOOK_SECRET: Sentry webhook signature secret.
- SENTRY_REPO_MAP: JSON object mapping Sentry project slugs to `{ "repo": "owner/name", "baseBranch": "main" }` route objects. A string value is also accepted and defaults the base branch to main. Use `*` or `_default` for a map fallback.
- SENTRY_DEFAULT_REPO: legacy fallback target repo for Sentry-triggered factory work when SENTRY_REPO_MAP has no matching route.

Optional GitHub trigger settings:

- FACTORY_GITHUB_TRIGGER_PHRASE defaults to /factory.
- GITHUB_BOT_USERNAME enables @bot mention triggers in issue and PR comments.

## API

POST /api/jobs admits a manual code factory job and dispatches it to the continuing orchestrator agent. Send Authorization: Bearer <FACTORY_API_TOKEN>.

Expected JSON body:

{
  "prompt": "Implement the requested change.",
  "repo": "WellDunDun/example",
  "baseBranch": "main"
}

The route returns 202 Accepted with the factory job id and Flue dispatch receipt. If FACTORY_RUNNER_URL is configured, the Worker forwards the admitted job to the runner's protected /api/runner/jobs route. Otherwise the local Flue runtime dispatches it directly, which is intended for the Node runner and local development.

When a runner is configured, clients should read events through the Worker-local stream proxy:

GET /api/jobs/{instanceId}/events

Send Authorization: Bearer <FACTORY_API_TOKEN>. The Worker uses FACTORY_RUNNER_TOKEN when it reads the runner's Flue stream.

GET /api/jobs lists recent app-owned factory job admission records. GET /api/jobs/{instanceId} returns one record. In production these endpoints proxy to the Node runner ledger through FACTORY_RUNNER_TOKEN and rewrite streamUrl to the Worker event proxy.

GET /api/config/status returns non-secret configuration readiness for the operator UI or deployment smoke tests. It also requires Authorization: Bearer <FACTORY_API_TOKEN>.

GET /api/readiness returns non-secret production readiness checks with pass/warn/block statuses for Worker ingress, runner runtime, Codex auth, workspace configuration, GitHub App access, writable GitHub repositories, GitHub webhook, Sentry webhook, and Sentry repository routing. It requires Authorization: Bearer <FACTORY_API_TOKEN>. When FACTORY_RUNNER_URL is configured, the Worker reads the runner's protected /api/runner/readiness endpoint and combines both scopes so runner-owned secrets do not need to be duplicated in the Worker. This endpoint is intended for the operator UI and deployment smoke tests; it reports external setup blockers without exposing secret values.

GET /api/github/repositories returns the GitHub App installation repositories visible to the factory, including default branch and write-readiness flags for repo selection UIs. It requires Authorization: Bearer <FACTORY_API_TOKEN>. A repo-backed job needs a repository where writable=true; otherwise the agent can inspect but cannot push a factory branch or create the draft PR.

When a manual job, GitHub signal, Sentry signal, or workflow payload includes repo, admission validates that the configured GitHub App installation can access the repository and has write permission before dispatching the long-running agent. Read-only repositories return 403 immediately.

## Node Runner

Codex subscription-backed calls to chatgpt.com/backend-api are blocked from Cloudflare Workers, but the same refresh token works from Node. Production should therefore run the Worker as ingress and the Node target as the execution runner.

Worker responsibilities:

- Verify manual, GitHub, and Sentry ingress.
- Admit jobs and forward them to the runner.
- Proxy event streams back to clients.

Runner responsibilities:

- Execute the Flue orchestrator.
- Create Daytona sandboxes.
- Use the Codex refresh token.
- Perform GitHub branch and PR work.

Run the Node runner locally:

1. npm run build:node
2. PORT=3584 npm run start:node

Deploy the Node runner to Daytona:

1. Ensure .dev.vars contains FACTORY_RUNNER_TOKEN, OPENAI_CODEX_REFRESH_TOKEN or OPENAI_CODEX_ACCESS_TOKEN, DAYTONA_API_KEY, and GitHub App credentials.
2. npm run runner:deploy:daytona
3. Set FACTORY_RUNNER_URL on the Worker to the printed runnerUrl and FACTORY_RUNNER_TOKEN to the same token.

The deploy script packages the committed source with git archive, uploads it to a public Daytona sandbox, writes runtime secrets to a private .runner.env file inside that sandbox, builds the Node target, starts it as a Daytona background session, and waits for /health. Use --configure-worker to have the script write FACTORY_RUNNER_URL and FACTORY_RUNNER_TOKEN via wrangler secret put.

The runner script creates a Daytona sandbox from `node:22-bookworm` with 2 vCPU, 4 GiB RAM, and 10 GiB disk by default. Override this with FACTORY_RUNNER_IMAGE, FACTORY_RUNNER_CPU, FACTORY_RUNNER_MEMORY_GIB, and FACTORY_RUNNER_DISK_GIB in the local deploy environment if your Daytona quota requires different limits. If an existing runner sandbox is undersized, the script recreates it.

By default the deployed Daytona runner sets FACTORY_WORKSPACE_PROVIDER=runner. That means the runner sandbox itself is the Flue local workspace boundary for jobs, with per-job directories under /tmp/signal-factory-jobs. This avoids a nested Daytona runner creating a second Daytona sandbox and then failing on provider proxy resets. For a non-Daytona Node host, unset FACTORY_WORKSPACE_PROVIDER to return to per-job Daytona workspaces.

The Codex OAuth refresh token is rotating. The runner sets FACTORY_CODEX_CREDENTIALS_PATH=.runner.env so successful refreshes update the runner's private env file and in-memory process env before the old refresh token is reused.

The runner also sets FACTORY_JOB_LEDGER_PATH=/home/daytona/signal-factory-runner-data/jobs.jsonl by default. This keeps non-secret job admission records outside the app deploy directory so runner redeploys do not wipe the sessions list.

Required runner env values:

- FACTORY_RUNNER_TOKEN: shared secret for Worker-to-runner admission and stream reads.
- OPENAI_CODEX_REFRESH_TOKEN or OPENAI_CODEX_ACCESS_TOKEN.
- DAYTONA_API_KEY and related Daytona settings.
- GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.

Configure the Worker with FACTORY_RUNNER_URL and the same FACTORY_RUNNER_TOKEN.

## GitHub Webhook

The GitHub webhook route is mounted at:

https://<worker-host>/channels/github/webhook

Configure the GitHub App webhook with application/json content and the same GITHUB_WEBHOOK_SECRET. Subscribe initially to Issues, Issue comments, and Pull request review comments.

The route verifies X-Hub-Signature-256 with the runtime Cloudflare Worker secret binding before it dispatches durable Flue work. This avoids baking the webhook secret into the Worker bundle.

The factory only admits GitHub signals that contain FACTORY_GITHUB_TRIGGER_PHRASE or mention GITHUB_BOT_USERNAME. This keeps ordinary issue traffic from starting autonomous work.

## Sentry Webhook

The Sentry webhook route is mounted at:

https://<worker-host>/webhooks/sentry

Configure Sentry to send issue alert or critical metric alert webhooks with the same SENTRY_WEBHOOK_SECRET. Sentry payloads are signed with the sentry-hook-signature HMAC header. The factory resolves accepted Sentry signals through SENTRY_REPO_MAP first, then `*` / `_default` map entries, then SENTRY_DEFAULT_REPO and SENTRY_DEFAULT_BASE_BRANCH. It admits only levels in SENTRY_ACCEPT_LEVELS.
