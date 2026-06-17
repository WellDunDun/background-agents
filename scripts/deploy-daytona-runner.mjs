#!/usr/bin/env node
import { Daytona } from "@daytona/sdk";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const DEFAULT_SANDBOX_NAME = "signal-factory-runner";
const DEFAULT_APP_DIR = "/home/daytona/signal-factory-runner";
const DEFAULT_PORT = 3584;
const DEFAULT_RUNNER_CPU = 2;
const DEFAULT_RUNNER_DISK_GIB = 10;
const DEFAULT_RUNNER_IMAGE = "node:22-bookworm";
const DEFAULT_RUNNER_MEMORY_GIB = 4;
const SESSION_ID = "signal-factory-runner";
const REQUIRED_RUNNER_ENV_KEYS = [
  "FACTORY_RUNNER_TOKEN",
  "DAYTONA_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
];
const OPTIONAL_RUNNER_ENV_KEYS = [
  "FACTORY_DEFAULT_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_ACCESS_TOKEN",
  "OPENAI_CODEX_REFRESH_TOKEN",
  "FACTORY_CODEX_CREDENTIALS_PATH",
  "FACTORY_JOB_LEDGER_PATH",
  "FACTORY_AUTOMATION_STATE_PATH",
  "FACTORY_SENTRY_ROUTE_CONFIG_PATH",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DAYTONA_IMAGE",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_CREATE_TIMEOUT_SECONDS",
  "DAYTONA_AUTO_STOP_MINUTES",
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_DELETE_MINUTES",
  "FACTORY_GIT_AUTHOR_NAME",
  "FACTORY_GIT_AUTHOR_EMAIL",
  "FACTORY_WORKSPACE_PROVIDER",
  "FACTORY_RUNNER_WORKSPACE_ROOT",
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = { ...readDevVars(path.join(projectRoot, ".dev.vars")), ...process.env };
  const runnerEnv = buildRunnerEnv(env);
  const sandboxName = options.sandboxName ?? env.FACTORY_RUNNER_SANDBOX_NAME ?? DEFAULT_SANDBOX_NAME;
  const appDir = options.appDir ?? env.FACTORY_RUNNER_APP_DIR ?? DEFAULT_APP_DIR;
  const port = numberFrom(options.port ?? env.FACTORY_RUNNER_PORT) ?? DEFAULT_PORT;

  const daytona = new Daytona({
    apiKey: requireValue(env.DAYTONA_API_KEY, "DAYTONA_API_KEY"),
    ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
    ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}),
  });

  const sandbox = await step("get or create Daytona sandbox", () =>
    getOrCreateSandbox(daytona, sandboxName, options.recreate, env),
  );
  await step("ensure sandbox is started", () => ensureStarted(sandbox));
  await step("upload committed source archive", () => deploySourceArchive(sandbox, appDir));
  await step("write private runner environment", () => writeRunnerEnv(sandbox, appDir, runnerEnv));
  await step("install runner dependencies", () => runOrThrow(sandbox, "npm ci", appDir, 900));
  await step("build Node runner", () => runOrThrow(sandbox, "npm run build:node", appDir, 300));
  await step("restart runner session", () => restartRunnerSession(sandbox, appDir, port));

  const preview = await step("create runner preview link", () => sandbox.getPreviewLink(port));
  const runnerUrl = normalizeUrl(preview.url);
  await step("wait for runner health", () => waitForHealth(runnerUrl));

  if (options.configureWorker) {
    await step("configure Worker runner URL secret", () => putWorkerSecret("FACTORY_RUNNER_URL", runnerUrl));
    await step("configure Worker runner token secret", () =>
      putWorkerSecret("FACTORY_RUNNER_TOKEN", requireValue(env.FACTORY_RUNNER_TOKEN, "FACTORY_RUNNER_TOKEN")),
    );
  }

  console.log(JSON.stringify(
    {
      ok: true,
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      runnerUrl,
      workerConfigured: options.configureWorker,
    },
    null,
    2,
  ));
}

async function step(label, fn) {
  const startedAt = Date.now();
  process.stderr.write("[runner-deploy] " + label + "...\n");
  try {
    const result = await fn();
    process.stderr.write("[runner-deploy] " + label + " done in " + (Date.now() - startedAt) + "ms\n");
    return result;
  } catch (error) {
    process.stderr.write("[runner-deploy] " + label + " failed after " + (Date.now() - startedAt) + "ms\n");
    throw error;
  }
}

function parseArgs(args) {
  const options = {
    appDir: undefined,
    configureWorker: false,
    port: undefined,
    recreate: false,
    sandboxName: undefined,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--configure-worker") {
      options.configureWorker = true;
    } else if (arg === "--recreate") {
      options.recreate = true;
    } else if (arg === "--sandbox-name") {
      options.sandboxName = requireArgValue(args, ++index, arg);
    } else if (arg === "--app-dir") {
      options.appDir = requireArgValue(args, ++index, arg);
    } else if (arg === "--port") {
      options.port = requireArgValue(args, ++index, arg);
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
  console.log(`Usage: npm run runner:deploy:daytona -- [options]

Options:
  --configure-worker       Write FACTORY_RUNNER_URL and FACTORY_RUNNER_TOKEN with wrangler secret put.
  --recreate               Delete and recreate the Daytona runner sandbox before deploying.
  --sandbox-name <name>    Daytona sandbox name. Defaults to signal-factory-runner.
  --app-dir <path>         Absolute app directory in the sandbox.
  --port <port>            Runner port. Defaults to 3584.
`);
}

function requireArgValue(args, index, flag) {
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
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    env[key] = unwrapEnvValue(rawValue);
  }
  return env;
}

function unwrapEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function buildRunnerEnv(env) {
  const missing = REQUIRED_RUNNER_ENV_KEYS.filter((key) => !env[key]);
  const hasCodexToken = Boolean(env.OPENAI_CODEX_ACCESS_TOKEN || env.OPENAI_CODEX_REFRESH_TOKEN);
  const model = env.FACTORY_DEFAULT_MODEL || "openai-codex/gpt-5.5";
  if (model.startsWith("openai-codex/") && !hasCodexToken) {
    missing.push("OPENAI_CODEX_REFRESH_TOKEN or OPENAI_CODEX_ACCESS_TOKEN");
  }

  if (missing.length > 0) {
    throw new Error("Missing required runner env: " + missing.join(", "));
  }

  const runnerEnv = {
    FACTORY_DEFAULT_MODEL: model,
    FACTORY_JOB_LEDGER_PATH: env.FACTORY_JOB_LEDGER_PATH || "/home/daytona/signal-factory-runner-data/jobs.jsonl",
    FACTORY_AUTOMATION_STATE_PATH: env.FACTORY_AUTOMATION_STATE_PATH || "/home/daytona/signal-factory-runner-data/automations.json",
    FACTORY_SENTRY_ROUTE_CONFIG_PATH: env.FACTORY_SENTRY_ROUTE_CONFIG_PATH || "/home/daytona/signal-factory-runner-data/sentry-routes.json",
    FACTORY_WORKSPACE_PROVIDER: "runner",
    FACTORY_RUNNER_WORKSPACE_ROOT: env.FACTORY_RUNNER_WORKSPACE_ROOT || "/tmp/signal-factory-jobs",
    FACTORY_CODEX_CREDENTIALS_PATH: env.FACTORY_CODEX_CREDENTIALS_PATH || ".runner.env",
  };

  for (const key of [...REQUIRED_RUNNER_ENV_KEYS, ...OPTIONAL_RUNNER_ENV_KEYS]) {
    if (env[key]) {
      runnerEnv[key] = env[key];
    }
  }

  return runnerEnv;
}

async function getOrCreateSandbox(daytona, sandboxName, recreate, env) {
  let existing;
  const cpu = numberFrom(env.FACTORY_RUNNER_CPU) ?? DEFAULT_RUNNER_CPU;
  const memory = numberFrom(env.FACTORY_RUNNER_MEMORY_GIB) ?? DEFAULT_RUNNER_MEMORY_GIB;
  const disk = numberFrom(env.FACTORY_RUNNER_DISK_GIB) ?? DEFAULT_RUNNER_DISK_GIB;
  try {
    existing = await daytona.get(sandboxName);
  } catch {
    existing = undefined;
  }

  const undersized =
    existing && ((existing.cpu ?? 0) < cpu || (existing.memory ?? 0) < memory || (existing.disk ?? 0) < disk);

  if (existing && (recreate || undersized)) {
    await existing.delete(120);
    existing = undefined;
  }

  if (existing) {
    return existing;
  }

  return daytona.create(
    {
      name: sandboxName,
      image: env.FACTORY_RUNNER_IMAGE || DEFAULT_RUNNER_IMAGE,
      public: true,
      labels: {
        app: "signal-factory",
        role: "runner",
      },
      autoStopInterval: 0,
      autoArchiveInterval: 0,
      autoDeleteInterval: -1,
      resources: {
        cpu,
        disk,
        memory,
      },
    },
    { timeout: 180 },
  );
}

async function ensureStarted(sandbox) {
  if (sandbox.state !== "started") {
    await sandbox.start(180);
  }
}

async function deploySourceArchive(sandbox, appDir) {
  const archivePath = createGitArchive();
  const remoteArchivePath = "/tmp/signal-factory-runner-source.tar";

  try {
    await sandbox.process.executeCommand("rm -rf " + shellQuote(appDir) + " && mkdir -p " + shellQuote(appDir));
    await sandbox.fs.uploadFile(archivePath, remoteArchivePath, 300);
    await runOrThrow(
      sandbox,
      "tar -xf " + shellQuote(remoteArchivePath) + " -C " + shellQuote(appDir) + " && rm -f " + shellQuote(remoteArchivePath),
      undefined,
      120,
    );
  } finally {
    rmSync(archivePath, { force: true });
  }
}

function createGitArchive() {
  const dir = mkdtempSync(path.join(tmpdir(), "signal-factory-runner-"));
  const archivePath = path.join(dir, "source.tar");
  const result = spawnSync("git", ["archive", "--format=tar", "HEAD", "-o", archivePath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("git archive failed: " + (result.stderr || result.stdout));
  }
  return archivePath;
}

async function writeRunnerEnv(sandbox, appDir, runnerEnv) {
  const dir = mkdtempSync(path.join(tmpdir(), "signal-factory-runner-env-"));
  const localEnvPath = path.join(dir, "runner.env");
  const remoteEnvPath = appDir.replace(/\/+$/g, "") + "/.runner.env";
  writeFileSync(localEnvPath, toShellEnvFile(runnerEnv), { mode: 0o600 });

  try {
    await sandbox.fs.uploadFile(localEnvPath, remoteEnvPath, 60);
    await runOrThrow(sandbox, "chmod 600 " + shellQuote(remoteEnvPath), undefined, 30);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function toShellEnvFile(values) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + shellQuote(String(value)))
    .join("\n") + "\n";
}

async function restartRunnerSession(sandbox, appDir, port) {
  const sessions = await sandbox.process.listSessions().catch(() => []);
  if (sessions.some((session) => session.sessionId === SESSION_ID)) {
    await sandbox.process.deleteSession(SESSION_ID).catch(() => undefined);
  }

  await sandbox.process.createSession(SESSION_ID);
  const command = [
    "cd " + shellQuote(appDir),
    "set -a",
    ". ./.runner.env",
    "set +a",
    "PORT=" + Number(port) + " npm run start:node",
  ].join(" && ");

  const response = await sandbox.process.executeSessionCommand(
    SESSION_ID,
    {
      command,
      runAsync: true,
      suppressInputEcho: true,
    },
    30,
  );

  if (!response.cmdId) {
    throw new Error("Runner process did not return a command id.");
  }
}

async function waitForHealth(runnerUrl) {
  const healthUrl = normalizeUrl(runnerUrl) + "/health";
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return;
      }
      lastError = response.status + " " + await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1500);
  }

  throw new Error("Runner health check failed at " + healthUrl + ": " + lastError);
}

async function putWorkerSecret(name, value) {
  const wranglerConfig = path.join(projectRoot, "dist", "flue_factory", "wrangler.json");
  if (!existsSync(wranglerConfig)) {
    await runLocal("npm", ["run", "build:cloudflare"]);
  }

  const wranglerBin = path.join(projectRoot, "node_modules", ".bin", "wrangler");
  await runLocal(wranglerBin, ["secret", "put", name, "--config", wranglerConfig], value + "\n");
}

async function runLocal(command, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(command + " " + args.join(" ") + " exited with " + code));
      }
    });
  });
}

async function runOrThrow(sandbox, command, cwd, timeout) {
  const result = await sandbox.process.executeCommand(command, cwd, undefined, timeout);
  if (result.exitCode !== 0) {
    throw new Error(
      "Command failed in runner sandbox with exit code " +
        result.exitCode +
        ": " +
        command +
        "\n" +
        String(result.result ?? result.artifacts?.stdout ?? ""),
    );
  }
  return result;
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(name + " is required.");
  }
  return value;
}

function numberFrom(value) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeUrl(url) {
  return String(url).replace(/\/+$/g, "");
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
