import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import { streamOpenAICodexResponses } from "@earendil-works/pi-ai/openai-codex-responses";
import { registerApiProvider, registerProvider } from "@flue/runtime";

import { resolveFactoryEnv, resolveFactoryModel, type FactoryEnv } from "./env.js";

const OPENAI_CODEX_SSE_API = "openai-codex-responses-sse";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
let openAICodexSseApiRegistered = false;

export async function registerFactoryModelProvider(env: FactoryEnv): Promise<void> {
  const runtimeEnv = resolveFactoryEnv(env);
  const model = resolveFactoryModel(runtimeEnv);
  if (!model.startsWith("openai-codex/")) {
    return;
  }

  const apiKey = await resolveOpenAICodexAccessToken(runtimeEnv);
  if (!apiKey) {
    return;
  }

  registerOpenAICodexSseApi();
  registerProvider("openai-codex", {
    api: OPENAI_CODEX_SSE_API,
    apiKey,
  });
}

async function resolveOpenAICodexAccessToken(env: FactoryEnv): Promise<string | undefined> {
  const accessToken = env.OPENAI_CODEX_ACCESS_TOKEN?.trim();
  if (accessToken && isUsableJwtAccessToken(accessToken)) {
    return accessToken;
  }

  const refreshToken = env.OPENAI_CODEX_REFRESH_TOKEN?.trim();
  if (refreshToken) {
    const refreshed = await refreshOpenAICodexToken(refreshToken);
    await persistOpenAICodexCredentials(env, refreshed);
    return refreshed.access;
  }

  return accessToken || undefined;
}

function isUsableJwtAccessToken(token: string): boolean {
  const expiresAtMs = jwtExpiresAtMs(token);
  return expiresAtMs !== undefined && expiresAtMs - Date.now() > ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

function jwtExpiresAtMs(token: string): number | undefined {
  const [, encodedPayload] = token.split(".");
  if (!encodedPayload) {
    return undefined;
  }

  try {
    const json = decodeBase64Url(encodedPayload);
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

async function persistOpenAICodexCredentials(
  env: FactoryEnv,
  credentials: { access: string; refresh: string },
): Promise<void> {
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined>; cwd?: () => string } })
    .process?.env;
  if (processEnv) {
    processEnv.OPENAI_CODEX_ACCESS_TOKEN = credentials.access;
    processEnv.OPENAI_CODEX_REFRESH_TOKEN = credentials.refresh;
  }

  const credentialsPath = env.FACTORY_CODEX_CREDENTIALS_PATH?.trim();
  if (!credentialsPath) {
    return;
  }

  const [{ readFile, writeFile }, { resolve }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ".";
  const filePath = credentialsPath.startsWith("/") ? credentialsPath : resolve(cwd, credentialsPath);
  const existing = await readFile(filePath, "utf8").catch(() => "");
  const values = parseShellEnv(existing);
  values.OPENAI_CODEX_ACCESS_TOKEN = credentials.access;
  values.OPENAI_CODEX_REFRESH_TOKEN = credentials.refresh;
  await writeFile(filePath, serializeShellEnv(values), { mode: 0o600 });
}

function parseShellEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith("\"") && value.endsWith("\""))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value.replace(/'\\''/g, "'");
  }
  return values;
}

function serializeShellEnv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => key + "=" + quoteShell(value))
      .join("\n") + "\n"
  );
}

function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function registerOpenAICodexSseApi(): void {
  if (openAICodexSseApiRegistered) {
    return;
  }

  registerApiProvider(
    {
      api: OPENAI_CODEX_SSE_API,
      stream: (model, context, options) =>
        streamOpenAICodexResponses({ ...model, api: "openai-codex-responses" }, context, {
          ...options,
          transport: "sse",
        }),
      streamSimple: (model, context, options) =>
        streamOpenAICodexResponses({ ...model, api: "openai-codex-responses" }, context, {
          ...options,
          transport: "sse",
        }),
    },
    "flue-factory-openai-codex-sse",
  );
  openAICodexSseApiRegistered = true;
}
