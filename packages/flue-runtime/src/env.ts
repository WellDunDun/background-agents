export interface OpenInspectFlueEnv {
  [key: string]: string | undefined;
  AGENT_RUNTIME?: string;
  CONTROL_PLANE_URL?: string;
  SANDBOX_AUTH_TOKEN?: string;
  SANDBOX_ID?: string;
  SESSION_CONFIG?: string;
  REPO_NAME?: string;
  FLUE_CODE_MODEL?: string;
  FLUE_SERVER_URL?: string;
  FLUE_SERVER_PORT?: string;
  OPENAI_OAUTH_ACCESS_TOKEN?: string;
  OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT?: string;
  OPENAI_OAUTH_ACCOUNT_ID?: string;
}

export interface SessionConfigPayload {
  session_id: string;
  repo_owner?: string;
  repo_name?: string;
  provider?: string;
  model?: string;
  branch?: string;
}

export function parseSessionConfig(env: OpenInspectFlueEnv): SessionConfigPayload {
  const raw = env.SESSION_CONFIG;
  if (!raw) {
    throw new Error("SESSION_CONFIG is required for the Flue runtime.");
  }

  const parsed = JSON.parse(raw) as Partial<SessionConfigPayload>;
  if (!parsed.session_id) {
    throw new Error("SESSION_CONFIG.session_id is required for the Flue runtime.");
  }

  return parsed as SessionConfigPayload;
}

export function resolveRepoPath(env: OpenInspectFlueEnv): string {
  const sessionConfig = parseSessionConfig(env);
  const repoName = env.REPO_NAME ?? sessionConfig.repo_name;
  return repoName ? "/workspace/" + repoName : "/workspace";
}

export function resolveFlueCodeModel(env: OpenInspectFlueEnv, requestedModel?: string): string {
  const normalized = normalizeModel(requestedModel);
  if (normalized) return normalized;

  if (env.FLUE_CODE_MODEL?.trim()) return env.FLUE_CODE_MODEL.trim();

  const sessionConfig = safeParseSessionConfig(env);
  const fromSession = normalizeModel(sessionConfig?.model);
  if (fromSession) return fromSession;

  return "openai-codex/gpt-5.5";
}

export function resolveFlueServerUrl(env: OpenInspectFlueEnv): string {
  if (env.FLUE_SERVER_URL?.trim()) return env.FLUE_SERVER_URL.trim().replace(/\/$/, "");
  const port = parsePositiveInteger(env.FLUE_SERVER_PORT, 3000, "FLUE_SERVER_PORT");
  return "http://127.0.0.1:" + port;
}

export function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(name + " must be a positive integer.");
  }
  return parsed;
}

function safeParseSessionConfig(env: OpenInspectFlueEnv): Partial<SessionConfigPayload> | null {
  try {
    return parseSessionConfig(env);
  } catch {
    return null;
  }
}

function normalizeModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/")) return trimmed;
  return "openai-codex/" + trimmed;
}
