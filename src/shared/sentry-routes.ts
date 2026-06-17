import type { FactoryEnv } from "./env.js";
import { parseRepositorySlug } from "./github.js";
import type { NormalizedSentrySignal, SentryRepositoryRoute } from "./sentry.js";

export interface FactorySentryRouteConfig {
  routes: Record<string, SentryRepositoryRoute>;
  defaultRoute?: SentryRepositoryRoute;
  updatedAt: string;
}

export interface FactorySentryRoutePatch {
  routes?: Record<string, SentryRepositoryRoute>;
  defaultRoute?: SentryRepositoryRoute | null;
}

const DEFAULT_SENTRY_ROUTE_CONFIG_PATH = ".factory-sentry-routes.json";

export async function getFactorySentryRouteConfig(env: FactoryEnv): Promise<FactorySentryRouteConfig> {
  const fs = await importNodeFs();
  if (!fs) {
    return defaultSentryRouteConfig();
  }

  const filePath = getSentryRouteConfigPath(env);
  const text = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!text.trim()) {
    return defaultSentryRouteConfig();
  }

  try {
    return parseSentryRouteConfig(JSON.parse(text));
  } catch {
    return defaultSentryRouteConfig();
  }
}

export async function updateFactorySentryRouteConfig(
  env: FactoryEnv,
  patch: FactorySentryRoutePatch,
): Promise<FactorySentryRouteConfig> {
  const fs = await importNodeFs();
  if (!fs) {
    throw new Error("Sentry route config is writable only in the Node runner runtime.");
  }

  const previous = await getFactorySentryRouteConfig(env);
  const next: FactorySentryRouteConfig = {
    routes: patch.routes ?? previous.routes,
    ...(patch.defaultRoute === undefined
      ? previous.defaultRoute
        ? { defaultRoute: previous.defaultRoute }
        : {}
      : patch.defaultRoute
        ? { defaultRoute: patch.defaultRoute }
        : {}),
    updatedAt: new Date().toISOString(),
  };

  const filePath = getSentryRouteConfigPath(env);
  const { dirname } = await import("node:path");
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function resolveConfiguredSentryRepositoryRoute(
  signal: Pick<NormalizedSentrySignal, "sentryProject">,
  config: FactorySentryRouteConfig,
): SentryRepositoryRoute | null {
  return config.routes[signal.sentryProject] ?? config.routes["*"] ?? config.routes._default ?? config.defaultRoute ?? null;
}

export function normalizeSentryRoutePatch(value: unknown): { ok: true; value: FactorySentryRoutePatch } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Expected a JSON object." };
  }

  const record = value as Record<string, unknown>;
  const patch: FactorySentryRoutePatch = {};
  if ("routes" in record) {
    const routes = normalizeRouteMap(record.routes);
    if (!routes.ok) {
      return routes;
    }
    patch.routes = routes.value;
  }

  if ("defaultRoute" in record) {
    if (record.defaultRoute === null) {
      patch.defaultRoute = null;
    } else {
      const route = normalizeRoute(record.defaultRoute);
      if (!route.ok) {
        return route;
      }
      patch.defaultRoute = route.value;
    }
  }

  if (!("routes" in patch) && !("defaultRoute" in patch)) {
    return { ok: false, error: "Provide routes or defaultRoute." };
  }

  return { ok: true, value: patch };
}

function parseSentryRouteConfig(value: unknown): FactorySentryRouteConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultSentryRouteConfig();
  }

  const record = value as Record<string, unknown>;
  const routes = normalizeRouteMap(record.routes);
  const defaultRoute = normalizeOptionalRoute(record.defaultRoute);
  return {
    routes: routes.ok ? routes.value : {},
    ...(defaultRoute ? { defaultRoute } : {}),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "1970-01-01T00:00:00.000Z",
  };
}

function normalizeRouteMap(value: unknown): { ok: true; value: Record<string, SentryRepositoryRoute> } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "routes must be an object." };
  }

  const routes: Record<string, SentryRepositoryRoute> = {};
  for (const [project, routeValue] of Object.entries(value)) {
    const key = project.trim();
    if (!isValidRouteKey(key)) {
      return { ok: false, error: "Invalid Sentry route key: " + project };
    }
    const route = normalizeRoute(routeValue);
    if (!route.ok) {
      return { ok: false, error: "Invalid route for " + project + ": " + route.error };
    }
    routes[key] = route.value;
  }
  return { ok: true, value: routes };
}

function normalizeOptionalRoute(value: unknown): SentryRepositoryRoute | undefined {
  const route = normalizeRoute(value);
  return route.ok ? route.value : undefined;
}

function normalizeRoute(value: unknown): { ok: true; value: SentryRepositoryRoute } | { ok: false; error: string } {
  if (typeof value === "string") {
    return normalizeRouteObject({ repo: value, baseBranch: "main" });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "route must be a repo string or route object." };
  }
  return normalizeRouteObject(value as Record<string, unknown>);
}

function normalizeRouteObject(value: Record<string, unknown>): { ok: true; value: SentryRepositoryRoute } | { ok: false; error: string } {
  if (typeof value.repo !== "string" || !value.repo.trim()) {
    return { ok: false, error: "repo is required." };
  }
  const repo = value.repo.trim();
  try {
    parseRepositorySlug(repo);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const baseBranch = typeof value.baseBranch === "string" && value.baseBranch.trim() ? value.baseBranch.trim() : "main";
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseBranch) || baseBranch.includes("..")) {
    return { ok: false, error: "baseBranch is invalid." };
  }

  return { ok: true, value: { repo, baseBranch } };
}

function isValidRouteKey(value: string): boolean {
  return value === "*" || value === "_default" || /^[A-Za-z0-9._-]{1,120}$/.test(value);
}

function defaultSentryRouteConfig(): FactorySentryRouteConfig {
  return {
    routes: {},
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function getSentryRouteConfigPath(env: FactoryEnv): string {
  return env.FACTORY_SENTRY_ROUTE_CONFIG_PATH?.trim() || DEFAULT_SENTRY_ROUTE_CONFIG_PATH;
}

async function importNodeFs(): Promise<typeof import("node:fs/promises") | null> {
  const processEnv = (globalThis as { process?: unknown }).process;
  if (!processEnv) {
    return null;
  }
  return import("node:fs/promises");
}

function isNodeError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
