import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { resolveFlueCodeModel, resolveRepoPath, type OpenInspectFlueEnv } from "../env.js";
import { ensureOpenAICodexProvider } from "../openai-codex-provider.js";

export const description =
  "Autonomous code factory agent that works inside the Open-Inspect sandbox checkout.";

export const route: AgentRouteHandler = async (_c, next) => {
  await next();
};

export default createAgent<unknown, OpenInspectFlueEnv>(async ({ env }) => {
  const modelId = resolveFlueCodeModel(env);
  await ensureOpenAICodexProvider(env, modelId);

  return {
    model: modelId,
    sandbox: local(),
    cwd: resolveRepoPath(env),
    thinkingLevel: "high",
    instructions: CODE_FACTORY_INSTRUCTIONS,
  };
});

export const CODE_FACTORY_INSTRUCTIONS = [
  "You are Open-Inspect's autonomous implementation agent.",
  "Work inside the checked-out repository and inspect the code before editing.",
  "Preserve existing architecture, package boundaries, style, and tests unless the task requires changing them.",
  "Use focused validation commands when the repository provides them.",
  "Do not merge pull requests, expose secrets, or invent credentials.",
  "When complete, summarize changed files, validation, residual risk, and review focus.",
].join("\n");
