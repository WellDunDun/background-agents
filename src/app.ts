import { dispatch, observe } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import orchestrator from "./agents/orchestrator.js";
import {
  makeFactoryJobInput,
  parseFactoryJobRequest,
} from "./shared/factory-types.js";
import type { FactoryEnv } from "./shared/env.js";

const app = new Hono<{ Bindings: FactoryEnv }>();

observe((event) => {
  if (event.type === "error") {
    console.error("flue_error", event);
  }
});

app.get("/health", (c) => {
  return c.json({ ok: true, service: "flue-factory" });
});

app.post("/api/jobs", async (c) => {
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
    },
    202,
  );
});

app.route("/", flue());

export default app;

