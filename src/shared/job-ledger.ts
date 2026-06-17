import type { FactoryEnv } from "./env.js";
import type { FactoryJobInput } from "./factory-types.js";
import type { FactoryAdmissionReceipt } from "./factory-admission.js";

const DEFAULT_JOB_LEDGER_PATH = ".factory-jobs.jsonl";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const PROMPT_PREVIEW_LENGTH = 300;

export type FactoryJobRecordStatus = "submitted" | "accepted";

export interface FactoryJobRecord {
  jobId: string;
  instanceId: string;
  status: FactoryJobRecordStatus;
  agent: "orchestrator";
  source: string;
  promptPreview: string;
  acceptedAt?: string;
  baseBranch?: string;
  dispatchId?: string;
  executionTarget?: "local" | "runner";
  metadata?: Record<string, unknown>;
  receivedAt: string;
  repo?: string;
  signalId?: string;
  streamUrl?: string;
  updatedAt: string;
}

export interface FactoryJobList {
  jobs: FactoryJobRecord[];
}

export async function recordFactoryJobSubmitted(
  env: FactoryEnv,
  input: FactoryJobInput,
): Promise<void> {
  await appendFactoryJobRecord(env, {
    ...recordFromInput(input),
    status: "submitted",
    updatedAt: new Date().toISOString(),
  });
}

export async function recordFactoryJobAccepted(
  env: FactoryEnv,
  input: FactoryJobInput,
  receipt: FactoryAdmissionReceipt,
): Promise<void> {
  await appendFactoryJobRecord(env, {
    ...recordFromInput(input),
    status: "accepted",
    acceptedAt: receipt.acceptedAt,
    agent: receipt.agent,
    dispatchId: receipt.dispatchId,
    executionTarget: receipt.executionTarget,
    instanceId: receipt.instanceId,
    streamUrl: receipt.streamUrl,
    updatedAt: new Date().toISOString(),
  });
}

export async function listFactoryJobRecords(
  env: FactoryEnv,
  options: { limit?: number } = {},
): Promise<FactoryJobList> {
  const records = await readFactoryJobLedger(env);
  const latest = new Map<string, FactoryJobRecord>();

  for (const record of records) {
    latest.set(record.instanceId, record);
  }

  const limit = normalizeLimit(options.limit);
  return {
    jobs: Array.from(latest.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit),
  };
}

export async function getFactoryJobRecord(
  env: FactoryEnv,
  instanceId: string,
): Promise<FactoryJobRecord | null> {
  const records = await readFactoryJobLedger(env);
  let found: FactoryJobRecord | null = null;
  for (const record of records) {
    if (record.instanceId === instanceId || record.jobId === instanceId) {
      found = record;
    }
  }
  return found;
}

async function appendFactoryJobRecord(env: FactoryEnv, record: FactoryJobRecord): Promise<void> {
  const filePath = getLedgerPath(env);
  const fs = await importNodeFs();
  if (!fs) {
    return;
  }

  const { dirname } = await import("node:path");
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", { mode: 0o600 });
}

async function readFactoryJobLedger(env: FactoryEnv): Promise<FactoryJobRecord[]> {
  const filePath = getLedgerPath(env);
  const fs = await importNodeFs();
  if (!fs) {
    return [];
  }

  const text = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const records: FactoryJobRecord[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const record = parseFactoryJobRecord(line);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

function recordFromInput(input: FactoryJobInput): FactoryJobRecord {
  return {
    jobId: input.jobId,
    instanceId: input.jobId,
    status: "submitted",
    agent: "orchestrator",
    source: input.source ?? "manual",
    promptPreview: previewPrompt(input.prompt),
    receivedAt: input.receivedAt,
    updatedAt: input.receivedAt,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.signalId ? { signalId: input.signalId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function parseFactoryJobRecord(line: string): FactoryJobRecord | null {
  try {
    const value = JSON.parse(line) as Partial<FactoryJobRecord>;
    if (
      typeof value.jobId !== "string" ||
      typeof value.instanceId !== "string" ||
      (value.status !== "submitted" && value.status !== "accepted") ||
      value.agent !== "orchestrator" ||
      typeof value.source !== "string" ||
      typeof value.promptPreview !== "string" ||
      typeof value.receivedAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      return null;
    }
    return value as FactoryJobRecord;
  } catch {
    return null;
  }
}

function previewPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > PROMPT_PREVIEW_LENGTH
    ? normalized.slice(0, PROMPT_PREVIEW_LENGTH - 3) + "..."
    : normalized;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
}

function getLedgerPath(env: FactoryEnv): string {
  return env.FACTORY_JOB_LEDGER_PATH?.trim() || DEFAULT_JOB_LEDGER_PATH;
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
