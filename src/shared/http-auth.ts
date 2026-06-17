import type { Context, Next } from "hono";

import { resolveFactoryEnv, type FactoryEnv } from "./env.js";

export function requireFactoryApiToken(c: Context<{ Bindings: FactoryEnv }>): Response | undefined {
  const env = resolveFactoryEnv(c.env);
  return requireBearerToken(c, "FACTORY_API_TOKEN", [env.FACTORY_API_TOKEN]);
}

export function requireFactoryRunnerToken(c: Context<{ Bindings: FactoryEnv }>): Response | undefined {
  const env = resolveFactoryEnv(c.env);
  return requireBearerToken(c, "FACTORY_RUNNER_TOKEN", [env.FACTORY_RUNNER_TOKEN]);
}

export async function requireFactoryTransportToken(
  c: Context<{ Bindings: FactoryEnv }>,
  next: Next,
): Promise<Response | void> {
  const env = resolveFactoryEnv(c.env);
  const authError = requireBearerToken(c, "FACTORY_API_TOKEN or FACTORY_RUNNER_TOKEN", [
    env.FACTORY_API_TOKEN,
    env.FACTORY_RUNNER_TOKEN,
  ]);
  if (authError) {
    return authError;
  }

  await next();
}

function requireBearerToken(
  c: Context<{ Bindings: FactoryEnv }>,
  label: string,
  expectedValues: Array<string | undefined>,
): Response | undefined {
  const configured = expectedValues.filter((value): value is string => Boolean(value));
  if (configured.length === 0) {
    return c.json({ error: label + " is not configured." }, 503);
  }

  const actual = readBearerToken(c.req.header("Authorization"));
  if (!actual || !configured.some((expected) => secureStringEqual(actual, expected))) {
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

function secureStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
