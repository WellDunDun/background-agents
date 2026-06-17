import { dispatch } from "@flue/runtime";

import orchestrator from "../agents/orchestrator.js";
import {
  getFactoryAutomation,
  listFactoryAutomations,
  updateFactoryAutomation,
  type FactoryAutomationList,
  type FactoryAutomationPatch,
  type FactoryAutomationSource,
  type FactoryAutomationState,
} from "./automations.js";
import { resolveFactoryEnv, type FactoryEnv } from "./env.js";
import type { FactoryJobInput } from "./factory-types.js";
import {
  canWriteRepository,
  getGitHubAppConfig,
  getInstallationRepository,
  parseRepositorySlug,
} from "./github.js";
import {
  getFactoryGitHubTriggerConfig,
  updateFactoryGitHubTriggerConfig,
  type FactoryGitHubTriggerConfig,
  type FactoryGitHubTriggerPatch,
} from "./github-trigger-config.js";
import {
  getFactorySentryRouteConfig,
  resolveConfiguredSentryRepositoryRoute,
  updateFactorySentryRouteConfig,
  type FactorySentryRouteConfig,
  type FactorySentryRoutePatch,
} from "./sentry-routes.js";
import { resolveSentryRepositoryRoute, type NormalizedSentrySignal, type SentryRepositoryRoute } from "./sentry.js";
import {
  getFactoryJobRecord,
  listFactoryJobRecords,
  recordFactoryJobAccepted,
  recordFactoryJobSubmitted,
  type FactoryJobList,
  type FactoryJobRecord,
} from "./job-ledger.js";
import {
  combineFactoryReadiness,
  getFactoryReadiness,
  runnerReadinessFailureCheck,
  type FactoryReadiness,
} from "./readiness.js";

const DEFAULT_RUNNER_REQUEST_TIMEOUT_MS = 30000;

export interface FactoryAdmissionReceipt {
  ok: true;
  jobId: string;
  agent: "orchestrator";
  instanceId: string;
  dispatchId: string;
  acceptedAt: string;
  streamUrl: string;
  executionTarget: "local" | "runner";
  reused?: boolean;
}

export class FactoryAdmissionError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "FactoryAdmissionError";
    this.status = status;
  }
}

export async function admitFactoryJob(
  env: FactoryEnv,
  input: FactoryJobInput,
): Promise<FactoryAdmissionReceipt> {
  const runtimeEnv = resolveFactoryEnv(env);
  await assertWritableRepositoryAccess(runtimeEnv, input);

  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (runnerUrl) {
    return forwardFactoryJobToRunner(runtimeEnv, runnerUrl, input);
  }

  return dispatchLocalFactoryJob(input, runtimeEnv);
}

async function assertWritableRepositoryAccess(env: FactoryEnv, input: FactoryJobInput): Promise<void> {
  if (!input.repo) {
    return;
  }

  const parsed = parseRepositorySlug(input.repo);
  const repository = await getInstallationRepository(getGitHubAppConfig(env), parsed.owner, parsed.name);
  if (!repository) {
    throw new FactoryAdmissionError(
      "GitHub App installation cannot access " + input.repo + ". Update the installation repository selection.",
      403,
    );
  }

  if (!canWriteRepository(repository)) {
    throw new FactoryAdmissionError(
      "GitHub App installation has no write access to " + input.repo + ". Grant Contents/Pull requests write access and reinstall or update the app installation before starting repo-backed jobs.",
      403,
    );
  }
}

export async function dispatchLocalFactoryJob(
  input: FactoryJobInput,
  env?: FactoryEnv,
): Promise<FactoryAdmissionReceipt> {
  if (env) {
    const existing = await getFactoryJobRecord(env, input.jobId);
    if (existing) {
      const reusable = receiptFromAcceptedRecord(existing);
      if (reusable) {
        return { ...reusable, reused: true };
      }
      throw new FactoryAdmissionError(
        "Factory job " + input.jobId + " is already submitted but not yet accepted.",
        409,
      );
    }

    await recordFactoryJobSubmitted(env, input);
  }

  const receipt = await dispatch(orchestrator, {
    id: input.jobId,
    input,
  });

  const admission: FactoryAdmissionReceipt = {
    ok: true,
    jobId: input.jobId,
    agent: "orchestrator",
    instanceId: input.jobId,
    dispatchId: receipt.dispatchId,
    acceptedAt: receipt.acceptedAt,
    streamUrl: "/agents/orchestrator/" + encodeURIComponent(input.jobId),
    executionTarget: "local",
  };

  if (env) {
    await recordFactoryJobAccepted(env, input, admission).catch(() => undefined);
  }

  return admission;
}

export async function readFactoryJobList(env: FactoryEnv, limit?: number): Promise<FactoryJobList> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return listFactoryJobRecords(runtimeEnv, { limit });
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const url = new URL(runnerUrl + "/api/runner/jobs");
  if (limit !== undefined) {
    url.searchParams.set("limit", String(limit));
  }

  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + runnerToken },
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected job list request: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerJobList(body);
}

export async function readFactoryJobRecord(
  env: FactoryEnv,
  instanceId: string,
): Promise<FactoryJobRecord | null> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return getFactoryJobRecord(runtimeEnv, instanceId);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/jobs/" + encodeURIComponent(instanceId), {
    headers: { Authorization: "Bearer " + runnerToken },
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected job detail request: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerJobRecord(body);
}

export async function readFactoryAutomationList(env: FactoryEnv): Promise<FactoryAutomationList> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return listFactoryAutomations(runtimeEnv);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/automations", {
    headers: { Authorization: "Bearer " + runnerToken },
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected automation list request: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerAutomationList(body);
}

export async function updateFactoryAutomationState(
  env: FactoryEnv,
  source: FactoryAutomationSource,
  patch: FactoryAutomationPatch,
): Promise<FactoryAutomationState> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return updateFactoryAutomation(runtimeEnv, source, patch);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/automations/" + encodeURIComponent(source), {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + runnerToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected automation update request: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerAutomationState(body);
}

export async function isFactoryAutomationActive(
  env: FactoryEnv,
  source: FactoryAutomationSource,
): Promise<boolean> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return (await getFactoryAutomation(runtimeEnv, source)).enabled;
  }

  const list = await readFactoryAutomationList(runtimeEnv);
  return list.automations.find((automation) => automation.source === source)?.enabled ?? true;
}

export async function readFactoryGitHubTriggerConfig(env: FactoryEnv): Promise<FactoryGitHubTriggerConfig> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return getFactoryGitHubTriggerConfig(runtimeEnv);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/integrations/github/config", {
    headers: { Authorization: "Bearer " + runnerToken },
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected GitHub trigger config request: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerGitHubTriggerConfig(body);
}

export async function updateFactoryGitHubTriggerSettings(
  env: FactoryEnv,
  patch: FactoryGitHubTriggerPatch,
): Promise<FactoryGitHubTriggerConfig> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return updateFactoryGitHubTriggerConfig(runtimeEnv, patch);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/integrations/github/config", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + runnerToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected GitHub trigger config update: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerGitHubTriggerConfig(body);
}

export async function readFactorySentryRouteConfig(env: FactoryEnv): Promise<FactorySentryRouteConfig> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return getFactorySentryRouteConfig(runtimeEnv);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/integrations/sentry/routes", {
    headers: { Authorization: "Bearer " + runnerToken },
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected Sentry route config request: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerSentryRouteConfig(body);
}

export async function updateFactorySentryRoutes(
  env: FactoryEnv,
  patch: FactorySentryRoutePatch,
): Promise<FactorySentryRouteConfig> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return updateFactorySentryRouteConfig(runtimeEnv, patch);
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const response = await fetch(runnerUrl + "/api/runner/integrations/sentry/routes", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + runnerToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected Sentry route config update: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  return normalizeRunnerSentryRouteConfig(body);
}

export async function resolveFactorySentryRepositoryRoute(
  env: FactoryEnv,
  signal: Pick<NormalizedSentrySignal, "sentryProject">,
): Promise<SentryRepositoryRoute | null> {
  const runtimeEnv = resolveFactoryEnv(env);
  const configured = resolveConfiguredSentryRepositoryRoute(signal, await readFactorySentryRouteConfig(runtimeEnv));
  return configured ?? resolveSentryRepositoryRoute(signal, runtimeEnv);
}

export async function readFactoryReadiness(env: FactoryEnv): Promise<FactoryReadiness> {
  const runtimeEnv = resolveFactoryEnv(env);
  const workerReadiness = await getFactoryReadiness(runtimeEnv, { runtime: "worker" });
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return workerReadiness;
  }

  try {
    const runnerToken = requireRunnerToken(runtimeEnv);
    const response = await fetch(runnerUrl + "/api/runner/readiness", {
      headers: { Authorization: "Bearer " + runnerToken },
      signal: AbortSignal.timeout(numberFromEnv(runtimeEnv.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new FactoryAdmissionError(
        "Factory runner rejected readiness request: " + response.status + " " + describeRunnerError(body),
        response.status >= 500 ? 502 : response.status,
      );
    }
    return combineFactoryReadiness(workerReadiness, normalizeRunnerReadiness(body));
  } catch (error) {
    return combineFactoryReadiness(workerReadiness, runnerFailureReadiness(workerReadiness, error));
  }
}

export async function proxyRunnerAgentEvents(
  env: FactoryEnv,
  instanceId: string,
  request: Request,
): Promise<Response> {
  const runtimeEnv = resolveFactoryEnv(env);
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (!runnerUrl) {
    return Response.json(
      {
        error: "FACTORY_RUNNER_URL is not configured. Read the local Flue stream directly.",
        streamUrl: "/agents/orchestrator/" + encodeURIComponent(instanceId),
      },
      { status: 503 },
    );
  }

  const runnerToken = requireRunnerToken(runtimeEnv);
  const inboundUrl = new URL(request.url);
  const runnerStreamUrl = new URL(runnerUrl + "/agents/orchestrator/" + encodeURIComponent(instanceId));
  runnerStreamUrl.search = inboundUrl.search;

  const headers = new Headers();
  headers.set("Authorization", "Bearer " + runnerToken);
  const accept = request.headers.get("Accept");
  if (accept) {
    headers.set("Accept", accept);
  }

  const upstream = await fetch(runnerStreamUrl, { headers });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyStreamingHeaders(upstream.headers),
  });
}

function normalizeRunnerUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/g, "");
}

async function forwardFactoryJobToRunner(
  env: FactoryEnv,
  runnerUrl: string,
  input: FactoryJobInput,
): Promise<FactoryAdmissionReceipt> {
  const runnerToken = requireRunnerToken(env);
  const timeoutMs = numberFromEnv(env.FACTORY_RUNNER_REQUEST_TIMEOUT_MS) ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS;
  const response = await fetch(runnerUrl + "/api/runner/jobs", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + runnerToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new FactoryAdmissionError(
      "Factory runner rejected the job: " + response.status + " " + describeRunnerError(body),
      response.status >= 500 ? 502 : response.status,
    );
  }

  const receipt = parseRunnerReceipt(body);
  if (!receipt) {
    throw new FactoryAdmissionError("Factory runner returned an invalid admission receipt.");
  }

  return {
    ...receipt,
    streamUrl: "/api/jobs/" + encodeURIComponent(receipt.instanceId) + "/events",
    executionTarget: "runner",
  };
}

function requireRunnerToken(env: FactoryEnv): string {
  const token = env.FACTORY_RUNNER_TOKEN?.trim();
  if (!token) {
    throw new FactoryAdmissionError("FACTORY_RUNNER_TOKEN is not configured.", 503);
  }
  return token;
}

function parseRunnerReceipt(value: unknown): Omit<FactoryAdmissionReceipt, "executionTarget"> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.ok !== true ||
    value.agent !== "orchestrator" ||
    typeof value.jobId !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.dispatchId !== "string" ||
    typeof value.acceptedAt !== "string" ||
    typeof value.streamUrl !== "string"
  ) {
    return undefined;
  }

  return {
    ok: true,
    jobId: value.jobId,
    agent: "orchestrator",
    instanceId: value.instanceId,
    dispatchId: value.dispatchId,
    acceptedAt: value.acceptedAt,
    streamUrl: value.streamUrl,
    ...(value.reused === true ? { reused: true } : {}),
  };
}

function receiptFromAcceptedRecord(record: FactoryJobRecord): FactoryAdmissionReceipt | null {
  if (
    record.status !== "accepted" ||
    record.agent !== "orchestrator" ||
    !record.dispatchId ||
    !record.acceptedAt ||
    !record.streamUrl ||
    !record.executionTarget
  ) {
    return null;
  }

  return {
    ok: true,
    jobId: record.jobId,
    agent: record.agent,
    instanceId: record.instanceId,
    dispatchId: record.dispatchId,
    acceptedAt: record.acceptedAt,
    streamUrl: record.streamUrl,
    executionTarget: record.executionTarget,
  };
}

function normalizeRunnerJobList(value: unknown): FactoryJobList {
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    throw new FactoryAdmissionError("Factory runner returned an invalid job list.");
  }

  return {
    jobs: value.jobs.map((job) => normalizeRunnerJobRecord(job)),
  };
}

function normalizeRunnerJobRecord(value: unknown): FactoryJobRecord {
  if (!isRecord(value) || typeof value.instanceId !== "string") {
    throw new FactoryAdmissionError("Factory runner returned an invalid job record.");
  }

  const record = value as unknown as FactoryJobRecord;
  return {
    ...record,
    executionTarget: "runner",
    streamUrl: "/api/jobs/" + encodeURIComponent(record.instanceId) + "/events",
  };
}

function normalizeRunnerAutomationList(value: unknown): FactoryAutomationList {
  if (!isRecord(value) || !Array.isArray(value.automations)) {
    throw new FactoryAdmissionError("Factory runner returned an invalid automation list.");
  }

  return {
    automations: value.automations.map((automation) => normalizeRunnerAutomationState(automation)),
  };
}

function normalizeRunnerAutomationState(value: unknown): FactoryAutomationState {
  if (
    !isRecord(value) ||
    (value.source !== "github" && value.source !== "sentry") ||
    typeof value.enabled !== "boolean" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new FactoryAdmissionError("Factory runner returned an invalid automation state.");
  }

  return {
    source: value.source,
    enabled: value.enabled,
    updatedAt: value.updatedAt,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function normalizeRunnerGitHubTriggerConfig(value: unknown): FactoryGitHubTriggerConfig {
  if (!isRecord(value) || typeof value.triggerPhrase !== "string" || typeof value.updatedAt !== "string") {
    throw new FactoryAdmissionError("Factory runner returned an invalid GitHub trigger config.");
  }

  return {
    triggerPhrase: value.triggerPhrase,
    updatedAt: value.updatedAt,
    ...(typeof value.botUsername === "string" ? { botUsername: value.botUsername } : {}),
  };
}

function normalizeRunnerSentryRouteConfig(value: unknown): FactorySentryRouteConfig {
  if (!isRecord(value) || !isRecord(value.routes) || typeof value.updatedAt !== "string") {
    throw new FactoryAdmissionError("Factory runner returned an invalid Sentry route config.");
  }

  const routes: Record<string, SentryRepositoryRoute> = {};
  for (const [project, route] of Object.entries(value.routes)) {
    if (isSentryRoute(route)) {
      routes[project] = route;
    }
  }

  return {
    routes,
    ...(isSentryRoute(value.defaultRoute) ? { defaultRoute: value.defaultRoute } : {}),
    updatedAt: value.updatedAt,
  };
}

function isSentryRoute(value: unknown): value is SentryRepositoryRoute {
  return isRecord(value) && typeof value.repo === "string" && typeof value.baseBranch === "string";
}

function normalizeRunnerReadiness(value: unknown): FactoryReadiness {
  if (!isRecord(value) || !Array.isArray(value.checks) || typeof value.ok !== "boolean") {
    throw new FactoryAdmissionError("Factory runner returned an invalid readiness response.");
  }

  return value as unknown as FactoryReadiness;
}

function runnerFailureReadiness(workerReadiness: FactoryReadiness, error: unknown): FactoryReadiness {
  const check = runnerReadinessFailureCheck(error);
  return {
    ok: false,
    runtime: "runner",
    state: "blocked",
    model: workerReadiness.model,
    checks: [check],
    summary: {
      blocked: 1,
      warnings: 0,
    },
    github: {
      configured: false,
      repositoryCount: 0,
      writableRepositoryCount: 0,
    },
    sentry: {
      webhookConfigured: false,
      routeConfigured: false,
    },
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function describeRunnerError(body: unknown): string {
  if (isRecord(body) && typeof body.error === "string") {
    return body.error;
  }
  return "unexpected runner response";
}

function copyStreamingHeaders(headers: Headers): Headers {
  const copied = new Headers();
  for (const name of ["content-type", "cache-control", "stream-next-offset"]) {
    const value = headers.get(name);
    if (value) {
      copied.set(name, value);
    }
  }
  return copied;
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
