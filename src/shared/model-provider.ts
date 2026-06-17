import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import { streamOpenAICodexResponses } from "@earendil-works/pi-ai/openai-codex-responses";
import { registerApiProvider, registerProvider } from "@flue/runtime";

import { resolveFactoryModel, type FactoryEnv } from "./env.js";

const OPENAI_CODEX_SSE_API = "openai-codex-responses-sse";
let openAICodexSseApiRegistered = false;

export async function registerFactoryModelProvider(env: FactoryEnv): Promise<void> {
  const model = resolveFactoryModel(env);
  if (!model.startsWith("openai-codex/")) {
    return;
  }

  const apiKey = await resolveOpenAICodexAccessToken(env);
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
