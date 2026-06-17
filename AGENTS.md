# AGENTS.md

Signal Factory is a Flue-native autonomous coding factory.

## Architecture

- Cloudflare Workers own HTTP ingress, auth, webhooks, and Flue routing.
- Flue continuing agents own long-running autonomous work and durable per-job state.
- Daytona owns provider-managed Linux workspaces for implementation jobs.
- GitHub App credentials own repository access, branch creation, commits, PRs, and review comments.
- External signals such as GitHub, Sentry, and Linear are normalized into factory job events before they are dispatched to Flue agents.

## Implementation rules

- Verify Flue APIs against the installed docs under node_modules/@flue/sdk/docs before changing runtime code.
- Do not bypass Flue admission. App-owned routes should use dispatch for continuing agents or call mounted workflow routes for finite workflows.
- Keep secrets in Cloudflare or hosting secret stores, never in committed files.
- Nothing merges automatically. Agents may create branches, commits, PRs, and review iterations, but the user must explicitly approve merging.
- Treat background-agents as a reference implementation, not the runtime base. Reuse domain logic where it is still right, especially trigger normalization, GitHub App security boundaries, settings UX patterns, and review lifecycle semantics.

## Useful docs

- Flue Cloudflare deploy: node_modules/@flue/sdk/docs/ecosystem/deploy/cloudflare.md
- Flue Cloudflare target: node_modules/@flue/sdk/docs/guide/targets/cloudflare.md
- Flue agents: node_modules/@flue/sdk/docs/guide/building-agents.md
- Flue durable execution: node_modules/@flue/sdk/docs/concepts/durable-execution.md
- Flue Daytona sandbox: node_modules/@flue/sdk/docs/ecosystem/sandboxes/daytona.md

