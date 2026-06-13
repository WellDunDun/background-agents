# Open-Inspect Mastra Runner

Experimental Mastra Code backed runner for Codex coding sessions.

This package is intentionally isolated from the production control plane. The first integration
target is a feature-flagged runner that Open-Inspect can call after it has already created a sandbox
and minted scoped credentials.

The runtime is Mastra Code's createMastraCode factory, which returns a standard Mastra Harness.
Open-Inspect still owns GitHub auth, Daytona lifecycle, WebSockets, and cleanup. Mastra Code owns the
coding agent modes, tools, threads, and Observational Memory.

## Modes

### existing

Runs Mastra inside an already-isolated Open-Inspect sandbox, using LocalFilesystem and LocalSandbox
against the checked-out repo path. This is the preferred first production path because Open-Inspect
still owns Daytona lifecycle, GitHub App credentials, WebSockets, and cleanup.

This mode requires MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX=1 so it cannot accidentally run shell commands
on a developer workstation.

### daytona

Creates or reconnects to a Daytona sandbox through Mastra's DaytonaSandbox. This is useful for
standalone provider experiments. It is not yet the main code-edit path because Mastra's Daytona
workspace provider supplies command execution, while file read/write tooling still needs a matching
remote filesystem or mount strategy.

## Model Configuration

The runner does not hardcode the model in source. Configure the Mastra model id at runtime:

    export MASTRA_CODE_MODEL=openai/gpt-5.5

openai/gpt-5.5 is present in the installed Mastra provider registry. Mastra Code resolves OpenAI
models through its model resolver, including OpenAI Codex OAuth when configured.

## Observational Memory

Mastra Code stores threads, messages, state, and Observational Memory in its storage backend. By
default it uses its normal local LibSQL configuration. For Open-Inspect deployments, prefer an
explicit database URL:

    export MASTRA_DB_URL=file:/workspace/.mastracode/open-inspect.db
    export MASTRA_OM_SCOPE=thread

Use MASTRA_DB_AUTH_TOKEN with remote LibSQL. The runner also accepts DEFAULT_OM_MODEL_ID,
MASTRA_CODE_OBSERVER_MODEL, MASTRA_CODE_REFLECTOR_MODEL, MASTRA_CODE_OBSERVATION_THRESHOLD, and
MASTRA_CODE_REFLECTION_THRESHOLD.

Thread-scoped OM is the safer default for background coding sessions. Resource scope can share memory
across threads for a repo, but it is broader and should be enabled deliberately.

## Permissions

Default permissions are conservative: read is allow, edit is ask, execute is ask, and mcp is deny.

For a non-interactive sandbox run, set MASTRA_CODE_YOLO=1 only when the surrounding Open-Inspect
sandbox, GitHub credentials, and egress policy are already scoped tightly enough. You can override
rules with MASTRA_CODE_PERMISSION_RULES_JSON.

## Example

    MASTRA_RUNNER_SANDBOX_MODE=existing MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX=1 MASTRA_RUNNER_WORKSPACE_PATH=/workspace/my-repo MASTRA_CODE_MODEL=openai/gpt-5.5 MASTRA_OM_SCOPE=thread npm exec -w @open-inspect/mastra-runner open-inspect-mastra-runner -- --task "Inspect the repository and summarize the test setup"

The CLI emits newline-delimited JSON events so the current Open-Inspect bridge can adapt them into
the existing WebSocket session event stream.
