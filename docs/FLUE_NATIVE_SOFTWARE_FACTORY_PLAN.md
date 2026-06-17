# Flue Native Software Factory Plan

## Position

Use Flue as the runtime foundation and background-agents as a reference implementation. Keep the product semantics that worked: GitHub App access, repository selection, automations, settings, review lifecycle, and webhook normalization. Do not keep the old duplicated control-plane/runtime architecture.

## Target architecture

1. Cloudflare Worker receives UI requests and external signals.
2. App-owned routes verify auth and normalize the signal.
3. Routes admit work with Flue dispatch to a continuing orchestrator agent.
4. The orchestrator delegates to implementation and review subagents.
5. Daytona provides provider-managed Linux workspaces for repository work.
6. GitHub App credentials provide repository checkout, branch, commit, PR, and review-comment operations.
7. Observability is emitted through Flue observe and exported to the selected backend.
8. The user explicitly approves merges.

## Background-agents pieces to keep

- Sentry signature verification and payload normalization.
- GitHub App authentication shape and installation scoping.
- Repository selector and integration settings UX patterns.
- Automation concepts: trigger key, concurrency key, pause/resume, run history, and manual trigger.
- Review bot lifecycle: iterate until ready, then wait for human review.
- Secure secret storage model, adapted to Cloudflare secrets and app-owned encrypted config.

## Pieces not to keep

- Modal data plane.
- Custom session Durable Object protocol.
- Custom WebSocket event stream as the primary runtime abstraction.
- Terraform as the default deploy path for the first Flue-native slice.
- Any fallback model/provider path that hides configuration errors.

## First production slice

1. Manual job API dispatches to the orchestrator.
2. Orchestrator uses implementation and review subagents.
3. Daytona sandbox adapter is added through the Flue Daytona blueprint and wired to implementation jobs.
4. GitHub App installation is used to checkout one selected repo and push a branch.
5. Review bot comments on the PR or records findings.
6. Cloudflare dry-run deploy passes.
7. One end-to-end production job creates a PR and stops before merge.

