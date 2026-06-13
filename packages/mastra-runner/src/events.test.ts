import { describe, expect, it } from "vitest";
import { errorMessage, extractHarnessMessageText, extractTextDelta, toJsonSafe } from "./events";

describe("extractTextDelta", () => {
  it("extracts common Mastra text-delta chunk shapes", () => {
    expect(extractTextDelta({ type: "text-delta", text: "a" })).toBe("a");
    expect(extractTextDelta({ type: "text-delta", payload: { text: "b" } })).toBe("b");
    expect(extractTextDelta({ type: "text-delta", payload: { delta: "c" } })).toBe("c");
    expect(extractTextDelta({ type: "text-delta", delta: "d" })).toBe("d");
  });

  it("ignores non-text chunks", () => {
    expect(extractTextDelta({ type: "tool-call", payload: {} })).toBeNull();
    expect(extractTextDelta(null)).toBeNull();
  });
});

describe("errorMessage", () => {
  it("normalizes thrown values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
  });
});

describe("extractHarnessMessageText", () => {
  it("extracts assistant message text from Harness events", () => {
    expect(
      extractHarnessMessageText({
        type: "message_update",
        message: {
          id: "msg_1",
          role: "assistant",
          content: "hello",
        },
      })
    ).toEqual({ messageId: "msg_1", text: "hello" });
  });

  it("ignores user message updates", () => {
    expect(
      extractHarnessMessageText({
        type: "message_update",
        message: {
          role: "user",
          content: "hello",
        },
      })
    ).toBeNull();
  });
});

describe("toJsonSafe", () => {
  it("returns a serializable fallback for circular values", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(toJsonSafe(value)).toMatchObject({ type: "unserializable" });
  });
});
