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

Cloudflare development uses .dev.vars; production secrets should be set through Wrangler secrets or the deployment platform, not committed files.

Flue builds the deployable Cloudflare Worker into dist/flue_factory. The deploy scripts run flue build first, then pass the generated Wrangler config in that output directory to Wrangler.

Flue builds the Node runner into dist-node. Start it with npm run start:node after supplying runtime environment variables.

## Configuration

Set these as local .dev.vars values for development and as Cloudflare Worker secrets for production:

- FACTORY_API_TOKEN: bearer token required for manual API and config-status routes.
- FACTORY_RUNNER_URL and FACTORY_RUNNER_TOKEN: set on the Cloudflare Worker when jobs should execute on the Node runner instead of inside the Worker.
- OPENAI_CODEX_ACCESS_TOKEN or OPENAI_CODEX_REFRESH_TOKEN: ChatGPT/Codex subscription credential for openai-codex models. OPENAI_API_KEY is only for direct openai/* models.
- DAYTONA_API_KEY: Daytona workspace provider key.
- GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: GitHub App credentials for repository access and PR creation.
- GITHUB_WEBHOOK_SECRET: GitHub webhook secret for verified inbound signal delivery.
- SENTRY_WEBHOOK_SECRET and SENTRY_DEFAULT_REPO: Sentry webhook signature secret and target repo for Sentry-triggered factory work.

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

GET /api/config/status returns non-secret configuration readiness for the operator UI or deployment smoke tests. It also requires Authorization: Bearer <FACTORY_API_TOKEN>.

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

The runner script resizes the Daytona sandbox to 2 vCPU and 4 GiB RAM by default before installing dependencies. Override this with FACTORY_RUNNER_CPU and FACTORY_RUNNER_MEMORY_GIB in the local deploy environment if your Daytona quota requires different limits.

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

Configure Sentry to send issue alert or critical metric alert webhooks with the same SENTRY_WEBHOOK_SECRET. Sentry payloads are signed with the sentry-hook-signature HMAC header. The factory routes accepted Sentry signals to SENTRY_DEFAULT_REPO and SENTRY_DEFAULT_BASE_BRANCH, and admits only levels in SENTRY_ACCEPT_LEVELS.
