import {
  createAgent,
  defineAgentProfile,
  type AgentRouteHandler,
} from "@flue/runtime";

import implementSkill from "../skills/implement/SKILL.md" with { type: "skill" };
import reviewSkill from "../skills/review/SKILL.md" with { type: "skill" };
import scaffoldSkill from "../skills/scaffold-project/SKILL.md" with { type: "skill" };
import type { FactoryJobInput } from "../shared/factory-types.js";
import { resolveFactoryModel, type FactoryEnv } from "../shared/env.js";

export const description =
  "Coordinates durable software factory jobs from manual prompts and external signals.";

export const route: AgentRouteHandler = async (_c, next) => next();

const implementationAgent = defineAgentProfile({
  name: "implementation_agent",
  description: "Builds scoped code changes in an isolated workspace and prepares commits.",
  instructions:
    "You are the implementation agent for the software factory. Work in small, reversible changes. Prefer existing project conventions. Produce commits only after verification passes.",
  skills: [implementSkill],
});

const reviewBot = defineAgentProfile({
  name: "review_bot",
  description: "Reviews diffs, tests, security posture, and merge readiness.",
  instructions:
    "You are the review bot. Prioritize correctness, security, missing tests, and deployment risk. Request iteration when the change is not ready for human review.",
  skills: [reviewSkill],
});

export default createAgent<FactoryJobInput, FactoryEnv>(({ env }) => ({
  model: resolveFactoryModel(env),
  thinkingLevel: "high",
  durability: {
    maxAttempts: 10,
    timeoutMs: 21600000,
  },
  compaction: {
    keepRecentTokens: 12000,
    reserveTokens: 20000,
  },
  instructions:
    "You are the orchestrator for a personal autonomous code factory. Admit work from trusted commands and signals, create an execution plan, delegate implementation to implementation_agent, delegate review to review_bot, and stop with a PR ready for the user's explicit review. Never merge without explicit user approval. Keep every decision traceable to the job input, repository context, test results, and review findings.",
  skills: [scaffoldSkill],
  subagents: [implementationAgent, reviewBot],
}));

