import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveOpenAICodexAccessToken,
  usesOpenAICodexProvider,
} from "../src/openai-codex-provider.js";

vi.mock("@flue/runtime", () => ({
  registerProvider: vi.fn(),
}));

describe("OpenAI Codex provider auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("detects Codex subscription model specifiers", () => {
    expect(usesOpenAICodexProvider("openai-codex/gpt-5.5")).toBe(true);
    expect(usesOpenAICodexProvider("openai/gpt-5.5")).toBe(false);
  });

  it("uses a current in-memory access token", async () => {
    await expect(
      resolveOpenAICodexAccessToken({
        OPENAI_OAUTH_ACCESS_TOKEN: "access-token",
        OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 300_000),
      })
    ).resolves.toBe("access-token");
  });

  it("refreshes through the control plane instead of reading local auth files", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          expires_in: 3600,
          account_id: "account-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      CONTROL_PLANE_URL: "https://control.example.com",
      SANDBOX_AUTH_TOKEN: "sandbox-token",
      SESSION_CONFIG: JSON.stringify({ session_id: "sess_1" }),
    };

    await expect(resolveOpenAICodexAccessToken(env)).resolves.toBe("fresh-access-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.example.com/sessions/sess_1/openai-token-refresh",
      {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-token" },
      }
    );
    expect(env).toMatchObject({
      OPENAI_OAUTH_ACCESS_TOKEN: "fresh-access-token",
      OPENAI_OAUTH_ACCOUNT_ID: "account-1",
    });
  });
});
