import { dispatch } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import orchestrator from "./agents/orchestrator.js";
import {
  makeFactoryJobInput,
  parseFactoryJobRequest,
} from "./shared/factory-types.js";
import type { FactoryEnv } from "./shared/env.js";
import { handleGitHubWebhook } from "./shared/github-webhook.js";
import { requireFactoryApiToken } from "./shared/http-auth.js";
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
  const receipt = await dispatch(orchestrator, {
    id: jobId,
    input,
  });

  return c.json(
    {
      ok: true,
      jobId,
      agent: "orchestrator",
      instanceId: jobId,
      dispatchId: receipt.dispatchId,
      acceptedAt: receipt.acceptedAt,
      streamUrl: "/agents/orchestrator/" + encodeURIComponent(jobId),
    },
    202,
  );
});

app.get("/api/config/status", (c) => {
  const authError = requireFactoryApiToken(c);
  if (authError) {
    return authError;
  }

  return c.json({
    ok: true,
    model: c.env.FACTORY_DEFAULT_MODEL ?? "openai-codex/gpt-5.5",
    manualApi: {
      configured: Boolean(c.env.FACTORY_API_TOKEN),
    },
    codex: {
      accessTokenConfigured: Boolean(c.env.OPENAI_CODEX_ACCESS_TOKEN),
      refreshTokenConfigured: Boolean(c.env.OPENAI_CODEX_REFRESH_TOKEN),
    },
    daytona: {
      configured: Boolean(c.env.DAYTONA_API_KEY),
      target: c.env.DAYTONA_TARGET || null,
      image: c.env.DAYTONA_IMAGE || null,
      snapshot: c.env.DAYTONA_SNAPSHOT || null,
    },
    github: {
      appConfigured: Boolean(
        c.env.GITHUB_APP_ID && c.env.GITHUB_APP_PRIVATE_KEY && c.env.GITHUB_APP_INSTALLATION_ID,
      ),
      webhookConfigured: Boolean(c.env.GITHUB_WEBHOOK_SECRET),
      botUsername: c.env.GITHUB_BOT_USERNAME || null,
      triggerPhrase: c.env.FACTORY_GITHUB_TRIGGER_PHRASE || "/factory",
    },
    sentry: {
      webhookConfigured: Boolean(c.env.SENTRY_WEBHOOK_SECRET),
      defaultRepo: c.env.SENTRY_DEFAULT_REPO || null,
      acceptedLevels: c.env.SENTRY_ACCEPT_LEVELS || "error,fatal,critical",
    },
  });
});

app.post("/channels/github/webhook", handleGitHubWebhook);

app.post("/webhooks/sentry", async (c) => {
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
    c.env.SENTRY_WEBHOOK_SECRET,
  );
  if (!valid) {
    return c.json({ error: "Invalid signature." }, 401);
  }

  if (!c.env.SENTRY_DEFAULT_REPO) {
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

  if (!isAcceptedSentryLevel(signal.sentryLevel, c.env.SENTRY_ACCEPT_LEVELS)) {
    return c.json({ ok: true, skipped: true, reason: "level_not_accepted" });
  }

  const request = {
    prompt:
      signal.contextBlock +
      "\n\nInvestigate the likely code cause, implement the smallest safe fix in the repository, run focused verification, and prepare a draft PR for human review.",
    repo: c.env.SENTRY_DEFAULT_REPO,
    baseBranch: c.env.SENTRY_DEFAULT_BASE_BRANCH || "main",
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
  const receipt = await dispatch(orchestrator, {
    id: instanceId,
    input: makeFactoryJobInput(instanceId, request),
  });

  return c.json(
    {
      ok: true,
      accepted: true,
      agent: "orchestrator",
      instanceId,
      dispatchId: receipt.dispatchId,
      streamUrl: "/agents/orchestrator/" + encodeURIComponent(instanceId),
    },
    202,
  );
});

app.route("/", flue());

export default app;

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
