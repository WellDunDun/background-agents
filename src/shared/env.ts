export interface FactoryEnv {
  FACTORY_DEFAULT_MODEL?: string;
  OPENAI_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SENTRY_WEBHOOK_SECRET?: string;
}

export const DEFAULT_FACTORY_MODEL = "openai-codex/gpt-5.5";

export function resolveFactoryModel(env: FactoryEnv): string {
  const configured = env.FACTORY_DEFAULT_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_FACTORY_MODEL;
}

