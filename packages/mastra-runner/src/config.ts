import type {
  MastraCodeMode,
  MastraOmScope,
  MastraPermissionPolicy,
  MastraPermissionRules,
  MastraRunnerConfig,
  MastraSandboxMode,
} from "./types";

const DEFAULT_WORKSPACE_PATH = "/workspace";
const DEFAULT_DAYTONA_TIMEOUT_MS = 300_000;
const DEFAULT_CONFIG_DIR = ".mastracode";
const DEFAULT_PERMISSION_RULES: MastraPermissionRules = {
  categories: {
    read: "allow",
    edit: "ask",
    execute: "ask",
    mcp: "deny",
  },
  tools: {},
};

export interface EnvLike {
  [key: string]: string | undefined;
}

export function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function parseJsonStringArray(value: string | undefined, envName: string): string[] {
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(envName + " must be a JSON string array: " + String(error));
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(envName + " must be a JSON string array");
  }

  return parsed;
}

export function parseJsonRecord(value: string | undefined, envName: string): Record<string, unknown> {
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(envName + " must be a JSON object: " + String(error));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(envName + " must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function parseSandboxMode(value: string | undefined): MastraSandboxMode {
  if (!value) return "existing";
  if (value === "existing" || value === "daytona") return value;
  throw new Error("Unsupported MASTRA_RUNNER_SANDBOX_MODE " + JSON.stringify(value));
}

function parseMode(value: string | undefined): MastraCodeMode | undefined {
  if (!value) return undefined;
  if (value === "build" || value === "plan" || value === "fast") return value;
  throw new Error("Unsupported MASTRA_CODE_MODE " + JSON.stringify(value));
}

function parseOmScope(value: string | undefined): MastraOmScope | undefined {
  if (!value) return undefined;
  if (value === "thread" || value === "resource") return value;
  throw new Error("Unsupported MASTRA_OM_SCOPE " + JSON.stringify(value));
}

function parsePermissionPolicy(value: unknown): MastraPermissionPolicy {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new Error("Permission policies must be allow, ask, or deny");
}

function parsePermissionRules(
  value: string | undefined,
  envName: string
): MastraPermissionRules | undefined {
  if (!value) return undefined;
  const parsed = parseJsonRecord(value, envName);
  const categories: Record<string, MastraPermissionPolicy> = {};
  const tools: Record<string, MastraPermissionPolicy> = {};

  const parsedCategories = parsed.categories;
  if (parsedCategories !== undefined) {
    if (!parsedCategories || typeof parsedCategories !== "object" || Array.isArray(parsedCategories)) {
      throw new Error(envName + ".categories must be a JSON object");
    }
    for (const [key, policy] of Object.entries(parsedCategories)) {
      categories[key] = parsePermissionPolicy(policy);
    }
  }

  const parsedTools = parsed.tools;
  if (parsedTools !== undefined) {
    if (!parsedTools || typeof parsedTools !== "object" || Array.isArray(parsedTools)) {
      throw new Error(envName + ".tools must be a JSON object");
    }
    for (const [key, policy] of Object.entries(parsedTools)) {
      tools[key] = parsePermissionPolicy(policy);
    }
  }

  return {
    categories: {
      ...DEFAULT_PERMISSION_RULES.categories,
      ...categories,
    },
    tools,
  };
}

function parseOptionalNumber(value: string | undefined, envName: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(envName + " must be a finite number");
  }
  return parsed;
}

export function configFromEnv(env: EnvLike): Partial<MastraRunnerConfig> {
  return {
    sandboxMode: parseSandboxMode(env.MASTRA_RUNNER_SANDBOX_MODE),
    workspacePath: env.MASTRA_RUNNER_WORKSPACE_PATH || DEFAULT_WORKSPACE_PATH,
    allowLocalSandbox: parseBoolean(env.MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX),
    modelId: env.MASTRA_CODE_MODEL || env.OPEN_INSPECT_CODE_MODEL || undefined,
    mode: parseMode(env.MASTRA_CODE_MODE),
    threadId: env.MASTRA_CODE_THREAD_ID || undefined,
    newThreadTitle: env.MASTRA_CODE_NEW_THREAD_TITLE || undefined,
    initHarness: !parseBoolean(env.MASTRA_RUNNER_SKIP_HARNESS_INIT),
    destroyHarnessOnFinish: !parseBoolean(env.MASTRA_RUNNER_KEEP_HARNESS),
    disableMcp: parseBoolean(env.MASTRA_CODE_DISABLE_MCP),
    disableHooks: parseBoolean(env.MASTRA_CODE_DISABLE_HOOKS),
    configDir: env.MASTRA_CODE_CONFIG_DIR || DEFAULT_CONFIG_DIR,
    yolo: parseBoolean(env.MASTRA_CODE_YOLO),
    permissionRules:
      parsePermissionRules(env.MASTRA_CODE_PERMISSION_RULES_JSON, "MASTRA_CODE_PERMISSION_RULES_JSON") ??
      DEFAULT_PERMISSION_RULES,
    storageUrl: env.MASTRA_DB_URL || undefined,
    storageAuthToken: env.MASTRA_DB_AUTH_TOKEN || undefined,
    omScope: parseOmScope(env.MASTRA_OM_SCOPE),
    observerModelId: env.MASTRA_CODE_OBSERVER_MODEL || env.DEFAULT_OM_MODEL_ID || undefined,
    reflectorModelId: env.MASTRA_CODE_REFLECTOR_MODEL || env.DEFAULT_OM_MODEL_ID || undefined,
    observationThreshold: parseOptionalNumber(
      env.MASTRA_CODE_OBSERVATION_THRESHOLD,
      "MASTRA_CODE_OBSERVATION_THRESHOLD"
    ),
    reflectionThreshold: parseOptionalNumber(
      env.MASTRA_CODE_REFLECTION_THRESHOLD,
      "MASTRA_CODE_REFLECTION_THRESHOLD"
    ),
    loadObservationalMemory: !parseBoolean(env.MASTRA_RUNNER_SKIP_OM_LOAD),
    daytonaApiKey: env.DAYTONA_API_KEY || undefined,
    daytonaApiUrl: env.DAYTONA_API_URL || undefined,
    daytonaTarget: env.DAYTONA_TARGET || undefined,
    daytonaSandboxId: env.MASTRA_DAYTONA_SANDBOX_ID || undefined,
    daytonaSnapshot: env.MASTRA_DAYTONA_SNAPSHOT || undefined,
    daytonaTimeoutMs:
      parseOptionalNumber(env.MASTRA_DAYTONA_TIMEOUT_MS, "MASTRA_DAYTONA_TIMEOUT_MS") ??
      DEFAULT_DAYTONA_TIMEOUT_MS,
    daytonaAutoStopIntervalMinutes: parseOptionalNumber(
      env.MASTRA_DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
      "MASTRA_DAYTONA_AUTO_STOP_INTERVAL_MINUTES"
    ),
  };
}

export function resolveMastraRunnerConfig(
  override: Partial<MastraRunnerConfig> = {},
  env: EnvLike = process.env
): MastraRunnerConfig {
  const merged = {
    ...configFromEnv(env),
    ...override,
  };

  const config: MastraRunnerConfig = {
    sandboxMode: merged.sandboxMode ?? "existing",
    workspacePath: merged.workspacePath || DEFAULT_WORKSPACE_PATH,
    allowLocalSandbox: merged.allowLocalSandbox ?? false,
    modelId: merged.modelId,
    mode: merged.mode,
    threadId: merged.threadId,
    newThreadTitle: merged.newThreadTitle,
    initHarness: merged.initHarness ?? true,
    destroyHarnessOnFinish: merged.destroyHarnessOnFinish ?? true,
    disableMcp: merged.disableMcp ?? false,
    disableHooks: merged.disableHooks ?? false,
    configDir: merged.configDir || DEFAULT_CONFIG_DIR,
    yolo: merged.yolo ?? false,
    permissionRules: merged.permissionRules ?? DEFAULT_PERMISSION_RULES,
    storageUrl: merged.storageUrl,
    storageAuthToken: merged.storageAuthToken,
    omScope: merged.omScope,
    observerModelId: merged.observerModelId,
    reflectorModelId: merged.reflectorModelId,
    observationThreshold: merged.observationThreshold,
    reflectionThreshold: merged.reflectionThreshold,
    loadObservationalMemory: merged.loadObservationalMemory ?? true,
    daytonaApiKey: merged.daytonaApiKey,
    daytonaApiUrl: merged.daytonaApiUrl,
    daytonaTarget: merged.daytonaTarget,
    daytonaSandboxId: merged.daytonaSandboxId,
    daytonaSnapshot: merged.daytonaSnapshot,
    daytonaTimeoutMs: merged.daytonaTimeoutMs ?? DEFAULT_DAYTONA_TIMEOUT_MS,
    daytonaAutoStopIntervalMinutes: merged.daytonaAutoStopIntervalMinutes,
  };

  if (config.sandboxMode === "existing" && !config.allowLocalSandbox) {
    throw new Error(
      "sandboxMode=existing requires MASTRA_RUNNER_ALLOW_LOCAL_SANDBOX=1 or allowLocalSandbox=true"
    );
  }

  return config;
}
