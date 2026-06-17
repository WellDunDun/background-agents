import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import { registerProvider } from "@flue/runtime";

import { resolveFactoryModel, type FactoryEnv } from "./env.js";

export async function registerFactoryModelProvider(env: FactoryEnv): Promise<void> {
  const model = resolveFactoryModel(env);
  if (!model.startsWith("openai-codex/")) {
    return;
  }

  const apiKey = await resolveOpenAICodexAccessToken(env);
  if (!apiKey) {
    return;
  }

  registerProvider("openai-codex", { apiKey });
}

async function resolveOpenAICodexAccessToken(env: FactoryEnv): Promise<string | undefined> {
  const accessToken = env.OPENAI_CODEX_ACCESS_TOKEN?.trim();
  if (accessToken) {
    return accessToken;
  }

  const refreshToken = env.OPENAI_CODEX_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    return undefined;
  }

  const refreshed = await refreshOpenAICodexToken(refreshToken);
  return refreshed.access;
}
