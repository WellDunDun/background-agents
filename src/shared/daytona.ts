import {
  Daytona,
  DaytonaConflictError,
  DaytonaNotFoundError,
  type Sandbox as DaytonaSandbox,
} from "@daytona/sdk";

import { daytona } from "../sandboxes/daytona.js";
import type { FactoryEnv } from "./env.js";

export interface FactoryDaytonaWorkspace {
  sandbox: DaytonaSandbox;
  sandboxFactory: ReturnType<typeof daytona>;
}

export async function createFactoryDaytonaWorkspace(
  env: FactoryEnv,
  id: string,
): Promise<FactoryDaytonaWorkspace> {
  if (!env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required to create factory workspaces.");
  }

  const client = new Daytona({
    apiKey: env.DAYTONA_API_KEY,
    ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
    ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}),
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
    ...(numberFromEnv(env.DAYTONA_AUTO_STOP_MINUTES) !== undefined
      ? { autoStopInterval: numberFromEnv(env.DAYTONA_AUTO_STOP_MINUTES) }
      : {}),
    ...(numberFromEnv(env.DAYTONA_AUTO_ARCHIVE_MINUTES) !== undefined
      ? { autoArchiveInterval: numberFromEnv(env.DAYTONA_AUTO_ARCHIVE_MINUTES) }
      : {}),
    ...(numberFromEnv(env.DAYTONA_AUTO_DELETE_MINUTES) !== undefined
      ? { autoDeleteInterval: numberFromEnv(env.DAYTONA_AUTO_DELETE_MINUTES) }
      : {}),
  };

  const timeout = numberFromEnv(env.DAYTONA_CREATE_TIMEOUT_SECONDS);
  const options = timeout === undefined ? undefined : { timeout };
  const sandbox = await getOrCreateSandbox(client, sandboxName, async () =>
    env.DAYTONA_IMAGE
      ? await client.create({ ...baseParams, image: env.DAYTONA_IMAGE }, options)
      : await client.create(
          { ...baseParams, ...(env.DAYTONA_SNAPSHOT ? { snapshot: env.DAYTONA_SNAPSHOT } : {}) },
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
