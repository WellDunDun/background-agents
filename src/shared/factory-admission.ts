import { dispatch } from "@flue/runtime";

import orchestrator from "../agents/orchestrator.js";
import { resolveFactoryEnv, type FactoryEnv } from "./env.js";
import type { FactoryJobInput } from "./factory-types.js";
import {
  canWriteRepository,
  getGitHubAppConfig,
  getInstallationRepository,
  parseRepositorySlug,
} from "./github.js";
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
