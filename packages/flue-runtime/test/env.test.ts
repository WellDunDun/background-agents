import { describe, expect, it } from "vitest";
import { parseSessionConfig, resolveFlueCodeModel, resolveRepoPath } from "../src/env.js";

describe("flue runtime env", () => {
  it("parses the existing SESSION_CONFIG contract", () => {
    expect(
      parseSessionConfig({
        SESSION_CONFIG: JSON.stringify({
          session_id: "sess_1",
          repo_name: "factory",
        }),
      })
    ).toMatchObject({ session_id: "sess_1", repo_name: "factory" });
  });

  it("defaults to the subscription-backed Codex provider", () => {
    expect(resolveFlueCodeModel({ SESSION_CONFIG: JSON.stringify({ session_id: "sess_1" }) })).toBe(
      "openai-codex/gpt-5.5"
    );
  });

  it("normalizes bare model ids to the Codex provider", () => {
    expect(
      resolveFlueCodeModel({ SESSION_CONFIG: JSON.stringify({ session_id: "sess_1" }) }, "gpt-5.5")
    ).toBe("openai-codex/gpt-5.5");
  });

  it("uses the checked-out repository path", () => {
    expect(
      resolveRepoPath({
        SESSION_CONFIG: JSON.stringify({
          session_id: "sess_1",
          repo_name: "background-agents",
        }),
      })
    ).toBe("/workspace/background-agents");
  });
});
