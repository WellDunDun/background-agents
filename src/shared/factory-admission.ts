import { dispatch } from "@flue/runtime";

import orchestrator from "../agents/orchestrator.js";
import { resolveFactoryEnv, type FactoryEnv } from "./env.js";
import type { FactoryJobInput } from "./factory-types.js";

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
  const runnerUrl = normalizeRunnerUrl(runtimeEnv.FACTORY_RUNNER_URL);
  if (runnerUrl) {
    return forwardFactoryJobToRunner(runtimeEnv, runnerUrl, input);
  }

  return dispatchLocalFactoryJob(input);
}

export async function dispatchLocalFactoryJob(input: FactoryJobInput): Promise<FactoryAdmissionReceipt> {
  const receipt = await dispatch(orchestrator, {
    id: input.jobId,
    input,
  });

  return {
    ok: true,
    jobId: input.jobId,
    agent: "orchestrator",
    instanceId: input.jobId,
    dispatchId: receipt.dispatchId,
    acceptedAt: receipt.acceptedAt,
    streamUrl: "/agents/orchestrator/" + encodeURIComponent(input.jobId),
    executionTarget: "local",
  };
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
