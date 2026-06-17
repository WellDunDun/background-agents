import type { FactoryEnv } from "./env.js";

export interface FactoryGitHubTriggerConfig {
  triggerPhrase: string;
  botUsername?: string;
  updatedAt: string;
}

export interface FactoryGitHubTriggerPatch {
  triggerPhrase?: string;
  botUsername?: string | null;
}

const DEFAULT_GITHUB_TRIGGER_CONFIG_PATH = ".factory-github-trigger.json";
const DEFAULT_TRIGGER_PHRASE = "/factory";

export async function getFactoryGitHubTriggerConfig(env: FactoryEnv): Promise<FactoryGitHubTriggerConfig> {
  const fs = await importNodeFs();
  if (!fs) {
    return defaultGitHubTriggerConfig(env);
  }

  const filePath = getGitHubTriggerConfigPath(env);
  const text = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!text.trim()) {
    return defaultGitHubTriggerConfig(env);
  }

  try {
    return parseGitHubTriggerConfig(JSON.parse(text), env);
  } catch {
    return defaultGitHubTriggerConfig(env);
  }
}

export async function updateFactoryGitHubTriggerConfig(
  env: FactoryEnv,
  patch: FactoryGitHubTriggerPatch,
): Promise<FactoryGitHubTriggerConfig> {
  const fs = await importNodeFs();
  if (!fs) {
    throw new Error("GitHub trigger config is writable only in the Node runner runtime.");
  }

  const previous = await getFactoryGitHubTriggerConfig(env);
  const next: FactoryGitHubTriggerConfig = {
    triggerPhrase: patch.triggerPhrase ?? previous.triggerPhrase,
    ...(patch.botUsername === undefined
      ? previous.botUsername
        ? { botUsername: previous.botUsername }
        : {}
      : patch.botUsername
        ? { botUsername: patch.botUsername }
        : {}),
    updatedAt: new Date().toISOString(),
  };

  const filePath = getGitHubTriggerConfigPath(env);
  const { dirname } = await import("node:path");
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function normalizeGitHubTriggerPatch(
  value: unknown,
): { ok: true; value: FactoryGitHubTriggerPatch } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Expected a JSON object." };
  }

  const record = value as Record<string, unknown>;
  const patch: FactoryGitHubTriggerPatch = {};
  if ("triggerPhrase" in record) {
    const triggerPhrase = normalizeTriggerPhrase(record.triggerPhrase);
    if (!triggerPhrase.ok) {
      return triggerPhrase;
    }
    patch.triggerPhrase = triggerPhrase.value;
  }

  if ("botUsername" in record) {
    if (record.botUsername === null) {
      patch.botUsername = null;
    } else {
      const botUsername = normalizeBotUsername(record.botUsername);
      if (!botUsername.ok) {
        return botUsername;
      }
      patch.botUsername = botUsername.value ?? null;
    }
  }

  if (!("triggerPhrase" in patch) && !("botUsername" in patch)) {
    return { ok: false, error: "Provide triggerPhrase or botUsername." };
  }

  return { ok: true, value: patch };
}

function parseGitHubTriggerConfig(value: unknown, env: FactoryEnv): FactoryGitHubTriggerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultGitHubTriggerConfig(env);
  }

  const record = value as Record<string, unknown>;
  const triggerPhrase = normalizeTriggerPhrase(record.triggerPhrase);
  const botUsername = normalizeBotUsername(record.botUsername);
  const fallback = defaultGitHubTriggerConfig(env);
  return {
    triggerPhrase: triggerPhrase.ok ? triggerPhrase.value : fallback.triggerPhrase,
    ...(botUsername.ok && botUsername.value ? { botUsername: botUsername.value } : {}),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "1970-01-01T00:00:00.000Z",
  };
}

function defaultGitHubTriggerConfig(env: FactoryEnv): FactoryGitHubTriggerConfig {
  const triggerPhrase = normalizeTriggerPhrase(env.FACTORY_GITHUB_TRIGGER_PHRASE);
  const botUsername = normalizeBotUsername(env.GITHUB_BOT_USERNAME);
  return {
    triggerPhrase: triggerPhrase.ok ? triggerPhrase.value : DEFAULT_TRIGGER_PHRASE,
    ...(botUsername.ok && botUsername.value ? { botUsername: botUsername.value } : {}),
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function normalizeTriggerPhrase(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "triggerPhrase must be a string." };
  }
  const triggerPhrase = value.trim();
  if (!triggerPhrase) {
    return { ok: false, error: "triggerPhrase cannot be empty." };
  }
  if (triggerPhrase.length > 80 || /[\r\n\t\0]/.test(triggerPhrase)) {
    return { ok: false, error: "triggerPhrase is invalid." };
  }
  return { ok: true, value: triggerPhrase };
}

function normalizeBotUsername(
  value: unknown,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "botUsername must be a string or null." };
  }

  const botUsername = value.trim().replace(/^@+/, "");
  if (!botUsername) {
    return { ok: true };
  }
  if (botUsername.length > 80 || /[^A-Za-z0-9._\-\[\]]/.test(botUsername)) {
    return { ok: false, error: "botUsername is invalid." };
  }
  return { ok: true, value: botUsername };
}

function getGitHubTriggerConfigPath(env: FactoryEnv): string {
  return env.FACTORY_GITHUB_TRIGGER_CONFIG_PATH?.trim() || DEFAULT_GITHUB_TRIGGER_CONFIG_PATH;
}

async function importNodeFs(): Promise<typeof import("node:fs/promises") | null> {
  const processEnv = (globalThis as { process?: unknown }).process;
  if (!processEnv) {
    return null;
  }
  return import("node:fs/promises");
}

function isNodeError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
