# Flue Factory

Flue Factory is a Flue-native software factory for durable autonomous coding jobs.

This branch intentionally starts clean instead of retrofitting the old background-agents control plane. The product shape stays the same: a signal creates a job, an orchestrator admits work to a durable agent instance, implementation and review agents iterate, and a human explicitly approves any merge.

## First slice

- Cloudflare Worker entrypoint with a manual job API.
- Durable Flue agents for orchestration, implementation, and review.
- Daytona-backed workspaces for repo execution.
- GitHub App tools for repo access, checkout, branch push, PR creation, and PR comments.
- A finite kickoff workflow for Studio/CLI smoke tests.
- Project skills for implementation, review, and scaffolding work.
- Cloudflare migrations for Flue-generated Durable Objects.

## Commands

- npm install
- npm run typecheck
- npm run build
- npm run dev
- npm run deploy:dry-run
- npm run deploy

Cloudflare development uses .dev.vars; production secrets should be set through Wrangler secrets or the deployment platform, not committed files.

Flue builds the deployable Cloudflare Worker into dist/flue_factory. The deploy scripts run flue build first, then pass the generated Wrangler config in that output directory to Wrangler.

## Configuration

Set these as local .dev.vars values for development and as Cloudflare Worker secrets for production:

- FACTORY_API_TOKEN: bearer token required for manual API and config-status routes.
- OPENAI_API_KEY: provider key for the configured Codex/OpenAI model.
- DAYTONA_API_KEY: Daytona workspace provider key.
- GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: GitHub App credentials for repository access and PR creation.
- GITHUB_WEBHOOK_SECRET: GitHub webhook secret for verified inbound signal delivery.

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

The route returns 202 Accepted with the factory job id and Flue dispatch receipt. Actual agent work continues asynchronously in the target Cloudflare Durable Object.

GET /api/config/status returns non-secret configuration readiness for the operator UI or deployment smoke tests. It also requires Authorization: Bearer <FACTORY_API_TOKEN>.

## GitHub Webhook

The Flue GitHub channel is mounted at:

https://<worker-host>/channels/github/webhook

Configure the GitHub App webhook with application/json content and the same GITHUB_WEBHOOK_SECRET. Subscribe initially to Issues, Issue comments, and Pull request review comments.

The factory only admits GitHub signals that contain FACTORY_GITHUB_TRIGGER_PHRASE or mention GITHUB_BOT_USERNAME. This keeps ordinary issue traffic from starting autonomous work.
