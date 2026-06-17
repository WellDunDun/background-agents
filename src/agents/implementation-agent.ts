import { createAgent, type AgentRouteHandler } from "@flue/runtime";

import implementSkill from "../skills/implement/SKILL.md" with { type: "skill" };
import { resolveFactoryModel, type FactoryEnv } from "../shared/env.js";

export const description =
  "Executes scoped implementation work for the software factory.";

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent<unknown, FactoryEnv>(({ env }) => ({
  model: resolveFactoryModel(env),
  thinkingLevel: "high",
  durability: {
    maxAttempts: 10,
    timeoutMs: 21600000,
  },
  instructions:
    "You are a coding agent inside the software factory. Read the repository before editing, keep changes focused, run verification, and leave a concise implementation record. Use the implementation skill as your operating procedure.",
  skills: [implementSkill],
}));

