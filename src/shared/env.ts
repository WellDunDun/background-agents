export interface FactoryEnv {
  FACTORY_API_TOKEN?: string;
  FACTORY_DEFAULT_MODEL?: string;
  OPENAI_API_KEY?: string;
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
  SENTRY_DEFAULT_REPO?: string;
  SENTRY_DEFAULT_BASE_BRANCH?: string;
  SENTRY_ACCEPT_LEVELS?: string;
}

export const DEFAULT_FACTORY_MODEL = "openai-codex/gpt-5.5";

export function resolveFactoryModel(env: FactoryEnv): string {
  const configured = env.FACTORY_DEFAULT_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_FACTORY_MODEL;
}
