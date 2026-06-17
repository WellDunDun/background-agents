import { defineTool } from "@flue/runtime";
import { Buffer } from "node:buffer";
import * as v from "valibot";

import type { FactoryEnv } from "../shared/env.js";
import type { FactoryCommandSandbox } from "../shared/daytona.js";
import {
  commentOnIssue,
  createPullRequest,
  getCachedInstallationToken,
  getGitHubAppConfig,
  getInstallationRepository,
  listInstallationRepositories,
  parseRepositorySlug,
} from "../shared/github.js";

export function createGitHubFactoryTools(
  env: FactoryEnv,
  sandbox: FactoryCommandSandbox,
  context: { jobId: string },
) {
  return [
    defineTool({
      name: "github_list_accessible_repositories",
      description: "List repositories accessible to the configured GitHub App installation.",
      parameters: v.object({}),
      execute: async () => {
        const repos = await listInstallationRepositories(getGitHubAppConfig(env));
        return JSON.stringify({
          repositories: repos.map((repo) => ({
            fullName: repo.fullName,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            language: repo.language,
          })),
        });
      },
    }),
    defineTool({
      name: "github_prepare_repository",
      description:
        "Validate GitHub App access, configure sandbox git credentials, clone the repo, and create a factory branch.",
      parameters: v.object({
        repo: v.pipe(v.string(), v.description("Repository in owner/name form.")),
        baseBranch: v.optional(v.string()),
        workingBranch: v.optional(v.string()),
      }),
      execute: async ({ repo, baseBranch, workingBranch }) => {
        const config = getGitHubAppConfig(env);
        const parsed = parseRepositorySlug(repo);
        const repository = await getInstallationRepository(config, parsed.owner, parsed.name);
        if (!repository) {
          throw new Error("GitHub App installation cannot access " + repo + ".");
        }

        const token = await getCachedInstallationToken(config);
        const branch = sanitizeBranchName(workingBranch ?? "factory/" + context.jobId);
        const base = baseBranch ?? repository.defaultBranch;
        const workDir = (await sandbox.getWorkDir()) ?? (await sandbox.getUserHomeDir()) ?? "/home/daytona";
        const homeDir = (await sandbox.getUserHomeDir()) ?? workDir;
        const checkoutDir = workDir.replace(/\/$/, "") + "/" + repository.name;

        await configureGitCredentials(sandbox, homeDir, token, env);
        await runCommand(
          sandbox,
          "if [ -d " +
            quotePosix(checkoutDir + "/.git") +
            " ]; then cd " +
            quotePosix(checkoutDir) +
            " && git fetch origin " +
            quotePosix(base) +
            "; else git clone --branch " +
            quotePosix(base) +
            " " +
            quotePosix("https://github.com/" + repository.owner + "/" + repository.name + ".git") +
            " " +
            quotePosix(checkoutDir) +
            "; fi",
          workDir,
          600,
        );
        await runCommand(
          sandbox,
          "cd " +
            quotePosix(checkoutDir) +
            " && git checkout -B " +
            quotePosix(branch) +
            " " +
            quotePosix("origin/" + base),
          workDir,
          120,
        );

        return JSON.stringify({
          repo: repository.fullName,
          baseBranch: base,
          workingBranch: branch,
          checkoutDir,
          sandboxId: sandbox.id,
        });
      },
    }),
    defineTool({
      name: "github_push_branch",
      description: "Push the current checkout HEAD to a GitHub branch through the configured GitHub App credentials.",
      parameters: v.object({
        checkoutDir: v.string(),
        branch: v.string(),
      }),
      execute: async ({ checkoutDir, branch }) => {
        const result = await runCommand(
          sandbox,
          "cd " +
            quotePosix(checkoutDir) +
            " && git status --short && git push -u origin " +
            quotePosix("HEAD:refs/heads/" + sanitizeBranchName(branch)),
          checkoutDir,
          600,
        );
        return JSON.stringify(result);
      },
    }),
    defineTool({
      name: "github_create_pull_request",
      description: "Create a draft pull request for a pushed factory branch.",
      parameters: v.object({
        repo: v.string(),
        title: v.string(),
        body: v.string(),
        sourceBranch: v.string(),
        targetBranch: v.string(),
        draft: v.optional(v.boolean()),
      }),
      execute: async ({ repo, title, body, sourceBranch, targetBranch, draft }) => {
        const parsed = parseRepositorySlug(repo);
        const pr = await createPullRequest(getGitHubAppConfig(env), {
          owner: parsed.owner,
          repo: parsed.name,
          title,
          body,
          sourceBranch: sanitizeBranchName(sourceBranch),
          targetBranch,
          draft: draft ?? true,
        });
        return JSON.stringify(pr);
      },
    }),
    defineTool({
      name: "github_comment_on_pull_request",
      description: "Add a comment to a pull request or issue in the bound GitHub repository.",
      parameters: v.object({
        repo: v.string(),
        number: v.number(),
        body: v.string(),
      }),
      execute: async ({ repo, number, body }) => {
        const parsed = parseRepositorySlug(repo);
        await commentOnIssue(getGitHubAppConfig(env), {
          owner: parsed.owner,
          repo: parsed.name,
          issueNumber: number,
          body,
        });
        return "Comment posted.";
      },
    }),
  ];
}

async function configureGitCredentials(
  sandbox: FactoryCommandSandbox,
  homeDir: string,
  token: string,
  env: FactoryEnv,
): Promise<void> {
  const credentialsPath = homeDir.replace(/\/$/, "") + "/.git-credentials";
  const credentials = "https://x-access-token:" + encodeURIComponent(token) + "@github.com\n";
  await sandbox.fs.uploadFile(Buffer.from(credentials), credentialsPath);

  const authorName = env.FACTORY_GIT_AUTHOR_NAME ?? "Signal Factory";
  const authorEmail = env.FACTORY_GIT_AUTHOR_EMAIL ?? "signal-factory@example.invalid";
  await runCommand(
    sandbox,
    "git config --global credential.helper " +
      quotePosix("store --file " + credentialsPath) +
      " && git config --global user.name " +
      quotePosix(authorName) +
      " && git config --global user.email " +
      quotePosix(authorEmail),
    homeDir,
    120,
  );
}

async function runCommand(
  sandbox: FactoryCommandSandbox,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.process.executeCommand(command, cwd, undefined, timeoutSeconds);
  const stdout = result.artifacts?.stdout ?? result.result ?? "";
  if (result.exitCode !== 0) {
    throw new Error("Command failed with exit code " + result.exitCode + ": " + stdout);
  }
  return { stdout, stderr: "", exitCode: result.exitCode };
}

function sanitizeBranchName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^\/|\/$/g, "");
  if (normalized.length === 0 || normalized.includes("..") || normalized.endsWith(".")) {
    throw new Error("Invalid branch name.");
  }
  return normalized.slice(0, 180);
}

function quotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
