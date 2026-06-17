import { createGitHubChannel } from "@flue/github";
import { dispatch } from "@flue/runtime";

import orchestrator from "../agents/orchestrator.js";
import { makeFactoryJobInput, type FactoryJobRequest } from "../shared/factory-types.js";
import type { FactoryEnv } from "../shared/env.js";

const webhookSecret =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.GITHUB_WEBHOOK_SECRET ?? "";

export const channel = createGitHubChannel<{ Bindings: FactoryEnv }>({
  webhookSecret,

  async webhook({ c, delivery }) {
    if (delivery.name === "issue_comment" && delivery.payload.action === "created") {
      const { repository, issue, comment, sender } = delivery.payload;
      if (sender.type === "Bot") {
        return;
      }

      const command = extractFactoryCommand(comment.body, c.env);
      if (!command) {
        return;
      }

      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: issue.number,
      };
      const target = githubIssueConversationKey(issueRef);
      const request: FactoryJobRequest = {
        prompt:
          "A GitHub issue comment requested factory work.\n\n" +
          "Repository: " +
          repository.full_name +
          "\nIssue or PR: #" +
          issue.number +
          " " +
          issue.title +
          "\nSender: " +
          sender.login +
          "\nCommand:\n" +
          command,
        repo: repository.full_name,
        baseBranch: repository.default_branch,
        source: "github",
        signalId: delivery.deliveryId,
        metadata: {
          event: delivery.name,
          action: delivery.payload.action,
          issueNumber: issue.number,
          commentId: comment.id,
          sender: sender.login,
          isPullRequest: Boolean(issue.pull_request),
        },
      };

      const receipt = await dispatch(orchestrator, {
        id: target,
        input: makeFactoryJobInput(target, request),
      });

      return {
        ok: true,
        accepted: true,
        agent: "orchestrator",
        instanceId: target,
        dispatchId: receipt.dispatchId,
        streamUrl: "/agents/orchestrator/" + encodeURIComponent(target),
      };
    }

    if (delivery.name === "pull_request_review_comment" && delivery.payload.action === "created") {
      const { repository, pull_request, comment, sender } = delivery.payload;
      if (sender.type === "Bot") {
        return;
      }

      const command = extractFactoryCommand(comment.body, c.env);
      if (!command) {
        return;
      }

      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: pull_request.number,
      };
      const target = githubIssueConversationKey(issueRef);
      const request: FactoryJobRequest = {
        prompt:
          "A GitHub pull request review comment requested factory work.\n\n" +
          "Repository: " +
          repository.full_name +
          "\nPull request: #" +
          pull_request.number +
          " " +
          pull_request.title +
          "\nFile: " +
          comment.path +
          "\nSender: " +
          sender.login +
          "\nDiff hunk:\n" +
          comment.diff_hunk +
          "\n\nCommand:\n" +
          command,
        repo: repository.full_name,
        baseBranch: pull_request.base.ref,
        source: "github",
        signalId: delivery.deliveryId,
        metadata: {
          event: delivery.name,
          action: delivery.payload.action,
          pullNumber: pull_request.number,
          commentId: comment.id,
          threadId: comment.in_reply_to_id ?? comment.id,
          path: comment.path,
          sender: sender.login,
        },
      };

      const receipt = await dispatch(orchestrator, {
        id: target,
        input: makeFactoryJobInput(target, request),
      });

      return {
        ok: true,
        accepted: true,
        agent: "orchestrator",
        instanceId: target,
        dispatchId: receipt.dispatchId,
        streamUrl: "/agents/orchestrator/" + encodeURIComponent(target),
      };
    }

    if (delivery.name === "issues" && delivery.payload.action === "opened") {
      const { repository, issue, sender } = delivery.payload;
      if (sender.type === "Bot" || issue.pull_request) {
        return;
      }

      const command = extractFactoryCommand(issue.body ?? "", c.env);
      if (!command) {
        return;
      }

      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: issue.number,
      };
      const target = githubIssueConversationKey(issueRef);
      const request: FactoryJobRequest = {
        prompt:
          "A GitHub issue requested factory work.\n\n" +
          "Repository: " +
          repository.full_name +
          "\nIssue: #" +
          issue.number +
          " " +
          issue.title +
          "\nSender: " +
          sender.login +
          "\nRequest:\n" +
          command,
        repo: repository.full_name,
        baseBranch: repository.default_branch,
        source: "github",
        signalId: delivery.deliveryId,
        metadata: {
          event: delivery.name,
          action: delivery.payload.action,
          issueNumber: issue.number,
          sender: sender.login,
        },
      };

      const receipt = await dispatch(orchestrator, {
        id: target,
        input: makeFactoryJobInput(target, request),
      });

      return {
        ok: true,
        accepted: true,
        agent: "orchestrator",
        instanceId: target,
        dispatchId: receipt.dispatchId,
        streamUrl: "/agents/orchestrator/" + encodeURIComponent(target),
      };
    }
  },
});

function extractFactoryCommand(body: string, env: FactoryEnv): string | undefined {
  const triggerPhrase = (env.FACTORY_GITHUB_TRIGGER_PHRASE || "/factory").trim();
  const botUsername = env.GITHUB_BOT_USERNAME?.trim();

  const withoutMention = botUsername ? stripMention(body, botUsername) : body;
  const command = extractTriggerPhraseCommand(withoutMention, triggerPhrase);
  if (command) {
    return command;
  }

  if (botUsername && body.toLowerCase().includes("@" + botUsername.toLowerCase())) {
    const stripped = stripMention(body, botUsername).trim();
    return stripped.length > 0 ? stripped : undefined;
  }

  return undefined;
}

function githubIssueConversationKey(ref: { owner: string; repo: string; issueNumber: number }): string {
  return "github:" + ref.owner + "/" + ref.repo + "#" + ref.issueNumber;
}

function extractTriggerPhraseCommand(body: string, triggerPhrase: string): string | undefined {
  if (!triggerPhrase) {
    return undefined;
  }

  const index = body.toLowerCase().indexOf(triggerPhrase.toLowerCase());
  if (index === -1) {
    return undefined;
  }

  const command = body.slice(index + triggerPhrase.length).trim();
  return command.length > 0 ? command : undefined;
}

function stripMention(body: string, botUsername: string): string {
  const escaped = botUsername.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp("@" + escaped, "gi"), "").trim();
}
