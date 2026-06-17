import { registerProvider } from "@flue/runtime";
import type { OpenInspectFlueEnv } from "./env.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export async function ensureOpenAICodexProvider(
  env: OpenInspectFlueEnv,
  modelId: string
): Promise<void> {
  if (!usesOpenAICodexProvider(modelId)) return;

  const apiKey = await resolveOpenAICodexAccessToken(env);
  registerProvider(OPENAI_CODEX_PROVIDER_ID, { apiKey });
}

export function usesOpenAICodexProvider(modelId: string): boolean {
  return modelId.startsWith(OPENAI_CODEX_PROVIDER_ID + "/");
}

export async function resolveOpenAICodexAccessToken(env: OpenInspectFlueEnv): Promise<string> {
  const current = firstNonEmpty(env.OPENAI_OAUTH_ACCESS_TOKEN);
  const expiresAt = parseOAuthExpires(firstNonEmpty(env.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT));
  if (current && Date.now() + TOKEN_EXPIRY_SKEW_MS < expiresAt) {
    return current;
  }

  const refreshed = await refreshViaControlPlane(env);
  env.OPENAI_OAUTH_ACCESS_TOKEN = refreshed.accessToken;
  env.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT = String(refreshed.expiresAt);
  if (refreshed.accountId) {
    env.OPENAI_OAUTH_ACCOUNT_ID = refreshed.accountId;
  }
  return refreshed.accessToken;
}

interface RefreshedToken {
  accessToken: string;
  expiresAt: number;
  accountId?: string;
}

async function refreshViaControlPlane(env: OpenInspectFlueEnv): Promise<RefreshedToken> {
  const controlPlaneUrl = firstNonEmpty(env.CONTROL_PLANE_URL);
  const authToken = firstNonEmpty(env.SANDBOX_AUTH_TOKEN);
  const sessionId = readSessionId(env);

  if (!controlPlaneUrl || !authToken || !sessionId) {
    throw new Error(
      "CONTROL_PLANE_URL, SANDBOX_AUTH_TOKEN, and SESSION_CONFIG.session_id are required for Codex OAuth refresh."
    );
  }

  const response = await fetch(
    controlPlaneUrl.replace(/\/$/, "") + "/sessions/" + sessionId + "/openai-token-refresh",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + authToken,
      },
    }
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error("Codex token refresh failed (" + response.status + "): " + body);
  }

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    account_id?: string;
  };

  if (!body.access_token) {
    throw new Error("Codex token refresh did not return access_token.");
  }

  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    accountId: body.account_id,
  };
}

function readSessionId(env: OpenInspectFlueEnv): string | undefined {
  try {
    const parsed = JSON.parse(env.SESSION_CONFIG ?? "{}") as { session_id?: string };
    return firstNonEmpty(parsed.session_id);
  } catch {
    return undefined;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function parseOAuthExpires(value: string | undefined): number {
  if (!value) return 0;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsedDate = Date.parse(value);
  return Number.isFinite(parsedDate) ? parsedDate : 0;
}
