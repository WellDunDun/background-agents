#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_WORKER_URL = "https://flue-factory.danielhabibiofficial.workers.dev";
const DEFAULT_TIMEOUT_MS = 120000;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = { ...readDevVars(resolve(process.cwd(), ".dev.vars")), ...process.env };
  const workerUrl = normalizeUrl(options.workerUrl || env.FACTORY_WORKER_URL || DEFAULT_WORKER_URL);
  const apiToken = requireValue(env.FACTORY_API_TOKEN, "FACTORY_API_TOKEN");

  const health = await readJson(workerUrl + "/health");
  assertStatus("health", health.status, 200);

  const config = await readJson(workerUrl + "/api/config/status", {
    headers: authHeaders(apiToken),
  });
  assertStatus("config", config.status, 200);

  const readiness = await readJson(workerUrl + "/api/readiness", {
    headers: authHeaders(apiToken),
  });
  assertStatus("readiness", readiness.status, 200);

  const automations = await runAutomationSmoke(workerUrl, apiToken);

  const repositories = await readJson(workerUrl + "/api/github/repositories", {
    headers: authHeaders(apiToken),
  });
  assertStatus("repositories", repositories.status, 200);
  const repoList = Array.isArray(repositories.body.repositories) ? repositories.body.repositories : [];
  const writableRepos = repoList.filter((repo) => repo && repo.writable === true);

  const agentSmoke = options.skipAgent
    ? { skipped: true }
    : await runNoRepoAgentSmoke(workerUrl, apiToken, options.timeoutMs || DEFAULT_TIMEOUT_MS);

  const jobLedger = await readJobLedgerSmoke(workerUrl, apiToken, agentSmoke);

  const readOnlyGuard = await runReadOnlyGuardSmoke(workerUrl, apiToken, repoList);

  console.log(
    JSON.stringify(
      {
        ok: true,
        workerUrl,
        health: { status: health.status, body: health.body },
        config: summarizeConfig(config.body),
        repositories: {
          count: repoList.length,
          writableCount: writableRepos.length,
          names: repoList.map((repo) => ({
            fullName: repo.fullName,
            writable: repo.writable,
            defaultBranch: repo.defaultBranch,
          })),
        },
        readiness: summarizeReadiness(readiness.body),
        automations,
        agentSmoke,
        jobLedger,
        readOnlyGuard,
      },
      null,
      2,
    ),
  );
}

async function readJobLedgerSmoke(workerUrl, apiToken, agentSmoke) {
  const list = await readJson(workerUrl + "/api/jobs?limit=10", {
    headers: authHeaders(apiToken),
  });
  assertStatus("job list", list.status, 200);

  const jobs = Array.isArray(list.body.jobs) ? list.body.jobs : [];
  const targetInstanceId = agentSmoke && !agentSmoke.skipped ? agentSmoke.instanceId : undefined;
  const listedSmokeJob = targetInstanceId
    ? jobs.some((job) => job && job.instanceId === targetInstanceId)
    : undefined;
  let detail;

  if (targetInstanceId) {
    detail = await readJson(workerUrl + "/api/jobs/" + encodeURIComponent(targetInstanceId), {
      headers: authHeaders(apiToken),
    });
    assertStatus("job detail", detail.status, 200);
  }

  return {
    count: jobs.length,
    listedSmokeJob,
    detailStatus: detail?.status,
  };
}

async function runAutomationSmoke(workerUrl, apiToken) {
  const list = await readJson(workerUrl + "/api/automations", {
    headers: authHeaders(apiToken),
  });
  assertStatus("automation list", list.status, 200);
  const automations = Array.isArray(list.body.automations) ? list.body.automations : [];
  const sentry = automations.find((automation) => automation && automation.source === "sentry");
  const originalEnabled = sentry?.enabled !== false;
  const originalReason = typeof sentry?.reason === "string" ? sentry.reason : "";

  const paused = await patchAutomation(workerUrl, apiToken, "sentry", {
    enabled: false,
    reason: "production smoke pause/restore check",
  });
  if (paused.body?.enabled !== false) {
    throw new Error("Sentry automation pause did not persist: " + JSON.stringify(paused.body));
  }

  const restored = await patchAutomation(workerUrl, apiToken, "sentry", {
    enabled: originalEnabled,
    reason: originalReason,
  });
  if (restored.body?.enabled !== originalEnabled) {
    throw new Error("Sentry automation restore did not persist: " + JSON.stringify(restored.body));
  }

  return {
    count: automations.length,
    sentryPausedStatus: paused.status,
    sentryRestoredStatus: restored.status,
    sentryRestoredEnabled: restored.body.enabled,
  };
}

async function patchAutomation(workerUrl, apiToken, source, patch) {
  const response = await readJson(workerUrl + "/api/automations/" + encodeURIComponent(source), {
    method: "PATCH",
    headers: {
      ...authHeaders(apiToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  assertStatus(source + " automation patch", response.status, 200);
  return response;
}

function parseArgs(args) {
  const options = {
    skipAgent: false,
    timeoutMs: undefined,
    workerUrl: undefined,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--skip-agent") {
      options.skipAgent = true;
    } else if (arg === "--worker-url") {
      options.workerUrl = requireArg(args, ++index, arg);
    } else if (arg === "--timeout-ms") {
      const parsed = Number(requireArg(args, ++index, arg));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms must be a positive number.");
      }
      options.timeoutMs = parsed;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  return options;
}

function printHelp() {
  console.log("Usage: npm run smoke:production -- [--worker-url <url>] [--skip-agent] [--timeout-ms <ms>]");
}

function requireArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(flag + " requires a value.");
  }
  return value;
}

function readDevVars(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const env = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function readJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function runNoRepoAgentSmoke(workerUrl, apiToken, timeoutMs) {
  const idempotencyKey = "smoke-" + crypto.randomUUID();
  const body = JSON.stringify({
    prompt:
      "Production smoke test. Do not edit files or call GitHub. Reply with one concise sentence confirming the factory still runs through Codex.",
    source: "manual",
    metadata: { smoke: true, purpose: "scripted-production-smoke" },
  });
  const admitted = await readJson(workerUrl + "/api/jobs", {
    method: "POST",
    headers: {
      ...authHeaders(apiToken),
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body,
  });
  assertStatus("agent admission", admitted.status, 202);

  const receipt = admitted.body;
  const streamResult = await readAgentStream(
    workerUrl + receipt.streamUrl + "?offset=-1&live=sse",
    apiToken,
    timeoutMs,
  );
  if (!streamResult.sawCodex || !streamResult.sawAgentEnd || streamResult.sawProviderError) {
    throw new Error("Agent smoke did not complete cleanly: " + JSON.stringify(streamResult));
  }

  const duplicate = await readJson(workerUrl + "/api/jobs", {
    method: "POST",
    headers: {
      ...authHeaders(apiToken),
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body,
  });
  assertStatus("duplicate agent admission", duplicate.status, 202);
  if (duplicate.body?.instanceId !== receipt.instanceId || duplicate.body?.reused !== true) {
    throw new Error("Duplicate admission did not reuse the original job: " + JSON.stringify(duplicate.body));
  }

  return {
    admitted: true,
    executionTarget: receipt.executionTarget,
    instanceId: receipt.instanceId,
    idempotency: {
      key: idempotencyKey,
      duplicateStatus: duplicate.status,
      duplicateReused: duplicate.body.reused === true,
    },
    ...streamResult,
  };
}

async function readAgentStream(url, apiToken, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("stream timeout")), timeoutMs);
  const response = await fetch(url, {
    headers: { ...authHeaders(apiToken), Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    throw new Error("Stream request failed: " + response.status + " " + (await response.text()));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let events = 0;
  let sawCodex = false;
  let sawAgentEnd = false;
  let sawProviderError = false;
  let textPreview = "";

  try {
    while (!sawAgentEnd && !sawProviderError) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const result = consumeSseChunk(buffer + decoder.decode(value, { stream: true }));
      buffer = result.buffer;
      events += result.events;
      sawCodex = sawCodex || result.sawCodex;
      sawAgentEnd = sawAgentEnd || result.sawAgentEnd;
      sawProviderError = sawProviderError || result.sawProviderError;
      if (!textPreview && result.textPreview) {
        textPreview = result.textPreview;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }

  return {
    events,
    sawCodex,
    sawAgentEnd,
    sawProviderError,
    textPreview: textPreview.slice(0, 220),
  };
}

function consumeSseChunk(text) {
  const frames = text.split(/\n\n/);
  const buffer = frames.pop() || "";
  let events = 0;
  let sawCodex = false;
  let sawAgentEnd = false;
  let sawProviderError = false;
  let textPreview = "";

  for (const frame of frames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      continue;
    }

    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      events += 1;
      const flat = JSON.stringify(event);
      sawCodex = sawCodex || flat.includes("openai-codex") || flat.includes("gpt-5.5");
      sawProviderError =
        sawProviderError ||
        /refresh_token_reused|authentication token|OpenAI Codex token refresh failed|Cloudflare block|blocked by Cloudflare|invalid_request_error/i.test(
          flat,
        );
      sawAgentEnd = sawAgentEnd || event?.type === "agent_end" || event?.type === "idle";
      textPreview = textPreview || extractEventText(event);
    }
  }

  return { buffer, events, sawCodex, sawAgentEnd, sawProviderError, textPreview };
}

function extractEventText(event) {
  if (typeof event?.text === "string") {
    return event.text;
  }
  const message = event?.message;
  if (message && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type !== "thinking" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return "";
}

async function runReadOnlyGuardSmoke(workerUrl, apiToken, repositories) {
  const readOnlyRepo = repositories.find((repo) => repo && repo.fullName && repo.writable === false);
  if (!readOnlyRepo) {
    return { skipped: true, reason: "no_read_only_repo" };
  }

  const response = await readJson(workerUrl + "/api/jobs", {
    method: "POST",
    headers: {
      ...authHeaders(apiToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: "Permission guard smoke. Do not run any repo work.",
      repo: readOnlyRepo.fullName,
      baseBranch: readOnlyRepo.defaultBranch || "main",
      source: "manual",
      metadata: { smoke: true, purpose: "read-only-repo-admission-guard" },
    }),
  });

  if (response.status !== 403) {
    throw new Error("Expected read-only repo guard to return 403, got " + response.status);
  }

  return {
    repo: readOnlyRepo.fullName,
    status: response.status,
    rejected: true,
  };
}

function summarizeConfig(config) {
  return {
    model: config?.model,
    runner: config?.runner,
    github: config?.github,
    sentry: config?.sentry,
  };
}

function summarizeReadiness(readiness) {
  const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
  return {
    ok: readiness?.ok,
    state: readiness?.state,
    summary: readiness?.summary,
    blockedChecks: checks
      .filter((check) => check && check.status === "block")
      .map((check) => check.id),
    warningChecks: checks
      .filter((check) => check && check.status === "warn")
      .map((check) => check.id),
  };
}

function authHeaders(token) {
  return { Authorization: "Bearer " + token };
}

function assertStatus(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(label + " returned " + actual + ", expected " + expected + ".");
  }
}

function normalizeUrl(value) {
  return String(value).replace(/\/+$/g, "");
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(name + " is required.");
  }
  return value;
}
