# PRD: Integrate Mastra Runner into Open-Inspect Session Lifecycle

## Problem Statement

Open-Inspect currently runs OpenCode as its only in-sandbox coding agent runtime. We have built an
experimental `@open-inspect/mastra-runner` package that wraps `mastracode` and emits events
compatible with Open-Inspect, but it is not yet invoked by the sandbox supervisor or consumed by the
bridge. As a result, users cannot select Mastra Code / Codex as an agent runtime for a session, and
all the work invested in the runner package is unreachable from the product surface.

## Solution

Wire the existing `mastra-runner` package into the Open-Inspect session lifecycle so that a session
can optionally run under the Mastra Code runtime instead of OpenCode. The control plane selects the
runtime, the sandbox supervisor spawns the chosen runtime, and the bridge normalizes runner events
into the shared `SandboxEvent` contract so that existing clients (web, Slack, GitHub, Linear) see a
uniform event stream.

The integration must be feature-flagged and safe: OpenCode remains the default, and Mastra runner is
opt-in per session or per deployment until it reaches parity.

## User Stories

1. As a developer, I want to create a coding session that uses Mastra Code as the agent runtime, so
   that I can leverage Codex via my ChatGPT subscription inside Open-Inspect.
2. As a developer, I want Open-Inspect to spawn Mastra Code inside an existing Open-Inspect sandbox,
   so that Open-Inspect still owns isolation, git auth, WebSockets, and cleanup.
3. As a developer, I want Mastra Code events (text deltas, tool calls, completions, errors) to
   appear in the Open-Inspect web UI in real time, so that I can watch the agent work.
4. As a developer, I want to send follow-up prompts to a Mastra Code session, so that I can iterate
   on a task without starting over.
5. As a developer, I want Mastra Code's Observational Memory to persist across prompts in a session,
   so that context is retained.
6. As an operator, I want Mastra runner to be opt-in via a feature flag, so that Open-Inspect
   remains stable while the integration matures.
7. As an operator, I want the runner to require an explicit allow flag for local sandbox mode, so
   that developers do not accidentally execute shell commands on their workstations.
8. As a developer, I want to choose the model (e.g., `openai/gpt-5.5`) for a Mastra Code session, so
   that I can use the best model for the task.
9. As an operator, I want the same SCM credential brokering and PR creation flow for Mastra Code
   sessions, so that security and attribution do not regress.
10. As a developer, I want child-session spawning (`spawn-task`) to work with Mastra Code sessions,
    so that I can parallelize work.
11. As a developer, I want session status events (`sandbox_spawning`, `sandbox_ready`,
    `execution_complete`, `error`) to be identical regardless of runtime, so that clients do not
    need runtime-specific handling.
12. As a tester, I want an integration test that creates a Mastra Code session and asserts the event
    stream ends with `runner.completed`, so that regressions are caught in CI.
13. As an operator, I want Mastra runner pre-installed in sandbox images, so that cold-start time is
    not dominated by npm install.
14. As a developer, I want `.openinspect/setup.sh` and `.openinspect/start.sh` to run before Mastra
    Code starts, so that repo-specific provisioning works unchanged.
15. As a security reviewer, I want the runner's local sandbox mode to be disabled by default, so
    that it only runs inside an isolated Open-Inspect sandbox.
16. As an operator, I want the runtime choice persisted in the session record, so that analytics and
    debugging can distinguish OpenCode and Mastra sessions.
17. As a developer, I want Mastra Code tool names (`view`, `write_file`, `execute_command`) to be
    normalized before reaching clients, so that the UI renders familiar events.
18. As a developer, I want errors from Mastra Code (auth failures, tool denials, harness crashes) to
    surface as Open-Inspect `error` events, so that I know when a session failed.
19. As an operator, I want the control plane to reject Mastra runtime requests when the deployment
    has not enabled it, so that unsupported paths fail fast.
20. As a developer, I want the same tunnel URL, code-server, and ttyd behavior in Mastra Code
    sessions, so that auxiliary session features work unchanged.

## Implementation Decisions

### 1. Runtime selection is a first-class session property

Add `agentRuntime` to the shared session creation contract and D1 session index. Valid values are
`"opencode"` (default) and `"mastra-code"`. This follows ADR 0002 by keeping `ClientMessage`,
`ServerMessage`, and session state contracts in `@open-inspect/shared` as the source of truth.

The control plane rejects `"mastra-code"` if the deployment has not enabled it via an environment
flag, failing fast rather than falling through to OpenCode silently.

### 2. The supervisor branches on `AGENT_RUNTIME`

The sandbox supervisor receives `AGENT_RUNTIME` as an environment variable in `SESSION_CONFIG`. It
continues to own:

- Sandbox lifecycle
- Git sync and credential helper
- `.openinspect/setup.sh` / `start.sh` execution
- Tunnel URLs, code-server, ttyd
- Process monitoring and cleanup

It branches at agent-runtime startup:

- `opencode` → existing `start_opencode()` path
- `mastra-code` → new `start_mastra_runner()` path

### 3. `MastraRunnerAdapter` deep module

Encapsulate runner process management in a single module with a minimal interface:

```ts
interface RunnerAdapter {
  start(initialPrompt: string): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (event: MastraRunnerEvent) => void): () => void;
}
```

This hides whether the runner is spawned once per prompt, kept alive as a persistent process, or
communicates over stdio/HTTP. The first implementation uses persistent stdio NDJSON because it
matches the existing runner CLI and keeps process management simple.

### 4. `RunnerEventNormalizer` deep module

Convert `mastra-runner` NDJSON events into the canonical `SandboxEvent` union defined in
`@open-inspect/shared`. Mapping:

| Runner event           | Shared `SandboxEvent`                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| `runner.started`       | `sandbox_ready` (or a new `mastra_runner_started` variant if clients need it) |
| `mastra.text_delta`    | assistant token stream event                                                  |
| `mastra.harness_event` | tool call / status event (payload normalized)                                 |
| `runner.completed`     | `execution_complete`                                                          |
| `runner.failed`        | `error`                                                                       |
| `runner.warning`       | `sandbox_warning`                                                             |

The normalizer is a pure function and can be unit tested with captured runner output.

### 5. Bridge consumes the adapter, not OpenCode SSE

The bridge currently consumes OpenCode SSE. It will be extended to:

1. Detect runtime from env.
2. Instantiate the appropriate adapter (`OpenCodeSSEAdapter` or `MastraRunnerAdapter`).
3. Forward normalized events to the control plane.

The adapter abstraction keeps bridge logic runtime-agnostic except for factory selection.

### 6. Mastra runner is installed in sandbox images

The runner package is built and installed in sandbox base images (Modal, Daytona, Vercel) so that
startup does not require npm install. The image build scripts install `@open-inspect/mastra-runner`
from the monorepo or a private registry.

### 7. Local sandbox mode remains guard-railed

`mastra-runner` requires `MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX=1` for `sandboxMode=existing`. The
Open-Inspect supervisor only sets this inside an actual Open-Inspect sandbox. Local development
invoking the runner directly must also set it explicitly, preserving the existing safety model.

### 8. Storage and Observational Memory are runner-managed

Mastra Code handles its own LibSQL storage for threads and Observational Memory. The supervisor sets
`MASTRA_DB_URL` to a path inside the workspace (e.g., `file:/workspace/.mastracode/open-inspect.db`)
so that OM persists with the session. This keeps Open-Inspect's Durable Object SQLite focused on
session orchestration while Mastra manages agent memory.

### 9. SCM auth and PR creation reuse existing paths

The runner executes git operations inside the sandbox using the existing git credential helper,
which brokers short-lived SCM credentials from the control plane. PR creation continues to use the
user's OAuth token via the control plane. No new auth paths are introduced.

### 10. Correlation naming follows ADR 0002

All transport boundaries use canonical keys: `trace_id`, `request_id`, `session_id`, `sandbox_id`.
Runner logs include these keys so that traces can correlate Open-Inspect control-plane events with
runner events.

## Testing Decisions

A good test exercises external behavior, not implementation details. For this feature, that means:

- Given a session configured with `agentRuntime: "mastra-code"`, the system produces the expected
  sequence of shared `SandboxEvent`s.
- Given a runner NDJSON payload, `RunnerEventNormalizer` emits the correct shared events.
- Given a Mastra Code session, the web UI can render the event stream without runtime-specific
  changes.

### Modules to test

1. **`RunnerEventNormalizer`** — unit tests with fixture NDJSON streams. Prior art: existing event
   parsing tests in `sandbox-runtime/tests/test_bridge_*.py`.
2. **`MastraRunnerAdapter`** — unit tests that mock the runner subprocess and verify prompt
   sending + event emission. Prior art: subprocess mocking patterns in `sandbox-runtime/tests/`.
3. **Control-plane runtime validation** — verify that `agentRuntime: "mastra-code"` is rejected when
   disabled and accepted when enabled. Prior art: `packages/control-plane/src/router.*.test.ts`.
4. **Integration test: Mastra Code session** — create a session via the control-plane API, assert
   that the runner starts and the event stream ends with `execution_complete`. Prior art:
   `packages/control-plane/test/integration/session-lifecycle.test.ts`.

### Modules NOT heavily tested at unit level

- The supervisor spawn branch is thin wiring; it is covered by the integration test instead of
  mocked unit tests.
- The web UI should need no runtime-specific tests if event normalization is correct.

## Out of Scope

- Replacing OpenCode as the default runtime.
- Supporting multiple agent runtimes in a single session simultaneously.
- Rewriting the control plane or web UI to be Mastra-specific.
- Adding new SCM providers beyond the deployment's configured single provider (per ADR 0001).
- Dayton standalone mode as the primary integration path; it remains an experimental escape hatch.
- Modifying Mastra Code itself; this PRD treats `mastracode` as a dependency.

## Further Notes

- The `mastra-runner` package already uses Mastra Workspace with tool name remapping (`view`,
  `write_file`, `execute_command`, etc.), so the normalized events should map cleanly to existing
  Open-Inspect tool-call rendering.
- The runner's CLI emits NDJSON specifically so that the Python bridge can consume it without a new
  transport protocol. This decision should be preserved.
- Once the integration is stable, we can consider making `mastra-code` the default for specific
  model selections (e.g., all Codex models) or repo settings.
- The branch name `codex/mastra-runtime-poc` reflects the experimental nature of this work. This PRD
  represents the path from POC to production wiring.
