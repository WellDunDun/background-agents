import { createAgent, type AgentRouteHandler } from "@flue/runtime";

import reviewSkill from "../skills/thermo-nuclear-code-quality-review/SKILL.md" with { type: "skill" };
import { resolveFactoryModel, type FactoryEnv } from "../shared/env.js";

export const description =
  "Reviews implementation branches before they are sent to the user.";

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent<unknown, FactoryEnv>(({ env }) => ({
  model: resolveFactoryModel(env),
  thinkingLevel: "high",
  durability: {
    maxAttempts: 6,
    timeoutMs: 7200000,
  },
  instructions:
    "You are the code review bot for the software factory. Lead with correctness, security, production risk, and missing verification. If the implementation needs another iteration, say exactly what must change. Do not approve merge. Human approval is required.",
  skills: [reviewSkill],
}));
