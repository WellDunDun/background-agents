import {
  Daytona,
  DaytonaConflictError,
  DaytonaNotFoundError,
  type Sandbox as DaytonaSandbox,
} from "@daytona/sdk";

import { daytona } from "../sandboxes/daytona.js";
import { resolveFactoryEnv, type FactoryEnv } from "./env.js";

export interface FactoryDaytonaWorkspace {
  sandbox: DaytonaSandbox;
  sandboxFactory: ReturnType<typeof daytona>;
}

export async function createFactoryDaytonaWorkspace(
  env: FactoryEnv,
  id: string,
): Promise<FactoryDaytonaWorkspace> {
  const runtimeEnv = resolveFactoryEnv(env);
  if (!runtimeEnv.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required to create factory workspaces.");
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
