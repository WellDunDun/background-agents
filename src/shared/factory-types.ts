export type FactorySignalSource = "manual" | "github" | "sentry" | "linear";

export interface FactoryJobRequest {
  prompt: string;
  repo?: string;
  baseBranch?: string;
  source?: FactorySignalSource;
  signalId?: string;
  metadata?: Record<string, unknown>;
}

export interface FactoryJobInput extends FactoryJobRequest {
  type: "factory.job.requested";
  jobId: string;
  receivedAt: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function parseFactoryJobRequest(value: unknown): ParseResult<FactoryJobRequest> {
  if (!isRecord(value)) {
    return { ok: false, error: "Expected a JSON object." };
  }

  const prompt = stringValue(value.prompt);
  if (!prompt || prompt.trim().length < 3) {
    return { ok: false, error: "Provide a prompt with enough detail for the factory to act." };
  }

  const repo = optionalString(value.repo);
  const baseBranch = optionalString(value.baseBranch);
  const signalId = optionalString(value.signalId);
  const source = optionalSource(value.source);
  if (source === false) {
    return { ok: false, error: "source must be one of manual, github, sentry, or linear." };
  }

  const metadata = value.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    return { ok: false, error: "metadata must be an object when provided." };
  }

  return {
    ok: true,
    value: {
      prompt: prompt.trim(),
      ...(repo ? { repo } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(source ? { source } : { source: "manual" }),
      ...(signalId ? { signalId } : {}),
      ...(isRecord(metadata) ? { metadata } : {}),
    },
  };
}

export function makeFactoryJobInput(jobId: string, request: FactoryJobRequest): FactoryJobInput {
  return {
    type: "factory.job.requested",
    jobId,
    receivedAt: new Date().toISOString(),
    ...request,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalSource(value: unknown): FactorySignalSource | undefined | false {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "manual" || value === "github" || value === "sentry" || value === "linear") {
    return value;
  }
  return false;
}

