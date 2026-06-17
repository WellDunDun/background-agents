import { type FactoryEnv, resolveFactoryModel } from "./env.js";
import {
  canWriteRepository,
  getGitHubAppConfig,
  listInstallationRepositories,
  type InstallationRepository,
} from "./github.js";
import { getFactorySentryRouteConfig } from "./sentry-routes.js";

export type FactoryReadinessRuntime = "worker" | "runner" | "combined";
export type FactoryReadinessState = "ready" | "needs_setup" | "blocked";
export type FactoryReadinessCheckStatus = "pass" | "warn" | "block";

export interface FactoryReadinessCheck {
  id: string;
  label: string;
  status: FactoryReadinessCheckStatus;
  detail: string;
  action?: string;
}

export interface FactoryReadiness {
  ok: boolean;
  runtime: FactoryReadinessRuntime;
  state: FactoryReadinessState;
  model: string;
  checks: FactoryReadinessCheck[];
  summary: {
    blocked: number;
    warnings: number;
  };
  github: {
    configured: boolean;
    repositoryCount: number;
    writableRepositoryCount: number;
  };
  sentry: {
    webhookConfigured: boolean;
    routeConfigured: boolean;
  };
  scopes?: {
    worker?: FactoryReadiness;
    runner?: FactoryReadiness;
  };
}

export async function getFactoryReadiness(
  env: FactoryEnv,
  options: { runtime: "worker" | "runner" },
): Promise<FactoryReadiness> {
  const checks: FactoryReadinessCheck[] = [];
  const githubSummary = {
    configured: hasGitHubAppConfig(env),
    repositoryCount: 0,
    writableRepositoryCount: 0,
  };
  let sentryRouteConfigured = Boolean(env.SENTRY_REPO_MAP || env.SENTRY_DEFAULT_REPO);

  if (options.runtime === "runner") {
    const routeConfig = await getFactorySentryRouteConfig(env).catch(() => undefined);
    sentryRouteConfigured =
      sentryRouteConfigured ||
      Boolean(routeConfig && (Object.keys(routeConfig.routes).length > 0 || routeConfig.defaultRoute));
  }

  if (options.runtime === "worker") {
    addWorkerChecks(checks, env);
  } else {
    addRunnerChecks(checks, env);
  }

  await addGitHubChecks(checks, env, githubSummary, options.runtime === "worker");

  if (options.runtime === "worker") {
    addSignalChecks(checks, env);
  }

  return buildReadiness({
    runtime: options.runtime,
    model: resolveFactoryModel(env),
    checks,
    github: githubSummary,
    sentry: {
      webhookConfigured: Boolean(env.SENTRY_WEBHOOK_SECRET),
      routeConfigured: sentryRouteConfigured,
    },
  });
}

export function combineFactoryReadiness(
  worker: FactoryReadiness,
  runner: FactoryReadiness,
): FactoryReadiness {
  const workerChecks = runner.sentry.routeConfigured
    ? worker.checks.filter((check) => check.id !== "sentry-route")
    : worker.checks;
  return buildReadiness({
    runtime: "combined",
    model: worker.model,
    checks: [
      ...workerChecks.map((check) => scopeCheck("worker", check)),
      ...runner.checks.map((check) => scopeCheck("runner", check)),
    ],
    github: worker.github,
    sentry: {
      webhookConfigured: worker.sentry.webhookConfigured,
      routeConfigured: worker.sentry.routeConfigured || runner.sentry.routeConfigured,
    },
    scopes: { worker, runner },
  });
}

export function runnerReadinessFailureCheck(error: unknown): FactoryReadinessCheck {
  return {
    id: "runner:readiness",
    label: "Runner readiness",
    status: "block",
    detail: "The Worker could not read the runner readiness endpoint: " + errorMessage(error),
    action: "Verify FACTORY_RUNNER_URL, FACTORY_RUNNER_TOKEN, and the Daytona runner health.",
  };
}

function addWorkerChecks(checks: FactoryReadinessCheck[], env: FactoryEnv): void {
  checks.push(
    makeCheck({
      id: "manual-api-token",
      label: "Manual API token",
      passed: Boolean(env.FACTORY_API_TOKEN),
      blockWhenMissing: true,
      passDetail: "Manual API routes are protected.",
      missingDetail: "Manual API routes are not protected because FACTORY_API_TOKEN is missing.",
      action: "Set FACTORY_API_TOKEN on the Worker.",
    }),
  );

  checks.push(
    makeCheck({
      id: "runner",
      label: "Node runner",
      passed: Boolean(env.FACTORY_RUNNER_URL && env.FACTORY_RUNNER_TOKEN),
      blockWhenMissing: true,
      passDetail: "Jobs execute on the Node runner instead of inside the Cloudflare Worker.",
      missingDetail: "The Worker cannot dispatch subscription-backed Codex work without FACTORY_RUNNER_URL and FACTORY_RUNNER_TOKEN.",
      action: "Deploy the Daytona runner and configure FACTORY_RUNNER_URL plus FACTORY_RUNNER_TOKEN on the Worker.",
    }),
  );
}

function addRunnerChecks(checks: FactoryReadinessCheck[], env: FactoryEnv): void {
  checks.push(
    makeCheck({
      id: "runner-token",
      label: "Runner token",
      passed: Boolean(env.FACTORY_RUNNER_TOKEN),
      blockWhenMissing: true,
      passDetail: "Runner ingress is protected.",
      missingDetail: "Runner ingress is not protected because FACTORY_RUNNER_TOKEN is missing.",
      action: "Set FACTORY_RUNNER_TOKEN on the runner and Worker.",
    }),
  );

  checks.push(
    makeCheck({
      id: "codex-auth",
      label: "Codex subscription auth",
      passed: Boolean(env.OPENAI_CODEX_ACCESS_TOKEN || env.OPENAI_CODEX_REFRESH_TOKEN),
      blockWhenMissing: true,
      passDetail: "A Codex access or refresh token is configured on the runner.",
      missingDetail: "No Codex access or refresh token is configured on the runner.",
      action: "Run npm run auth:sync-codex locally, then redeploy the Daytona runner with the refreshed token values.",
    }),
  );

  checks.push(workspaceCheck(env));
}

async function addGitHubChecks(
  checks: FactoryReadinessCheck[],
  env: FactoryEnv,
  githubSummary: FactoryReadiness["github"],
  includeRepositoryWriteCheck: boolean,
): Promise<void> {
  checks.push(
    makeCheck({
      id: "github-app",
      label: "GitHub App",
      passed: githubSummary.configured,
      blockWhenMissing: true,
      passDetail: "GitHub App credentials are configured.",
      missingDetail: "GitHub App credentials are incomplete.",
      action: "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
    }),
  );

  if (!githubSummary.configured || !includeRepositoryWriteCheck) {
    return;
  }

  try {
    const repositories = await listInstallationRepositories(getGitHubAppConfig(env));
    githubSummary.repositoryCount = repositories.length;
    githubSummary.writableRepositoryCount = repositories.filter((repo) => canWriteRepository(repo)).length;
    checks.push(githubRepositoryCheck(repositories));
  } catch (error) {
    checks.push({
      id: "github-repositories",
      label: "GitHub repository access",
      status: "block",
      detail: "The GitHub App installation repositories could not be listed: " + errorMessage(error),
      action: "Verify the GitHub App installation id, private key format, and repository access.",
    });
  }
}

function addSignalChecks(checks: FactoryReadinessCheck[], env: FactoryEnv): void {
  checks.push(
    makeCheck({
      id: "github-webhook",
      label: "GitHub webhook",
      passed: Boolean(env.GITHUB_WEBHOOK_SECRET),
      blockWhenMissing: false,
      passDetail: "GitHub webhook verification is configured.",
      missingDetail: "GITHUB_WEBHOOK_SECRET is missing; GitHub issue/comment/PR signals cannot be verified.",
      action: "Set GITHUB_WEBHOOK_SECRET and configure the GitHub App webhook.",
    }),
  );

  checks.push(
    makeCheck({
      id: "sentry-webhook",
      label: "Sentry webhook",
      passed: Boolean(env.SENTRY_WEBHOOK_SECRET),
      blockWhenMissing: false,
      passDetail: "Sentry webhook verification is configured.",
      missingDetail: "SENTRY_WEBHOOK_SECRET is missing; Sentry alerts cannot be verified.",
      action: "Set SENTRY_WEBHOOK_SECRET and configure the Sentry webhook.",
    }),
  );

  checks.push(
    makeCheck({
      id: "sentry-route",
      label: "Sentry route map",
      passed: Boolean(env.SENTRY_REPO_MAP || env.SENTRY_DEFAULT_REPO),
      blockWhenMissing: false,
      passDetail: "Sentry alerts have a repository routing rule.",
      missingDetail: "Sentry alerts do not have a repository routing rule.",
      action: "Set SENTRY_REPO_MAP or SENTRY_DEFAULT_REPO.",
    }),
  );
}

function workspaceCheck(env: FactoryEnv): FactoryReadinessCheck {
  if (env.FACTORY_WORKSPACE_PROVIDER === "runner") {
    return {
      id: "workspace",
      label: "Workspace provider",
      status: "pass",
      detail: "The Daytona runner sandbox is the Flue workspace boundary.",
    };
  }

  return makeCheck({
    id: "workspace",
    label: "Workspace provider",
    passed: Boolean(env.DAYTONA_API_KEY),
    blockWhenMissing: true,
    passDetail: "Daytona credentials are configured for per-job sandbox workspaces.",
    missingDetail: "DAYTONA_API_KEY is missing for per-job Daytona workspaces.",
    action: "Set DAYTONA_API_KEY or deploy the runner with FACTORY_WORKSPACE_PROVIDER=runner.",
  });
}

function hasGitHubAppConfig(env: FactoryEnv): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID);
}

function githubRepositoryCheck(repositories: InstallationRepository[]): FactoryReadinessCheck {
  const writableCount = repositories.filter((repo) => canWriteRepository(repo)).length;
  if (writableCount > 0) {
    return {
      id: "github-repositories",
      label: "GitHub repository write access",
      status: "pass",
      detail: "The GitHub App can write to " + writableCount + " of " + repositories.length + " visible repositories.",
    };
  }

  return {
    id: "github-repositories",
    label: "GitHub repository write access",
    status: "block",
    detail: "The GitHub App can see " + repositories.length + " repositories but cannot write to any of them.",
    action: "Update the GitHub App installation to grant write access to at least one target repository.",
  };
}

function makeCheck(input: {
  id: string;
  label: string;
  passed: boolean;
  blockWhenMissing: boolean;
  passDetail: string;
  missingDetail: string;
  action: string;
}): FactoryReadinessCheck {
  if (input.passed) {
    return {
      id: input.id,
      label: input.label,
      status: "pass",
      detail: input.passDetail,
    };
  }

  return {
    id: input.id,
    label: input.label,
    status: input.blockWhenMissing ? "block" : "warn",
    detail: input.missingDetail,
    action: input.action,
  };
}

function buildReadiness(input: {
  runtime: FactoryReadinessRuntime;
  model: string;
  checks: FactoryReadinessCheck[];
  github: FactoryReadiness["github"];
  sentry: FactoryReadiness["sentry"];
  scopes?: FactoryReadiness["scopes"];
}): FactoryReadiness {
  const blocked = input.checks.filter((check) => check.status === "block").length;
  const warnings = input.checks.filter((check) => check.status === "warn").length;

  return {
    ok: blocked === 0,
    runtime: input.runtime,
    state: blocked > 0 ? "blocked" : warnings > 0 ? "needs_setup" : "ready",
    model: input.model,
    checks: input.checks,
    summary: {
      blocked,
      warnings,
    },
    github: input.github,
    sentry: input.sentry,
    scopes: input.scopes,
  };
}

function scopeCheck(scope: "worker" | "runner", check: FactoryReadinessCheck): FactoryReadinessCheck {
  return {
    ...check,
    id: scope + ":" + check.id,
    label: scope === "worker" ? "Worker " + check.label : "Runner " + check.label,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
