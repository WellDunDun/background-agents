import type { Context } from "hono";

import type { FactoryEnv } from "./env.js";

export function requireFactoryApiToken(c: Context<{ Bindings: FactoryEnv }>): Response | undefined {
  const expected = c.env.FACTORY_API_TOKEN;
  if (!expected) {
    return c.json({ error: "FACTORY_API_TOKEN is not configured." }, 503);
  }

  const actual = readBearerToken(c.req.header("Authorization"));
  if (!actual || actual !== expected) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  return undefined;
}

function readBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const [scheme, token, ...extra] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra.length > 0) {
    return undefined;
  }

  return token;
}
