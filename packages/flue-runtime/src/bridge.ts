import WebSocket from "ws";
import {
  parseSessionConfig,
  resolveFlueCodeModel,
  resolveFlueServerUrl,
  type OpenInspectFlueEnv,
} from "./env.js";

type BridgeCommand =
  | {
      type: "prompt";
      messageId?: string;
      message_id?: string;
      content?: string;
      model?: string;
      reasoningEffort?: string;
      author?: { scmName?: string | null; scmEmail?: string | null };
    }
  | { type: "stop" }
  | { type: "shutdown" }
  | { type: "ack"; ackId?: string }
  | {
      type: "push";
      pushSpec?: {
        remote?: string;
        branch?: string;
        refspec?: string;
      };
    };

type SandboxEvent = Record<string, unknown> & { type: string };

interface FlueSendResponse {
  streamUrl: string;
  offset: string;
  submissionId?: string;
}

interface FlueEvent {
  type: string;
  text?: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  error?: unknown;
  usage?: {
    cost?: {
      total?: number;
    };
  };
  operationKind?: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class FlueControlPlaneBridge {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly env: OpenInspectFlueEnv,
    private readonly flueServerUrl = resolveFlueServerUrl(env)
  ) {}

  async run(): Promise<void> {
    await waitForFlueServer(this.flueServerUrl);
    await new Promise<void>((resolve, reject) => {
      const session = parseSessionConfig(this.env);
      const ws = new WebSocket(this.wsUrl(session.session_id), {
        headers: {
          Authorization: "Bearer " + requireEnv(this.env.SANDBOX_AUTH_TOKEN, "SANDBOX_AUTH_TOKEN"),
          "X-Sandbox-ID": requireEnv(this.env.SANDBOX_ID, "SANDBOX_ID"),
        },
      });

      this.ws = ws;

      ws.on("open", () => {
        this.send({
          type: "ready",
          sandboxId: this.env.SANDBOX_ID,
          runtime: "flue",
        });
        this.heartbeat = setInterval(() => {
          this.send({
            type: "heartbeat",
            sandboxId: this.env.SANDBOX_ID,
            status: "ready",
          });
        }, HEARTBEAT_INTERVAL_MS);
      });

      ws.on("message", (raw) => {
        void this.handleCommand(JSON.parse(raw.toString()) as BridgeCommand).catch((error) => {
          this.send({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      ws.on("close", (code) => {
        this.stopHeartbeat();
        if (code === 1000 || code === 1001) {
          resolve();
        } else {
          reject(new Error("Control-plane WebSocket closed with code " + code));
        }
      });

      ws.on("error", (error) => {
        this.stopHeartbeat();
        reject(error);
      });
    });
  }

  private async handleCommand(command: BridgeCommand): Promise<void> {
    if (command.type === "prompt") {
      await this.handlePrompt(command);
      return;
    }

    if (command.type === "stop") {
      this.currentAbort?.abort("stop requested");
      return;
    }

    if (command.type === "shutdown") {
      this.currentAbort?.abort("shutdown requested");
      this.ws?.close(1000, "shutdown");
      return;
    }

    if (command.type === "push") {
      await this.handlePush(command);
    }
  }

  private async handlePrompt(command: Extract<BridgeCommand, { type: "prompt" }>): Promise<void> {
    const messageId = command.messageId ?? command.message_id ?? "unknown";
    const message = command.content?.trim();
    if (!message) {
      this.send({
        type: "execution_complete",
        messageId,
        success: false,
        error: "Prompt content is required.",
      });
      return;
    }

    this.currentAbort = new AbortController();
    const model = resolveFlueCodeModel(this.env, command.model);
    let hadError = false;
    let errorMessage: string | undefined;

    try {
      await configureGitIdentity(command.author);
      const response = await this.sendPrompt(message, messageId, this.currentAbort.signal);

      for await (const event of streamFlueEvents(
        this.toServerUrl(response.streamUrl),
        response.offset,
        this.currentAbort.signal
      )) {
        for (const mapped of mapFlueEvent(event, messageId)) {
          this.send(mapped);
        }

        if (event.isError) {
          hadError = true;
          errorMessage = stringifyError(event.error);
        }

        if (
          event.type === "operation" &&
          event.operationKind === "prompt" &&
          event.isError === true
        ) {
          hadError = true;
          errorMessage = stringifyError(event.error);
        }

        if (event.type === "idle") break;
      }

      this.send({
        type: "execution_complete",
        messageId,
        success: !hadError,
        ...(errorMessage ? { error: errorMessage } : {}),
        model,
      });
    } catch (error) {
      this.send({
        type: "execution_complete",
        messageId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.currentAbort = null;
    }
  }

  private async sendPrompt(
    message: string,
    messageId: string,
    signal: AbortSignal
  ): Promise<FlueSendResponse> {
    const session = parseSessionConfig(this.env);
    const response = await fetch(
      this.flueServerUrl + "/agents/code-factory/" + encodeURIComponent(session.session_id),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: [
            message,
            "",
            "Open-Inspect message id: " + messageId,
            "When you finish, leave the repository in a reviewable state. Do not merge.",
          ].join("\n"),
        }),
        signal,
      }
    );

    if (!response.ok) {
      throw new Error(
        "Flue prompt admission failed: " + response.status + " " + (await response.text())
      );
    }

    return (await response.json()) as FlueSendResponse;
  }

  private async handlePush(command: Extract<BridgeCommand, { type: "push" }>): Promise<void> {
    const branch = command.pushSpec?.branch ?? command.pushSpec?.refspec;
    try {
      const args = ["push"];
      if (command.pushSpec?.remote) args.push(command.pushSpec.remote);
      if (command.pushSpec?.refspec) args.push(command.pushSpec.refspec);
      else if (command.pushSpec?.branch) args.push("HEAD:" + command.pushSpec.branch);

      const result = await runProcess("git", args, { cwd: repoPathFromEnv(this.env) });
      if (result.exitCode !== 0) {
        this.send({
          type: "push_error",
          branchName: branch,
          error: result.stderr || result.stdout || "git push failed",
        });
        return;
      }

      this.send({
        type: "push_complete",
        branchName: branch,
        output: result.stdout,
      });
    } catch (error) {
      this.send({
        type: "push_error",
        branchName: branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private send(event: SandboxEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ ...event, sandboxId: this.env.SANDBOX_ID, timestamp: Date.now() / 1000 })
      );
    }
  }

  private wsUrl(sessionId: string): string {
    const controlPlaneUrl = requireEnv(this.env.CONTROL_PLANE_URL, "CONTROL_PLANE_URL");
    const base = controlPlaneUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "");
    return base + "/sessions/" + encodeURIComponent(sessionId) + "/ws?type=sandbox";
  }

  private toServerUrl(streamUrl: string): string {
    if (/^https?:\/\//.test(streamUrl)) return streamUrl;
    return this.flueServerUrl + (streamUrl.startsWith("/") ? streamUrl : "/" + streamUrl);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

export async function waitForFlueServer(serverUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(serverUrl + "/health");
      if (response.ok) return;
    } catch {
      // Retry until the Flue server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Flue server did not become healthy.");
}

async function* streamFlueEvents(
  streamUrl: string,
  offset: string,
  signal: AbortSignal
): AsyncGenerator<FlueEvent> {
  const url = new URL(streamUrl);
  url.searchParams.set("offset", offset);
  url.searchParams.set("live", "sse");

  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error("Flue stream failed: " + response.status + " " + (await response.text()));
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let frame = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      frame += value;

      let separator = frame.indexOf("\n\n");
      while (separator !== -1) {
        const chunk = frame.slice(0, separator);
        frame = frame.slice(separator + 2);

        for (const event of parseSseFrame(chunk)) {
          yield event;
        }

        separator = frame.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): FlueEvent[] {
  if (!frame.includes("event: data")) return [];
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return [];

  const parsed = JSON.parse(dataLines.join("\n")) as unknown;
  return Array.isArray(parsed) ? (parsed as FlueEvent[]) : [parsed as FlueEvent];
}

export function mapFlueEvent(event: FlueEvent, messageId: string): SandboxEvent[] {
  switch (event.type) {
    case "text_delta":
      return event.text ? [{ type: "token", content: event.text, messageId }] : [];
    case "thinking_delta":
      return event.delta ? [{ type: "token", content: event.delta, messageId }] : [];
    case "tool_start":
      return [
        {
          type: "tool_call",
          tool: event.toolName ?? "tool",
          callId: event.toolCallId ?? "",
          args: event.args ?? {},
          status: "running",
          messageId,
        },
      ];
    case "tool":
      return [
        {
          type: "tool_result",
          tool: event.toolName ?? "tool",
          callId: event.toolCallId ?? "",
          result: stringifyResult(event.result),
          error: event.isError ? stringifyError(event.error) : undefined,
          messageId,
        },
      ];
    case "operation":
      if (event.operationKind === "prompt") {
        return [
          {
            type: "step_finish",
            cost: event.usage?.cost?.total,
            messageId,
          },
        ];
      }
      return [];
    default:
      return [];
  }
}

async function configureGitIdentity(
  author: { scmName?: string | null; scmEmail?: string | null } | undefined
): Promise<void> {
  const name = author?.scmName?.trim() || "OpenInspect";
  const email = author?.scmEmail?.trim() || "open-inspect@noreply.github.com";
  const cwd = repoPathFromEnv(process.env);
  await runProcess("git", ["config", "user.name", name], { cwd });
  await runProcess("git", ["config", "user.email", email], { cwd });
}

function repoPathFromEnv(env: OpenInspectFlueEnv): string {
  return repoPathFromConfig(env.SESSION_CONFIG, env.REPO_NAME);
}

function repoPathFromConfig(
  rawConfig: string | undefined,
  fallbackRepoName: string | undefined
): string {
  const parsed = rawConfig ? (JSON.parse(rawConfig) as { repo_name?: string }) : {};
  const repoName = fallbackRepoName ?? parsed.repo_name;
  return repoName ? "/workspace/" + repoName : "/workspace";
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(name + " is required.");
  return value.trim();
}

function stringifyResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function stringifyError(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : JSON.stringify(value);
}

if (import.meta.url === "file://" + process.argv[1]) {
  const bridge = new FlueControlPlaneBridge(process.env);
  bridge.run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
