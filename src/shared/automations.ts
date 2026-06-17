import type { FactoryEnv } from "./env.js";

export type FactoryAutomationSource = "github" | "sentry";

export interface FactoryAutomationState {
  source: FactoryAutomationSource;
  enabled: boolean;
  reason?: string;
  updatedAt: string;
}

export interface FactoryAutomationList {
  automations: FactoryAutomationState[];
}

export interface FactoryAutomationPatch {
  enabled?: boolean;
  reason?: string;
}

const DEFAULT_AUTOMATION_STATE_PATH = ".factory-automations.json";
const AUTOMATION_SOURCES: FactoryAutomationSource[] = ["github", "sentry"];

export function parseFactoryAutomationSource(value: string): FactoryAutomationSource | null {
  return value === "github" || value === "sentry" ? value : null;
}

export async function listFactoryAutomations(env: FactoryEnv): Promise<FactoryAutomationList> {
  const state = await readAutomationStateFile(env);
  return {
    automations: AUTOMATION_SOURCES.map((source) => state[source] ?? defaultAutomationState(source)),
  };
}

export async function getFactoryAutomation(
  env: FactoryEnv,
  source: FactoryAutomationSource,
): Promise<FactoryAutomationState> {
  const state = await readAutomationStateFile(env);
  return state[source] ?? defaultAutomationState(source);
}

export async function updateFactoryAutomation(
  env: FactoryEnv,
  source: FactoryAutomationSource,
  patch: FactoryAutomationPatch,
): Promise<FactoryAutomationState> {
  const fs = await importNodeFs();
  if (!fs) {
    throw new Error("Automation state is writable only in the Node runner runtime.");
  }

  const current = await readAutomationStateFile(env);
  const previous = current[source] ?? defaultAutomationState(source);
  const nextReason = patch.reason === undefined ? previous.reason : normalizeReason(patch.reason);
  const next: FactoryAutomationState = {
    source,
    enabled: patch.enabled ?? previous.enabled,
    ...(nextReason ? { reason: nextReason } : {}),
    updatedAt: new Date().toISOString(),
  };
  const updated = { ...current, [source]: next };

  const filePath = getAutomationStatePath(env);
  const { dirname } = await import("node:path");
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export async function isFactoryAutomationEnabled(
  env: FactoryEnv,
  source: FactoryAutomationSource,
): Promise<boolean> {
  return (await getFactoryAutomation(env, source)).enabled;
}

async function readAutomationStateFile(
  env: FactoryEnv,
): Promise<Partial<Record<FactoryAutomationSource, FactoryAutomationState>>> {
  const fs = await importNodeFs();
  if (!fs) {
    return {};
  }

  const filePath = getAutomationStatePath(env);
  const text = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parseAutomationStateMap(parsed);
  } catch {
    return {};
  }
}

function parseAutomationStateMap(
  value: unknown,
): Partial<Record<FactoryAutomationSource, FactoryAutomationState>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const state: Partial<Record<FactoryAutomationSource, FactoryAutomationState>> = {};
  for (const source of AUTOMATION_SOURCES) {
    const item = (value as Record<string, unknown>)[source];
    if (isAutomationState(item, source)) {
      state[source] = item;
    }
  }
  return state;
}

function isAutomationState(value: unknown, source: FactoryAutomationSource): value is FactoryAutomationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<FactoryAutomationState>;
  return record.source === source && typeof record.enabled === "boolean" && typeof record.updatedAt === "string";
}

function defaultAutomationState(source: FactoryAutomationSource): FactoryAutomationState {
  return {
    source,
    enabled: true,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function normalizeReason(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function getAutomationStatePath(env: FactoryEnv): string {
  return env.FACTORY_AUTOMATION_STATE_PATH?.trim() || DEFAULT_AUTOMATION_STATE_PATH;
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
