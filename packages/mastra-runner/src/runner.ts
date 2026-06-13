import { createMastraCode, type MastraCodeConfig } from "mastracode";
import type { MastraWorkspace } from "./workspace";
import { createMastraWorkspace } from "./workspace";
import { errorMessage, extractHarnessMessageText, nowIso, toJsonSafe } from "./events";
import { resolveMastraRunnerConfig } from "./config";
import type {
  MastraRunnerConfig,
  MastraRunnerEvent,
  MastraRunnerInput,
  MastraRunnerResult,
} from "./types";

type HarnessLike = {
  init: () => Promise<void> | void;
  destroy: () => Promise<void> | void;
  subscribe: (listener: (event: unknown) => void) => () => void;
  selectOrCreateThread: () => Promise<unknown>;
  createThread: (input: { title?: string }) => Promise<unknown>;
  switchThread: (input: { threadId: string }) => Promise<unknown>;
  switchMode: (input: { modeId: string }) => Promise<unknown>;
  switchModel: (input: { modelId: string; scope?: "thread" }) => Promise<unknown>;
  loadOMProgress?: () => Promise<void>;
  sendMessage: (input: { content: string }) => Promise<void>;
};

interface RunnerDependencies {
  createWorkspace?: (config: MastraRunnerConfig) => MastraWorkspace | Promise<MastraWorkspace>;
  createHarness?: (
    config: MastraRunnerConfig,
    workspace: MastraWorkspace
  ) => HarnessLike | Promise<HarnessLike>;
}

class EventQueue<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];

  push(item: T): void {
    this.items.push(item);
    this.flushWaiters();
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  async wait(): Promise<void> {
    if (this.items.length > 0) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  wake(): void {
    this.flushWaiters();
  }

  private flushWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function createStorageConfig(config: MastraRunnerConfig): MastraCodeConfig["storage"] {
  if (!config.storageUrl) return undefined;

  return {
    backend: "libsql",
    url: config.storageUrl,
    authToken: config.storageAuthToken,
    isRemote: !config.storageUrl.startsWith("file:") && config.storageUrl !== ":memory:",
  };
}

function createInitialState(config: MastraRunnerConfig): MastraCodeConfig["initialState"] {
  return {
    yolo: config.yolo,
    permissionRules: config.permissionRules,
    observerModelId: config.observerModelId,
    reflectorModelId: config.reflectorModelId,
    observationThreshold: config.observationThreshold,
    reflectionThreshold: config.reflectionThreshold,
    omScope: config.omScope,
  };
}

async function defaultCreateHarness(
  config: MastraRunnerConfig,
  workspace: MastraWorkspace
): Promise<HarnessLike> {
  const { harness } = await createMastraCode({
    cwd: config.workspacePath,
    workspace,
    storage: createStorageConfig(config),
    omScope: config.omScope,
    configDir: config.configDir,
    disableMcp: config.disableMcp,
    disableHooks: config.disableHooks,
    initialState: createInitialState(config),
  });

  return harness;
}

async function configureHarness(harness: HarnessLike, config: MastraRunnerConfig): Promise<void> {
  if (config.initHarness) {
    await harness.init();
  }

  if (config.threadId) {
    await harness.switchThread({ threadId: config.threadId });
  } else if (config.newThreadTitle) {
    await harness.createThread({ title: config.newThreadTitle });
  } else {
    await harness.selectOrCreateThread();
  }

  if (config.mode) {
    await harness.switchMode({ modeId: config.mode });
  }

  if (config.modelId) {
    await harness.switchModel({ modelId: config.modelId, scope: "thread" });
  }

  if (config.loadObservationalMemory && harness.loadOMProgress) {
    await harness.loadOMProgress();
  }
}

function createHarnessEventBridge(queue: EventQueue<MastraRunnerEvent>): {
  listener: (event: unknown) => void;
  getText: () => string;
} {
  const messageTextById = new Map<string, string>();

  return {
    listener: (event: unknown) => {
      const timestamp = nowIso();
      const message = extractHarnessMessageText(event);

      if (message) {
        const messageId = message.messageId ?? "__default_assistant_message__";
        const previous = messageTextById.get(messageId) ?? "";
        const delta = message.text.startsWith(previous)
          ? message.text.slice(previous.length)
          : message.text;

        messageTextById.set(messageId, message.text);

        if (delta.length > 0) {
          queue.push({
            type: "mastra.text_delta",
            text: delta,
            messageId: message.messageId,
            timestamp,
          });
        }
      } else {
        queue.push({
          type: "mastra.harness_event",
          event: toJsonSafe(event),
          timestamp,
        });
      }
    },
    getText: () => Array.from(messageTextById.values()).join("\n"),
  };
}

export async function* runMastraCodeTask(
  input: MastraRunnerInput,
  deps: RunnerDependencies = {}
): AsyncGenerator<MastraRunnerEvent, MastraRunnerResult, void> {
  const config = resolveMastraRunnerConfig(input.config);
  const queue = new EventQueue<MastraRunnerEvent>();
  const createWorkspace = deps.createWorkspace ?? createMastraWorkspace;
  const createHarness = deps.createHarness ?? defaultCreateHarness;
  let unsubscribe: (() => void) | undefined;
  let harness: HarnessLike | undefined;

  yield {
    type: "runner.started",
    runtime: "mastra-code",
    sandboxMode: config.sandboxMode,
    workspacePath: config.workspacePath,
    modelId: config.modelId,
    mode: config.mode,
    threadId: config.threadId,
    timestamp: nowIso(),
  };

  if (config.sandboxMode === "daytona") {
    yield {
      type: "runner.warning",
      code: "daytona-command-only-workspace",
      message:
        "Daytona mode currently configures Mastra command execution only; run this package inside an Open-Inspect sandbox for file read/write tools.",
      timestamp: nowIso(),
    };
  }

  try {
    const workspace = await createWorkspace(config);
    harness = await createHarness(config, workspace);
    const bridge = createHarnessEventBridge(queue);
    unsubscribe = harness.subscribe(bridge.listener);

    await configureHarness(harness, config);

    let finished = false;
    let sendError: unknown;
    const sendMessage = harness
      .sendMessage({ content: input.task })
      .catch((error: unknown) => {
        sendError = error;
      })
      .finally(() => {
        finished = true;
        queue.wake();
      });

    while (!finished || queue.hasItems()) {
      const event = queue.shift();
      if (event) {
        yield event;
        continue;
      }
      await queue.wait();
    }

    await sendMessage;

    if (sendError) throw sendError;

    const text = bridge.getText();
    yield {
      type: "runner.completed",
      text,
      timestamp: nowIso(),
    };

    return { text };
  } catch (error) {
    yield {
      type: "runner.failed",
      error: errorMessage(error),
      timestamp: nowIso(),
    };
    throw error;
  } finally {
    unsubscribe?.();
    if (config.destroyHarnessOnFinish && harness) {
      await harness.destroy();
    }
  }
}

export const runMastraCodexTask = runMastraCodeTask;
