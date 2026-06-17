# Open-Inspect Flue Runtime

This package is the Flue-backed coding runtime for Open-Inspect sandboxes.

It is designed to run inside the existing sandbox lifecycle:

1. The control plane creates a sandbox through the existing provider abstraction.
2. The sandbox supervisor clones and prepares the repository.
3. When `AGENT_RUNTIME=flue`, the supervisor starts the Flue Node server and this bridge.
4. The bridge connects to the existing session Durable Object WebSocket.
5. Prompt commands are admitted to the Flue `code-factory` agent.
6. Flue durable stream events are translated back into the existing Open-Inspect sandbox event
   contract.

Codex OAuth is refreshed through the existing control-plane endpoint:

`POST /sessions/:id/openai-token-refresh`

The sandbox does not need a local Pi auth file or a raw refresh token. Personal Codex auth remains
centralized in the control plane/D1 token store.

## Build

```bash
npm run build -w @open-inspect/flue-runtime
```

The sandbox image must include the built package and start with:

```bash
AGENT_RUNTIME=flue
```
