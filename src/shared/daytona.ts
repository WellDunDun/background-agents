import {
  Daytona,
  DaytonaConflictError,
  DaytonaNotFoundError,
  type Sandbox as DaytonaSandbox,
} from "@daytona/sdk";
import type { SandboxFactory } from "@flue/runtime";
import type { Buffer } from "node:buffer";

import { daytona } from "../sandboxes/daytona.js";
import { resolveFactoryEnv, type FactoryEnv } from "./env.js";

export interface FactoryDaytonaWorkspace {
  sandbox: FactoryCommandSandbox;
  sandboxFactory: SandboxFactory;
}

export interface FactoryCommandSandbox {
  id: string;
  fs: {
    uploadFile(source: string | Buffer, remotePath: string, timeout?: number): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result?: string; artifacts?: { stdout?: string } }>;
  };
  getWorkDir(): Promise<string | undefined>;
  getUserHomeDir(): Promise<string | undefined>;
}

export async function createFactoryDaytonaWorkspace(
  env: FactoryEnv,
  id: string,
): Promise<FactoryDaytonaWorkspace> {
  const runtimeEnv = resolveFactoryEnv(env);
  if (!runtimeEnv.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required to create factory workspaces.");
  }

  if (runtimeEnv.FACTORY_WORKSPACE_PROVIDER === "runner") {
    return createRunnerLocalWorkspace(runtimeEnv, id);
  }

  const client = new Daytona({
    apiKey: runtimeEnv.DAYTONA_API_KEY,
    ...(runtimeEnv.DAYTONA_API_URL ? { apiUrl: runtimeEnv.DAYTONA_API_URL } : {}),
    ...(runtimeEnv.DAYTONA_TARGET ? { target: runtimeEnv.DAYTONA_TARGET } : {}),
  });

  const sandboxName = "factory-" + sanitizeSandboxName(id);
  const baseParams = {
    name: sandboxName,
    labels: {
      app: "flue-factory",
      "factory.job": id,
    },
    envVars: {
      FACTORY_JOB_ID: id,
    },
    ...(numberFromEnv(runtimeEnv.DAYTONA_AUTO_STOP_MINUTES) !== undefined
      ? { autoStopInterval: numberFromEnv(runtimeEnv.DAYTONA_AUTO_STOP_MINUTES) }
      : {}),
    ...(numberFromEnv(runtimeEnv.DAYTONA_AUTO_ARCHIVE_MINUTES) !== undefined
      ? { autoArchiveInterval: numberFromEnv(runtimeEnv.DAYTONA_AUTO_ARCHIVE_MINUTES) }
      : {}),
    ...(numberFromEnv(runtimeEnv.DAYTONA_AUTO_DELETE_MINUTES) !== undefined
      ? { autoDeleteInterval: numberFromEnv(runtimeEnv.DAYTONA_AUTO_DELETE_MINUTES) }
      : {}),
  };

  const timeout = numberFromEnv(runtimeEnv.DAYTONA_CREATE_TIMEOUT_SECONDS);
  const options = timeout === undefined ? undefined : { timeout };
  const sandbox = await getOrCreateSandbox(client, sandboxName, async () =>
    runtimeEnv.DAYTONA_IMAGE
      ? await client.create({ ...baseParams, image: runtimeEnv.DAYTONA_IMAGE }, options)
      : await client.create(
          { ...baseParams, ...(runtimeEnv.DAYTONA_SNAPSHOT ? { snapshot: runtimeEnv.DAYTONA_SNAPSHOT } : {}) },
          options,
        ),
  );
  await sandbox.refreshActivity().catch(() => undefined);

  return {
    sandbox,
    sandboxFactory: daytona(sandbox),
  };
}

async function createRunnerLocalWorkspace(
  env: FactoryEnv,
  id: string,
): Promise<FactoryDaytonaWorkspace> {
  const [{ local }, fs, childProcess, path] = await Promise.all([
    import("@flue/runtime/node"),
    import("node:fs/promises"),
    import("node:child_process"),
    import("node:path"),
  ]);
  const root = env.FACTORY_RUNNER_WORKSPACE_ROOT ?? "/tmp/signal-factory-jobs";
  const cwd = path.join(root, sanitizeSandboxName(id));
  await fs.mkdir(cwd, { recursive: true });

  const sandbox: FactoryCommandSandbox = {
    id: "runner:" + sanitizeSandboxName(id),
    fs: {
      uploadFile: async (source, remotePath) => {
        const destination = resolveRunnerPath(path, cwd, remotePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, source);
      },
    },
    process: {
      executeCommand: async (command, commandCwd, commandEnv, timeout) => {
        const cwdPath = commandCwd ? resolveRunnerPath(path, cwd, commandCwd) : cwd;
        await fs.mkdir(cwdPath, { recursive: true });
        return runLocalCommand(childProcess, command, cwdPath, commandEnv, timeout);
      },
    },
    getWorkDir: async () => cwd,
    getUserHomeDir: async () => cwd,
  };

  return {
    sandbox,
    sandboxFactory: local({ cwd }),
  };
}

function resolveRunnerPath(
  path: typeof import("node:path"),
  root: string,
  value: string,
): string {
  const relative = value.startsWith("/") ? value.slice(1) : value;
  return path.join(root, relative);
}

async function runLocalCommand(
  childProcess: typeof import("node:child_process"),
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutSeconds: number | undefined,
): Promise<{ exitCode: number; result: string; artifacts: { stdout: string } }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
          }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const output = stdout + stderr;
      resolve({
        exitCode: code ?? 1,
        result: output,
        artifacts: { stdout: output },
      });
    });
  });
}

async function getOrCreateSandbox(
  client: Daytona,
  sandboxName: string,
  createSandbox: () => Promise<DaytonaSandbox>,
): Promise<DaytonaSandbox> {
  try {
    return await client.get(sandboxName);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) {
      throw error;
    }
  }

  try {
    return await createSandbox();
  } catch (error) {
    if (error instanceof DaytonaConflictError) {
      return await client.get(sandboxName);
    }
    throw error;
  }
}

function sanitizeSandboxName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const trimmed = normalized.replace(/^-|-$/g, "");
  return (trimmed.length > 0 ? trimmed : "job").slice(0, 48);
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
