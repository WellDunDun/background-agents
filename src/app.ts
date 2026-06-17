import { flue } from "@flue/runtime/routing";
import { Hono, type Context } from "hono";

import {
  makeFactoryJobInput,
  parseFactoryJobInput,
  parseFactoryJobRequest,
} from "./shared/factory-types.js";
import { resolveFactoryEnv, type FactoryEnv } from "./shared/env.js";
import {
  admitFactoryJob,
  dispatchLocalFactoryJob,
  FactoryAdmissionError,
  proxyRunnerAgentEvents,
} from "./shared/factory-admission.js";
import { handleGitHubWebhook } from "./shared/github-webhook.js";
import {
  requireFactoryApiToken,
  requireFactoryRunnerToken,
  requireFactoryTransportToken,
} from "./shared/http-auth.js";
import { getGitHubAppConfig, listInstallationRepositories } from "./shared/github.js";
import {
  isAcceptedSentryLevel,
  normalizeSentrySignal,
  verifySentrySignature,
} from "./shared/sentry.js";

const app = new Hono<{ Bindings: FactoryEnv }>();
const MAX_SENTRY_PAYLOAD_BYTES = 256 * 1024;

app.get("/health", (c) => {
  return c.json({ ok: true, service: "flue-factory" });
});

app.post("/api/jobs", async (c) => {
  const authError = requireFactoryApiToken(c);
  if (authError) {
    return authError;
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = parseFactoryJobRequest(payload);

  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const jobId = crypto.randomUUID();
  const input = makeFactoryJobInput(jobId, parsed.value);
  const admission = await admitFactoryJob(resolveFactoryEnv(c.env), input).catch((error: unknown) =>
    factoryAdmissionErrorResponse(c, error),
  );
  return admission instanceof Response ? admission : c.json(admission, 202);
});

app.post("/api/runner/jobs", async (c) => {
  const authError = requireFactoryRunnerToken(c);
  if (authError) {
    return authError;
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = parseFactoryJobInput(payload);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const admission = await dispatchLocalFactoryJob(parsed.value);
  return c.json(admission, 202);
});

app.get("/api/jobs/:instanceId/events", async (c) => {
  const authError = requireFactoryApiToken(c);
  if (authError) {
    return authError;
  }

  return proxyRunnerAgentEvents(resolveFactoryEnv(c.env), c.req.param("instanceId"), c.req.raw).catch(
    (error: unknown) => factoryAdmissionErrorResponse(c, error),
  );
});

app.get("/api/config/status", (c) => {
  const authError = requireFactoryApiToken(c);
  if (authError) {
    return authError;
  }

  return c.json({
    ...configStatus(resolveFactoryEnv(c.env)),
  });
});

app.get("/api/github/repositories", async (c) => {
  const authError = requireFactoryApiToken(c);
  if (authError) {
    return authError;
  }

  const repositories = await listInstallationRepositories(getGitHubAppConfig(resolveFactoryEnv(c.env)));
  return c.json({
    repositories: repositories.map((repo) => ({
      fullName: repo.fullName,
      private: repo.private,
      defaultBranch: repo.defaultBranch,
      language: repo.language,
      writable: Boolean(repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin),
      permissions: {
        admin: Boolean(repo.permissions?.admin),
        maintain: Boolean(repo.permissions?.maintain),
        push: Boolean(repo.permissions?.push),
        triage: Boolean(repo.permissions?.triage),
        pull: Boolean(repo.permissions?.pull),
      },
    })),
  });
});

app.post("/channels/github/webhook", handleGitHubWebhook);

app.post("/webhooks/sentry", async (c) => {
  const env = resolveFactoryEnv(c.env);
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_SENTRY_PAYLOAD_BYTES) {
    return c.json({ error: "Payload too large." }, 413);
  }

  const body = await c.req.text();
  if (body.length > MAX_SENTRY_PAYLOAD_BYTES) {
    return c.json({ error: "Payload too large." }, 413);
  }

  const valid = await verifySentrySignature(
    body,
    c.req.header("sentry-hook-signature"),
    env.SENTRY_WEBHOOK_SECRET,
  );
  if (!valid) {
    return c.json({ error: "Invalid signature." }, 401);
  }

  if (!env.SENTRY_DEFAULT_REPO) {
    return c.json({ error: "SENTRY_DEFAULT_REPO is not configured." }, 503);
  }

  const payload = parseJsonObject(body);
  if (!payload) {
    return c.json({ error: "Invalid JSON." }, 400);
  }

  const signal = normalizeSentrySignal(payload);
  if (!signal) {
    return c.json({ ok: true, skipped: true, reason: "unsupported_event" });
  }

  if (!isAcceptedSentryLevel(signal.sentryLevel, env.SENTRY_ACCEPT_LEVELS)) {
    return c.json({ ok: true, skipped: true, reason: "level_not_accepted" });
  }

  const request = {
    prompt:
      signal.contextBlock +
      "\n\nInvestigate the likely code cause, implement the smallest safe fix in the repository, run focused verification, and prepare a draft PR for human review.",
    repo: env.SENTRY_DEFAULT_REPO,
    baseBranch: env.SENTRY_DEFAULT_BASE_BRANCH || "main",
    source: "sentry" as const,
    signalId: signal.triggerKey,
    metadata: {
      eventType: signal.eventType,
      triggerKey: signal.triggerKey,
      concurrencyKey: signal.concurrencyKey,
      sentryProject: signal.sentryProject,
      sentryLevel: signal.sentryLevel,
      culpritFile: signal.culpritFile,
      ...signal.meta,
    },
  };
  const instanceId = signal.concurrencyKey;
  const admission = await admitFactoryJob(env, makeFactoryJobInput(instanceId, request)).catch(
    (error: unknown) => factoryAdmissionErrorResponse(c, error),
  );
  if (admission instanceof Response) {
    return admission;
  }

  return c.json(
    {
      ...admission,
      accepted: true,
    },
    202,
  );
});

app.use("/agents/*", requireFactoryTransportToken);
app.use("/runs/*", requireFactoryTransportToken);
app.use("/workflows/*", requireFactoryTransportToken);
app.route("/", flue());

export default app;

function configStatus(env: FactoryEnv) {
  return {
    ok: true,
    model: env.FACTORY_DEFAULT_MODEL ?? "openai-codex/gpt-5.5",
    manualApi: {
      configured: Boolean(env.FACTORY_API_TOKEN),
    },
    codex: {
      accessTokenConfigured: Boolean(env.OPENAI_CODEX_ACCESS_TOKEN),
      refreshTokenConfigured: Boolean(env.OPENAI_CODEX_REFRESH_TOKEN),
    },
    runner: {
      configured: Boolean(env.FACTORY_RUNNER_URL),
      tokenConfigured: Boolean(env.FACTORY_RUNNER_TOKEN),
    },
    daytona: {
      configured: Boolean(env.DAYTONA_API_KEY),
      target: env.DAYTONA_TARGET || null,
      image: env.DAYTONA_IMAGE || null,
      snapshot: env.DAYTONA_SNAPSHOT || null,
    },
    github: {
      appConfigured: Boolean(
        env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID,
      ),
      webhookConfigured: Boolean(env.GITHUB_WEBHOOK_SECRET),
      botUsername: env.GITHUB_BOT_USERNAME || null,
      triggerPhrase: env.FACTORY_GITHUB_TRIGGER_PHRASE || "/factory",
    },
    sentry: {
      webhookConfigured: Boolean(env.SENTRY_WEBHOOK_SECRET),
      defaultRepo: env.SENTRY_DEFAULT_REPO || null,
      acceptedLevels: env.SENTRY_ACCEPT_LEVELS || "error,fatal,critical",
    },
  };
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function factoryAdmissionErrorResponse(
  c: Context<{ Bindings: FactoryEnv }>,
  error: unknown,
): Response {
  if (error instanceof FactoryAdmissionError) {
    return c.json({ error: error.message }, toAdmissionStatus(error.status));
  }

  throw error;
}

function toAdmissionStatus(status: number): 400 | 401 | 403 | 404 | 408 | 409 | 429 | 502 | 503 {
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 408:
    case 409:
    case 429:
    case 503:
      return status;
    default:
      return 502;
  }
}
