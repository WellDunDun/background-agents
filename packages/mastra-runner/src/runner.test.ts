import { describe, expect, it } from "vitest";
import { runMastraCodeTask } from "./runner";
import type { MastraRunnerEvent } from "./types";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function createFakeHarness(calls: string[]) {
  let listener: ((event: unknown) => void) | undefined;

  return {
    init: async () => {
      calls.push("init");
    },
    destroy: async () => {
      calls.push("destroy");
    },
    subscribe: (next: (event: unknown) => void) => {
      calls.push("subscribe");
      listener = next;
      return () => {
        calls.push("unsubscribe");
      };
    },
    selectOrCreateThread: async () => {
      calls.push("selectOrCreateThread");
    },
    createThread: async ({ title }: { title?: string }) => {
      calls.push("createThread:" + title);
    },
    switchThread: async ({ threadId }: { threadId: string }) => {
      calls.push("switchThread:" + threadId);
    },
    switchMode: async ({ modeId }: { modeId: string }) => {
      calls.push("switchMode:" + modeId);
    },
    switchModel: async ({ modelId }: { modelId: string }) => {
      calls.push("switchModel:" + modelId);
    },
    loadOMProgress: async () => {
      calls.push("loadOMProgress");
    },
    sendMessage: async ({ content }: { content: string }) => {
      calls.push("sendMessage:" + content);
      listener?.({
        type: "message_update",
        message: {
          id: "assistant_1",
          role: "assistant",
          content: "hello",
        },
      });
      listener?.({
        type: "message_update",
        message: {
          id: "assistant_1",
          role: "assistant",
          content: "hello world",
        },
      });
      listener?.({
        type: "tool_start",
        toolName: "view",
      });
    },
  };
}

describe("runMastraCodeTask", () => {
  it("streams Harness text deltas and destroys the harness", async () => {
    const calls: string[] = [];
    const events = await collect(
      runMastraCodeTask(
        {
          task: "summarize",
          config: {
            sandboxMode: "existing",
            workspacePath: "/workspace/repo",
            allowLocalSandbox: true,
            modelId: "openai/gpt-5.5",
            mode: "build",
          },
        },
        {
          createWorkspace: () => ({}) as never,
          createHarness: () => createFakeHarness(calls),
        }
      )
    );

    expect(events.map((event) => event.type)).toEqual([
      "runner.started",
      "mastra.text_delta",
      "mastra.text_delta",
      "mastra.harness_event",
      "runner.completed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "runner.completed", text: "hello world" });
    expect(calls).toEqual([
      "subscribe",
      "init",
      "selectOrCreateThread",
      "switchMode:build",
      "switchModel:openai/gpt-5.5",
      "loadOMProgress",
      "sendMessage:summarize",
      "unsubscribe",
      "destroy",
    ]);
  });

  it("emits a Daytona warning for standalone provider mode", async () => {
    const calls: string[] = [];
    const events = await collect(
      runMastraCodeTask(
        {
          task: "summarize",
          config: {
            sandboxMode: "daytona",
            workspacePath: "/workspace/repo",
            initHarness: false,
            loadObservationalMemory: false,
          },
        },
        {
          createWorkspace: () => ({}) as never,
          createHarness: () => createFakeHarness(calls),
        }
      )
    );

    expect(events.map((event) => event.type)).toContain("runner.warning");
    expect(calls).not.toContain("init");
    expect(calls).not.toContain("loadOMProgress");
  });

  it("preserves the legacy exported runner alias shape", async () => {
    const events: MastraRunnerEvent[] = await collect(
      runMastraCodeTask(
        {
          task: "summarize",
          config: {
            sandboxMode: "daytona",
            workspacePath: "/workspace/repo",
            initHarness: false,
            loadObservationalMemory: false,
          },
        },
        {
          createWorkspace: () => ({}) as never,
          createHarness: () => createFakeHarness([]),
        }
      )
    );

    expect(events[0]).toMatchObject({ type: "runner.started", runtime: "mastra-code" });
  });
});
