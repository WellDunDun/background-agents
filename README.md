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

## API

POST /api/jobs admits a manual code factory job and dispatches it to the continuing orchestrator agent.

Expected JSON body:

{
  "prompt": "Implement the requested change.",
  "repo": "WellDunDun/example",
  "baseBranch": "main"
}

The route returns 202 Accepted with the factory job id and Flue dispatch receipt. Actual agent work continues asynchronously in the target Cloudflare Durable Object.
