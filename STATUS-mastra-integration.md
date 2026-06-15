# Status: Mastra Runtime Integration Branch

**Branch:** `codex/mastra-runtime-poc`  
**Location:** `/Users/danielpetro/Documents/background-agents`

## Summary

You've already built the core Mastra runner integration package. The work is significantly further
along than a blank fork — you have a working `mastra-runner` that wraps `mastracode` and emits
events compatible with Open-Inspect's bridge. What remains is **wiring it into the session
lifecycle** so Open-Inspect actually invokes it instead of OpenCode.

## What exists now

### 1. `packages/mastra-runner/` — new package

A complete, standalone Mastra Code runner for Open-Inspect.

**Key files:**

| File               | Purpose                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `src/runner.ts`    | `runMastraCodeTask()` / `runMastraCodexTask()` — wraps `createMastraCode()`, configures harness, streams events    |
| `src/workspace.ts` | `createMastraWorkspace()` — returns Mastra `Workspace` with `LocalFilesystem` + `LocalSandbox` or `DaytonaSandbox` |
| `src/config.ts`    | Environment-based configuration parser                                                                             |
| `src/cli.ts`       | CLI entrypoint: reads task and emits newline-delimited JSON events                                                 |
| `src/types.ts`     | Runner event types (`runner.started`, `mastra.text_delta`, `mastra.harness_event`, `runner.completed`, etc.)       |
| `src/events.ts`    | Event normalization helpers                                                                                        |

**Capabilities:**

- Runs `mastracode` harness inside an existing Open-Inspect sandbox (`sandboxMode: existing`)
- Can also run against Daytona (`sandboxMode: daytona`)
- Uses Mastra Workspace tools with Open-Inspect-friendly names:
  - `view`, `write_file`, `string_replace_lsp`, `find_files`, `search_content`, `execute_command`,
    `lsp_inspect`, etc.
- Supports Codex via Mastra model resolver (`MASTRA_CODE_MODEL=openai/gpt-5.5`)
- Configurable permissions (`read: allow`, `edit: ask`, `execute: ask`, `mcp: deny`)
- YOLO mode for non-interactive runs
- Observational Memory via LibSQL storage
- Tests included (`runner.test.ts`, `config.test.ts`, `events.test.ts`)

**Example usage:**

```bash
MASTRA_RUNNER_SANDBOX_MODE=existing \
MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX=1 \
MASTRA_RUNNER_WORKSPACE_PATH=/workspace/my-repo \
MASTRA_CODE_MODEL=openai/gpt-5.5 \
MASTRA_OM_SCOPE=thread \
npm exec -w @open-inspect/mastra-runner open-inspect-mastra-runner -- \
  --task "Inspect the repository and summarize the test setup"
```

### 2. `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` — modified

Changes on this branch:

- Refactored OpenCode auth writing into `_write_opencode_auth()` helper
- Added `_setup_opencode_go_auth()` for OpenCode Go API key auth
- Changed default provider/model from `anthropic/claude-sonnet-4-6` to `openai/gpt-5.5`
- Added `docs/OPENCODE_GO.md`

**Important:** These changes are still for OpenCode, not the Mastra runner. The supervisor still
starts OpenCode by default.

### 3. `packages/shared/src/models.ts` — modified

Likely updated to include GPT 5.x / Codex / OpenCode Go model defaults.

### 4. `.agents/skills/mastra/` — added

Comprehensive Mastra skill documentation and references for agent-assisted development.

## What is NOT yet done

| Missing piece                                  | Why it matters                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| **Runner is not invoked by the supervisor**    | `entrypoint.py` still calls OpenCode, not `mastra-runner`.                        |
| **No feature flag to switch runtimes**         | Can't A/B test OpenCode vs. Mastra runner per session.                            |
| **Bridge doesn't consume runner events**       | `mastra-runner` emits NDJSON, but the Python bridge expects OpenCode SSE events.  |
| **No integration tests**                       | No end-to-end test of Open-Inspect session → Mastra runner → events → web UI.     |
| **No packaging into sandbox image**            | The runner needs to be installed inside the sandbox image (Modal/Daytona/Vercel). |
| **No session config field for runtime choice** | `SESSION_CONFIG` doesn't include `runner: "mastra-code"` or similar.              |

## How to verify the runner works standalone

From the repo root:

```bash
cd packages/mastra-runner
npm run build
MASTRA_RUNNER_SANDBOX_MODE=existing \
MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX=1 \
MASTRA_RUNNER_WORKSPACE_PATH=/path/to/a/repo \
MASTRA_CODE_MODEL=openai/gpt-5.5 \
node dist/cli.js --task "Read README.md and summarize the project"
```

You should see NDJSON events streaming to stdout.

## Recommended next steps to complete integration

### Step 1: Add a runtime selection field to session config

In `packages/control-plane/src/session/create-session-input.ts` and related schema, add something
like:

```ts
agentRuntime: "opencode" | "mastra-code"; // default "opencode"
```

### Step 2: Pass the runtime choice into `SESSION_CONFIG`

Update `packages/control-plane/src/session/initialize.ts` and
`packages/control-plane/src/sandbox/sandbox-env.ts` to include `agentRuntime` in the env vars sent
to the sandbox.

### Step 3: Modify `entrypoint.py` to branch on runtime

In `start_opencode()` or a new `start_agent_runtime()` method:

```python
agent_runtime = os.environ.get("AGENT_RUNTIME", "opencode")
if agent_runtime == "mastra-code":
    await self.start_mastra_runner()
else:
    await self.start_opencode()
```

### Step 4: Implement `start_mastra_runner()`

Spawn the `mastra-runner` CLI as a subprocess, similar to how OpenCode is spawned:

```python
proc = await asyncio.create_subprocess_exec(
    "npx", "-y", "@open-inspect/mastra-runner", "--task", initial_prompt,
    env={**os.environ, "MASTRA_RUNNER_WORKSPACE_PATH": str(self.repo_path)},
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
)
```

Or better: start the runner as a persistent server process and send prompts over stdin/HTTP.

### Step 5: Adapt the bridge to consume NDJSON

`packages/sandbox-runtime/src/sandbox_runtime/bridge.py` currently reads OpenCode SSE. Add a parser
for `mastra-runner` NDJSON events and convert them to the same internal event format used by
Open-Inspect.

Key mappings:

| Mastra runner event    | Open-Inspect event                                |
| ---------------------- | ------------------------------------------------- |
| `runner.started`       | `sandbox_ready` or custom `mastra_runner_started` |
| `mastra.text_delta`    | assistant token stream                            |
| `mastra.harness_event` | tool call / status event                          |
| `runner.completed`     | `execution_complete`                              |
| `runner.failed`        | `error`                                           |

### Step 6: Install runner in sandbox images

Update Dockerfiles / Modal image definitions / Daytona snapshot scripts to:

```bash
npm install -g @open-inspect/mastra-runner
# or
npm install @open-inspect/mastra-runner
```

### Step 7: Feature flag and test

- Add an env var or per-repo setting to enable Mastra runtime.
- Run one session with OpenCode, one with Mastra runner, compare event streams in the web UI.
- Add integration test: create session → prompt → expect `runner.started` → expect
  `runner.completed`.

## Suggested immediate action

The highest-leverage next step is **Step 3 + Step 5**: make `entrypoint.py` spawn `mastra-runner`
for a feature-flagged session, and adapt the bridge to parse its NDJSON output. Once that loop works
end-to-end, the rest is polish and packaging.

## Files to touch next

| File                                                                    | Change                       |
| ----------------------------------------------------------------------- | ---------------------------- |
| `packages/control-plane/src/session/create-session-input.ts`            | Add `agentRuntime` field     |
| `packages/control-plane/src/session/schema.ts`                          | Store runtime preference     |
| `packages/control-plane/src/sandbox/sandbox-env.ts`                     | Pass `AGENT_RUNTIME` env var |
| `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`            | Branch + spawn runner        |
| `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`                | Parse NDJSON from runner     |
| `packages/daytona-infra/src/toolchain.py` or Modal/Vercel image scripts | Install runner               |
| `packages/web/src/components/session-timeline.tsx`                      | Ensure events render         |

## Bottom line

You're not starting from scratch — you're about **60% done with the integration**. The runner
package is solid. The remaining work is plumbing: session config → sandbox env → supervisor spawn →
bridge parse → UI render.
