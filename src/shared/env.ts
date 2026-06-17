export interface FactoryEnv {
  FACTORY_API_TOKEN?: string;
  FACTORY_DEFAULT_MODEL?: string;
  FACTORY_RUNNER_URL?: string;
  FACTORY_RUNNER_TOKEN?: string;
  FACTORY_RUNNER_REQUEST_TIMEOUT_MS?: string;
  FACTORY_JOB_LEDGER_PATH?: string;
  FACTORY_WORKSPACE_PROVIDER?: string;
  FACTORY_RUNNER_WORKSPACE_ROOT?: string;
  OPENAI_API_KEY?: string;
  OPENAI_CODEX_ACCESS_TOKEN?: string;
  OPENAI_CODEX_REFRESH_TOKEN?: string;
  FACTORY_CODEX_CREDENTIALS_PATH?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_TARGET?: string;
  DAYTONA_IMAGE?: string;
  DAYTONA_SNAPSHOT?: string;
  DAYTONA_CREATE_TIMEOUT_SECONDS?: string;
  DAYTONA_AUTO_STOP_MINUTES?: string;
  DAYTONA_AUTO_ARCHIVE_MINUTES?: string;
  DAYTONA_AUTO_DELETE_MINUTES?: string;
  FACTORY_GIT_AUTHOR_NAME?: string;
  FACTORY_GIT_AUTHOR_EMAIL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_BOT_USERNAME?: string;
  FACTORY_GITHUB_TRIGGER_PHRASE?: string;
  SENTRY_WEBHOOK_SECRET?: string;
  SENTRY_REPO_MAP?: string;
  SENTRY_DEFAULT_REPO?: string;
  SENTRY_DEFAULT_BASE_BRANCH?: string;
  SENTRY_ACCEPT_LEVELS?: string;
}

export const DEFAULT_FACTORY_MODEL = "openai-codex/gpt-5.5";

const FACTORY_ENV_KEYS = [
  "FACTORY_API_TOKEN",
  "FACTORY_DEFAULT_MODEL",
  "FACTORY_RUNNER_URL",
  "FACTORY_RUNNER_TOKEN",
  "FACTORY_RUNNER_REQUEST_TIMEOUT_MS",
  "FACTORY_JOB_LEDGER_PATH",
  "FACTORY_WORKSPACE_PROVIDER",
  "FACTORY_RUNNER_WORKSPACE_ROOT",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_ACCESS_TOKEN",
  "OPENAI_CODEX_REFRESH_TOKEN",
  "FACTORY_CODEX_CREDENTIALS_PATH",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DAYTONA_IMAGE",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_CREATE_TIMEOUT_SECONDS",
  "DAYTONA_AUTO_STOP_MINUTES",
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_DELETE_MINUTES",
  "FACTORY_GIT_AUTHOR_NAME",
  "FACTORY_GIT_AUTHOR_EMAIL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_BOT_USERNAME",
  "FACTORY_GITHUB_TRIGGER_PHRASE",
  "SENTRY_WEBHOOK_SECRET",
  "SENTRY_REPO_MAP",
  "SENTRY_DEFAULT_REPO",
  "SENTRY_DEFAULT_BASE_BRANCH",
  "SENTRY_ACCEPT_LEVELS",
] as const satisfies ReadonlyArray<keyof FactoryEnv>;

type FactoryEnvKey = (typeof FACTORY_ENV_KEYS)[number];

export function resolveFactoryModel(env: FactoryEnv): string {
  const configured = env.FACTORY_DEFAULT_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_FACTORY_MODEL;
}

export function resolveFactoryEnv(bindings: FactoryEnv | undefined): FactoryEnv {
  const resolved: FactoryEnv = {};
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;

  for (const key of FACTORY_ENV_KEYS) {
    const value = processEnv?.[key];
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  for (const key of FACTORY_ENV_KEYS) {
    const value = bindings?.[key as FactoryEnvKey];
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  return resolved;
}
