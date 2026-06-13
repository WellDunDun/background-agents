import { describe, expect, it } from "vitest";
import {
  configFromEnv,
  parseJsonRecord,
  parseJsonStringArray,
  resolveMastraRunnerConfig,
} from "./config";

describe("configFromEnv", () => {
  it("loads Mastra Code and sandbox settings from environment-style values", () => {
    expect(
      configFromEnv({
        MASTRA_RUNNER_SANDBOX_MODE: "existing",
        MASTRA_RUNNER_WORKSPACE_PATH: "/workspace/repo",
        MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX: "1",
        MASTRA_CODE_MODEL: "openai/gpt-5.5",
        MASTRA_CODE_MODE: "build",
        MASTRA_CODE_DISABLE_MCP: "1",
        MASTRA_DB_URL: "file:/tmp/mastra-code.db",
        MASTRA_OM_SCOPE: "thread",
        MASTRA_CODE_PERMISSION_RULES_JSON:
          '{"categories":{"execute":"ask"},"tools":{"execute_command":"ask"}}',
      })
    ).toMatchObject({
      sandboxMode: "existing",
      workspacePath: "/workspace/repo",
      allowLocalSandbox: true,
      modelId: "openai/gpt-5.5",
      mode: "build",
      disableMcp: true,
      storageUrl: "file:/tmp/mastra-code.db",
      omScope: "thread",
      permissionRules: {
        categories: {
          execute: "ask",
        },
        tools: {
          execute_command: "ask",
        },
      },
    });
  });

  it("rejects non-JSON string arrays", () => {
    expect(() => parseJsonStringArray("acp --stdio", "MASTRA_ACP_ARGS_JSON")).toThrow(
      /JSON string array/
    );
  });

  it("rejects non-object JSON records", () => {
    expect(() => parseJsonRecord("[]", "MASTRA_CODE_PERMISSION_RULES_JSON")).toThrow(
      /JSON object/
    );
  });
});

describe("resolveMastraRunnerConfig", () => {
  it("guards existing mode behind an explicit local sandbox allow flag", () => {
    expect(() =>
      resolveMastraRunnerConfig(
        {
          sandboxMode: "existing",
        },
        {}
      )
    ).toThrow(/MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX/);
  });

  it("allows standalone Daytona mode without the local sandbox guard", () => {
    expect(
      resolveMastraRunnerConfig(
        {
          sandboxMode: "daytona",
          modelId: "openai/gpt-5.5",
        },
        {}
      )
    ).toMatchObject({
      sandboxMode: "daytona",
      modelId: "openai/gpt-5.5",
    });
  });
});
