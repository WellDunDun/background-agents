import { defineTool } from "@flue/runtime";
import { Buffer } from "node:buffer";
import * as v from "valibot";

import type { FactoryEnv } from "../shared/env.js";
import type { FactoryCommandSandbox } from "../shared/daytona.js";
import {
  canWriteRepository,
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
            writable: canWriteRepository(repo),
            permissions: {
              admin: Boolean(repo.permissions?.admin),
              maintain: Boolean(repo.permissions?.maintain),
              push: Boolean(repo.permissions?.push),
              triage: Boolean(repo.permissions?.triage),
              pull: Boolean(repo.permissions?.pull),
            },
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
        if (!canWriteRepository(repository)) {
          throw new Error(
            "GitHub App installation has no write access to " +
              repo +
              ". Grant Contents/Pull requests write access and update the app installation before preparing repo-backed work.",
          );
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
      name: "github_get_repository_status",
      description: "Read the current branch, latest commit, and short git status for a prepared checkout.",
      parameters: v.object({
        checkoutDir: v.string(),
      }),
      execute: async ({ checkoutDir }) => {
        const result = await runCommand(
          sandbox,
          [
            "cd " + quotePosix(checkoutDir),
            "printf 'branch=' && git branch --show-current",
            "printf 'head=' && git rev-parse HEAD",
            "printf 'status\\n' && git status --porcelain=v1",
          ].join(" && "),
          checkoutDir,
          120,
        );
        return JSON.stringify(result);
      },
    }),
    defineTool({
      name: "github_get_review_context",
      description:
        "Collect bounded review evidence from a prepared checkout: branch, head, status, commits, changed files, diff stats, whitespace check, and a truncated diff preview.",
      parameters: v.object({
        checkoutDir: v.string(),
        targetBranch: v.pipe(v.string(), v.description("Base branch to compare against, usually the PR target branch.")),
      }),
      execute: async ({ checkoutDir, targetBranch }) => {
        const safeTargetBranch = sanitizeBranchName(targetBranch);
        const baseRef = "origin/" + safeTargetBranch;
        const result = await runCommand(
          sandbox,
          [
            "set -e",
            "cd " + quotePosix(checkoutDir),
            "git fetch origin " + quotePosix(safeTargetBranch),
            sectionCommand("branch", "git branch --show-current"),
            sectionCommand("head", "git rev-parse HEAD"),
            sectionCommand("status", "git status --porcelain=v1"),
            sectionCommand("commits", "git log --oneline --decorate --max-count=20 " + quotePosix(baseRef + "..HEAD")),
            sectionCommand("name_status", "git diff --name-status " + quotePosix(baseRef + "...HEAD")),
            sectionCommand("stat", "git diff --stat " + quotePosix(baseRef + "...HEAD")),
            sectionCommand("check", "git diff --check " + quotePosix(baseRef + "...HEAD") + " || true"),
            sectionCommand(
              "diff_preview",
              "git diff --find-renames --find-copies --unified=80 " + quotePosix(baseRef + "...HEAD") + " | head -c 60000",
            ),
          ].join(" && "),
          checkoutDir,
          300,
        );
        return JSON.stringify(parseReviewContextOutput(result.stdout));
      },
    }),
    defineTool({
      name: "github_commit_all_changes",
      description:
        "Stage every changed file in a prepared checkout and create one commit. Returns committed=false when the worktree is clean.",
      parameters: v.object({
        checkoutDir: v.string(),
        message: v.pipe(v.string(), v.description("Single concise git commit message.")),
      }),
      execute: async ({ checkoutDir, message }) => {
        const statusBefore = await runCommand(
          sandbox,
          "cd " + quotePosix(checkoutDir) + " && git status --porcelain=v1",
          checkoutDir,
          120,
        );
        if (!statusBefore.stdout.trim()) {
          return JSON.stringify({ committed: false, reason: "worktree_clean", status: "" });
        }

        const commitMessage = normalizeCommitMessage(message);
        const result = await runCommand(
          sandbox,
          [
            "set -e",
            "cd " + quotePosix(checkoutDir),
            "git add -A",
            "if git diff --cached --quiet; then echo '__NO_COMMIT__'; else git commit -m " +
              quotePosix(commitMessage) +
              " && git rev-parse HEAD; fi",
            "printf 'status_after\\n'",
            "git status --porcelain=v1",
          ].join(" && "),
          checkoutDir,
          600,
        );
        if (result.stdout.includes("__NO_COMMIT__")) {
          return JSON.stringify({ committed: false, reason: "no_staged_changes", status: statusBefore.stdout });
        }

        return JSON.stringify({
          committed: true,
          commit: result.stdout.match(/\b[0-9a-f]{40}\b/)?.[0],
          message: commitMessage,
          statusBefore: statusBefore.stdout,
          statusAfter: result.stdout.split("status_after", 2)[1]?.trim() ?? "",
          stdout: result.stdout,
        });
      },
    }),
    defineTool({
      name: "github_create_pull_request",
      description: "Create or return the existing open draft pull request for a pushed factory branch.",
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

function normalizeCommitMessage(value: string): string {
  const subject = value
    .replace(/\0/g, "")
    .split(/\r?\n/, 1)[0]
    ?.trim();
  return subject ? subject.slice(0, 120) : "chore: apply factory changes";
}

function sectionCommand(section: string, command: string): string {
  return "printf " + quotePosix("\n__" + section.toUpperCase() + "__\n") + " && (" + command + ")";
}

function parseReviewContextOutput(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const pattern = /\n__([A-Z_]+)__\n/g;
  const matches = Array.from(stdout.matchAll(pattern));

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const section = match[1].toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? stdout.length;
    sections[section] = stdout.slice(start, end).trim();
  }

  return sections;
}

function quotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
