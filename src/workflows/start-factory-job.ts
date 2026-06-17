import { type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";

import { admitFactoryJob } from "../shared/factory-admission.js";
import {
  makeFactoryJobInput,
  parseFactoryJobRequest,
  type FactoryJobRequest,
} from "../shared/factory-types.js";
import type { FactoryEnv } from "../shared/env.js";

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({
  env,
  payload,
}: FlueContext<FactoryJobRequest, FactoryEnv>) {
  const parsed = parseFactoryJobRequest(payload);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const jobId = crypto.randomUUID();
  const input = makeFactoryJobInput(jobId, parsed.value);
  return admitFactoryJob(env, input);
}
