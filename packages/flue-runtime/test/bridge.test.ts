import { describe, expect, it } from "vitest";
import { mapFlueEvent } from "../src/bridge.js";

describe("Flue bridge event mapping", () => {
  it("maps text deltas to token events", () => {
    expect(mapFlueEvent({ type: "text_delta", text: "hello" }, "msg_1")).toEqual([
      { type: "token", content: "hello", messageId: "msg_1" },
    ]);
  });

  it("maps tool lifecycle events to the existing sandbox contract", () => {
    expect(
      mapFlueEvent(
        {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "call_1",
          args: { command: "npm test" },
        },
        "msg_1"
      )
    ).toEqual([
      {
        type: "tool_call",
        tool: "bash",
        callId: "call_1",
        args: { command: "npm test" },
        status: "running",
        messageId: "msg_1",
      },
    ]);

    expect(
      mapFlueEvent(
        {
          type: "tool",
          toolName: "bash",
          toolCallId: "call_1",
          result: "ok",
          isError: false,
        },
        "msg_1"
      )
    ).toEqual([
      {
        type: "tool_result",
        tool: "bash",
        callId: "call_1",
        result: "ok",
        error: undefined,
        messageId: "msg_1",
      },
    ]);
  });

  it("maps prompt operation completion to step_finish with usage cost", () => {
    expect(
      mapFlueEvent(
        {
          type: "operation",
          operationKind: "prompt",
          isError: false,
          usage: { cost: { total: 0 } },
        },
        "msg_1"
      )
    ).toEqual([{ type: "step_finish", cost: 0, messageId: "msg_1" }]);
  });
});
