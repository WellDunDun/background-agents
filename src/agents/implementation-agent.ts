import { createAgent, type AgentRouteHandler } from "@flue/runtime";

import implementSkill from "../skills/implement/SKILL.md" with { type: "skill" };
import { createFactoryDaytonaWorkspace } from "../shared/daytona.js";
import { resolveFactoryEnv, resolveFactoryModel, type FactoryEnv } from "../shared/env.js";
import { registerFactoryModelProvider } from "../shared/model-provider.js";
import { createGitHubFactoryTools } from "../tools/github-factory-tools.js";

export const description =
  "Executes scoped implementation work for the software factory.";

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent<unknown, FactoryEnv>(async ({ id, env }) => {
  const runtimeEnv = resolveFactoryEnv(env);
  await registerFactoryModelProvider(runtimeEnv);
  const workspace = await createFactoryDaytonaWorkspace(runtimeEnv, id);

  return {
    model: resolveFactoryModel(runtimeEnv),
    thinkingLevel: "high",
    durability: {
      maxAttempts: 10,
      timeoutMs: 21600000,
    },
    sandbox: workspace.sandboxFactory,
    instructions:
      "You are a coding agent inside the software factory. Use github_prepare_repository before editing an existing repository, read the repository before changing code, keep changes focused, run verification, push the working branch when ready, and leave a concise implementation record. Use the implementation skill as your operating procedure.",
    tools: createGitHubFactoryTools(runtimeEnv, workspace.sandbox, { jobId: id }),
    skills: [implementSkill],
  };
});
