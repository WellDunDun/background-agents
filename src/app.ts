import { dispatch } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import orchestrator from "./agents/orchestrator.js";
import {
  makeFactoryJobInput,
  parseFactoryJobRequest,
} from "./shared/factory-types.js";
import type { FactoryEnv } from "./shared/env.js";
import { requireFactoryApiToken } from "./shared/http-auth.js";

const app = new Hono<{ Bindings: FactoryEnv }>();

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
  });
});

app.route("/", flue());

export default app;
