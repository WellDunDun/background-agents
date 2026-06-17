import {
  dispatch,
  type FlueContext,
  type WorkflowRouteHandler,
} from "@flue/runtime";

import orchestrator from "../agents/orchestrator.js";
import {
  makeFactoryJobInput,
  parseFactoryJobRequest,
  type FactoryJobRequest,
} from "../shared/factory-types.js";
import type { FactoryEnv } from "../shared/env.js";

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({
  payload,
}: FlueContext<FactoryJobRequest, FactoryEnv>) {
  const parsed = parseFactoryJobRequest(payload);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const jobId = crypto.randomUUID();
  const input = makeFactoryJobInput(jobId, parsed.value);
  const receipt = await dispatch(orchestrator, {
    id: jobId,
    input,
  });

  return {
    jobId,
    agent: "orchestrator",
    instanceId: jobId,
    dispatchId: receipt.dispatchId,
    acceptedAt: receipt.acceptedAt,
  };
}

