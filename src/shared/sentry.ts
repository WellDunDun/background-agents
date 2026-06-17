import type { FactoryEnv } from "./env.js";

export interface NormalizedSentrySignal {
  eventType: string;
  triggerKey: string;
  concurrencyKey: string;
  sentryProject: string;
  sentryLevel: string;
  culpritFile?: string;
  contextBlock: string;
  meta: Record<string, unknown>;
}

export interface SentryRepositoryRoute {
  repo: string;
  baseBranch: string;
}

interface SentryIssueAlertPayload {
  action: string;
  data: {
    event: {
      event_id: string;
      title: string;
      culprit: string;
      level: string;
      metadata: {
        type?: string;
        value?: string;
        filename?: string;
        function?: string;
      };
      exception?: {
        values: Array<{
          type: string;
          value: string;
          stacktrace?: {
            frames: Array<{
              filename?: string;
              function?: string;
              lineno?: number;
              colno?: number;
              abs_path?: string;
              in_app?: boolean;
            }>;
          };
        }>;
      };
      tags?: Array<{ key: string; value: string }>;
    };
    issue: {
      id: string;
      shortId: string;
      title: string;
      culprit: string;
      level: string;
      project: { id: number; slug: string; name: string };
      count: string;
      firstSeen: string;
      lastSeen: string;
      status: string;
    };
    triggered_rule?: string;
  };
}

interface SentryMetricAlertPayload {
  action: string;
  data: {
    metric_alert: {
      id: number;
      title: string;
      alert_rule: { id: number; name: string };
      date_started: string;
      current_trigger: { label: string };
    };
    description_text: string;
    description_title: string;
    web_url: string;
  };
}

const MAX_STACK_FRAMES = 5;

export async function verifySentrySignature(
  body: string,
  signature: string | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!signature || !secret) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return timingSafeEqualHex(signature, toHex(new Uint8Array(signed)));
}

export function normalizeSentrySignal(payload: Record<string, unknown>): NormalizedSentrySignal | null {
  if (isIssueAlertPayload(payload)) {
    const p = payload as unknown as SentryIssueAlertPayload;
    const issue = p.data.issue;
    const isRegression = p.action === "regression" || issue.status === "regressed";
    const eventType = isRegression ? "issue.regression" : "issue.created";
    const triggerKey = isRegression
      ? "sentry_regression:" + issue.id + ":" + issue.lastSeen
      : "sentry_issue:" + issue.id;

    return {
      eventType,
      triggerKey,
      concurrencyKey: "sentry_issue:" + issue.id,
      sentryProject: issue.project.slug,
      sentryLevel: issue.level,
      culpritFile: p.data.event.metadata.filename,
      contextBlock: buildSentryIssueContextBlock(p),
      meta: {
        issueId: issue.id,
        shortId: issue.shortId,
        triggeredRule: p.data.triggered_rule,
      },
    };
  }

  if (isMetricAlertPayload(payload)) {
    const p = payload as unknown as SentryMetricAlertPayload;
    if (p.action !== "critical") {
      return null;
    }

    const alert = p.data.metric_alert;
    return {
      eventType: "metric_alert.critical",
      triggerKey: "sentry_metric:" + alert.alert_rule.id + ":" + alert.date_started,
      concurrencyKey: "sentry_metric:" + alert.alert_rule.id,
      sentryProject: "",
      sentryLevel: "critical",
      contextBlock: buildSentryMetricContextBlock(p),
      meta: {
        alertRuleId: alert.alert_rule.id,
        alertTitle: alert.title,
      },
    };
  }

  return null;
}

export function isAcceptedSentryLevel(level: string, acceptedLevels: string | undefined): boolean {
  const allowed = (acceptedLevels || "error,fatal,critical")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(level.toLowerCase());
}

export function resolveSentryRepositoryRoute(
  signal: Pick<NormalizedSentrySignal, "sentryProject">,
  env: FactoryEnv,
): SentryRepositoryRoute | null {
  const mapRoute = resolveSentryRepositoryRouteFromMap(signal.sentryProject, env.SENTRY_REPO_MAP);
  if (mapRoute) {
    return mapRoute;
  }

  const defaultRepo = env.SENTRY_DEFAULT_REPO?.trim();
  if (!defaultRepo) {
    return null;
  }

  return {
    repo: defaultRepo,
    baseBranch: env.SENTRY_DEFAULT_BASE_BRANCH?.trim() || "main",
  };
}

function resolveSentryRepositoryRouteFromMap(
  sentryProject: string,
  routeMap: string | undefined,
): SentryRepositoryRoute | null {
  const trimmed = routeMap?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseSentryRouteMap(trimmed);
  const route = parsed[sentryProject] ?? parsed["*"] ?? parsed._default;
  return normalizeSentryRoute(route);
}

function parseSentryRouteMap(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeSentryRoute(value: unknown): SentryRepositoryRoute | null {
  if (typeof value === "string") {
    const repo = value.trim();
    return repo ? { repo, baseBranch: "main" } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const route = value as { repo?: unknown; baseBranch?: unknown };
  if (typeof route.repo !== "string" || !route.repo.trim()) {
    return null;
  }

  return {
    repo: route.repo.trim(),
    baseBranch: typeof route.baseBranch === "string" && route.baseBranch.trim() ? route.baseBranch.trim() : "main",
  };
}

function isIssueAlertPayload(payload: Record<string, unknown>): boolean {
  const data = payload.data as Record<string, unknown> | undefined;
  return Boolean(data && "issue" in data && "event" in data);
}

function isMetricAlertPayload(payload: Record<string, unknown>): boolean {
  const data = payload.data as Record<string, unknown> | undefined;
  return Boolean(data && "metric_alert" in data);
}

function buildSentryIssueContextBlock(payload: SentryIssueAlertPayload): string {
  const { event, issue } = payload.data;
  const title =
    event.metadata.type && event.metadata.value
      ? event.metadata.type + ": " + event.metadata.value
      : issue.title;

  const lines = [
    "This factory job was triggered by a Sentry error.",
    "",
    "Error: " + title,
    "Project: " + issue.project.slug,
    "Level: " + issue.level,
    "Issue: " + issue.shortId,
    "First seen: " + issue.firstSeen,
    "Events: " + issue.count,
    "Culprit: " + issue.culprit,
  ];

  const frames = payload.data.event.exception?.values
    ?.at(-1)
    ?.stacktrace?.frames?.slice()
    .reverse()
    .slice(0, MAX_STACK_FRAMES);
  if (frames?.length) {
    lines.push("");
    lines.push("Stack trace:");
    for (const frame of frames) {
      const filename = frame.filename || frame.abs_path || "unknown";
      const fn = frame.function || "?";
      const lineno = frame.lineno ? ":" + frame.lineno : "";
      lines.push("  " + filename + lineno + "  " + fn);
    }
  }

  const tags = payload.data.event.tags;
  if (tags?.length) {
    lines.push("");
    lines.push("Tags: " + tags.map((tag) => tag.key + "=" + tag.value).join(", "));
  }

  return lines.join("\n");
}

function buildSentryMetricContextBlock(payload: SentryMetricAlertPayload): string {
  const alert = payload.data.metric_alert;
  return [
    "This factory job was triggered by a Sentry metric alert.",
    "",
    "Alert: " + alert.title,
    "Trigger: " + alert.current_trigger.label,
    "Started: " + alert.date_started,
    "URL: " + payload.data.web_url,
    "",
    "Description: " + payload.data.description_text,
  ].join("\n");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const normalizedA = a.trim().toLowerCase();
  const normalizedB = b.trim().toLowerCase();
  if (normalizedA.length !== normalizedB.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < normalizedA.length; i++) {
    diff |= normalizedA.charCodeAt(i) ^ normalizedB.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
