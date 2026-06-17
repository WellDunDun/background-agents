import type { Context } from "hono";

import { makeFactoryJobInput, type FactoryJobRequest } from "./factory-types.js";
import { resolveFactoryEnv, type FactoryEnv } from "./env.js";
import { admitFactoryJob } from "./factory-admission.js";

const GITHUB_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const REGEX_SPECIAL_CHARS = "\\^$.*+?()[]{}|";
const encoder = new TextEncoder();

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface GitHubWebhookDelivery {
  name: string;
  payload: Record<string, unknown>;
  deliveryId: string;
  hookId?: string;
  installationTarget?: {
    id: string;
    type: string;
  };
}

type GitHubWebhookResult = undefined | JsonValue | Response;

export async function handleGitHubWebhook(c: Context<{ Bindings: FactoryEnv }>): Promise<Response> {
  const env = resolveFactoryEnv(c.env);
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return c.json({ error: "GITHUB_WEBHOOK_SECRET is not configured." }, 503);
  }

  const request = c.req.raw;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return new Response(null, { status: 400 });
    }
    if (Number(contentLength) > GITHUB_BODY_LIMIT_BYTES) {
      return new Response(null, { status: 413 });
    }
  }

  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > GITHUB_BODY_LIMIT_BYTES) {
    return new Response(null, { status: 413 });
  }

  const signature = parseGitHubSignature(request.headers.get("x-hub-signature-256"));
  const verified = signature
    ? await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, body, signature)
    : false;
  if (!verified) {
    return new Response(null, { status: 401 });
  }

  const payload = parseGitHubPayload(body);
  if (!payload) {
    return new Response(null, { status: 400 });
  }

  const name = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!name || !deliveryId) {
    return new Response(null, { status: 400 });
  }

  if (name === "ping") {
    return new Response(null, { status: 200 });
  }

  const delivery: GitHubWebhookDelivery = {
    name,
    payload,
    deliveryId,
    hookId: readOptionalHeader(request.headers, "x-github-hook-id"),
    installationTarget: readInstallationTarget(request.headers),
  };

  return serializeGitHubWebhookResult(c, await handleVerifiedGitHubDelivery(c, env, delivery));
}

async function handleVerifiedGitHubDelivery(
  c: Context<{ Bindings: FactoryEnv }>,
  env: FactoryEnv,
  delivery: GitHubWebhookDelivery,
): Promise<GitHubWebhookResult> {
  if (delivery.name === "issue_comment" && delivery.payload.action === "created") {
    const payload = delivery.payload as IssueCommentPayload;
    const { repository, issue, comment, sender } = payload;
    if (sender.type === "Bot") {
      return;
    }

    const command = extractFactoryCommand(comment.body, env);
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
        action: payload.action,
        issueNumber: issue.number,
        commentId: comment.id,
        sender: sender.login,
        isPullRequest: Boolean(issue.pull_request),
      },
    };

    return admitGitHubFactoryJob(env, target, request);
  }

  if (delivery.name === "pull_request_review_comment" && delivery.payload.action === "created") {
    const payload = delivery.payload as PullRequestReviewCommentPayload;
    const { repository, pull_request, comment, sender } = payload;
    if (sender.type === "Bot") {
      return;
    }

    const command = extractFactoryCommand(comment.body, env);
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
        action: payload.action,
        pullNumber: pull_request.number,
        commentId: comment.id,
        threadId: comment.in_reply_to_id ?? comment.id,
        path: comment.path,
        sender: sender.login,
      },
    };

    return admitGitHubFactoryJob(env, target, request);
  }

  if (delivery.name === "issues" && delivery.payload.action === "opened") {
    const payload = delivery.payload as IssuesOpenedPayload;
    const { repository, issue, sender } = payload;
    if (sender.type === "Bot" || issue.pull_request) {
      return;
    }

    const command = extractFactoryCommand(issue.body ?? "", env);
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
        action: payload.action,
        issueNumber: issue.number,
        sender: sender.login,
      },
    };

    return admitGitHubFactoryJob(env, target, request);
  }
}

async function admitGitHubFactoryJob(
  env: FactoryEnv,
  instanceId: string,
  request: FactoryJobRequest,
): Promise<JsonValue> {
  const admission = await admitFactoryJob(env, makeFactoryJobInput(instanceId, request));
  return {
    ...admission,
    accepted: true,
  };
}

function serializeGitHubWebhookResult(_c: Context, value: GitHubWebhookResult): Response {
  if (value === undefined) {
    return new Response(null, { status: 200 });
  }
  if (Object.prototype.toString.call(value) === "[object Response]") {
    return value as Response;
  }
  return Response.json(value);
}

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
  const escaped = escapeRegExp(botUsername);
  return body.replace(new RegExp("@" + escaped, "gi"), "").trim();
}

function escapeRegExp(value: string): string {
  let escaped = "";
  for (const char of value) {
    escaped += REGEX_SPECIAL_CHARS.includes(char) ? "\\" + char : char;
  }
  return escaped;
}

function parseGitHubSignature(value: string | null): Uint8Array | undefined {
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value ?? "");
  if (!match) {
    return undefined;
  }

  const hex = match[1];
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function verifyGitHubSignature(
  webhookSecret: string,
  body: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(encoder.encode(webhookSecret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, bytesToArrayBuffer(signature), bytesToArrayBuffer(body));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseGitHubPayload(body: Uint8Array): Record<string, unknown> | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readInstallationTarget(headers: Headers): GitHubWebhookDelivery["installationTarget"] {
  const id = readOptionalHeader(headers, "x-github-hook-installation-target-id");
  const type = readOptionalHeader(headers, "x-github-hook-installation-target-type");
  return id && type ? { id, type } : undefined;
}

function readOptionalHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value && value.length > 0 ? value : undefined;
}

interface GitHubRepositoryPayload {
  name: string;
  full_name: string;
  default_branch: string;
  owner: {
    login: string;
  };
}

interface GitHubSenderPayload {
  login: string;
  type: string;
}

interface GitHubIssuePayload {
  number: number;
  title: string;
  body?: string | null;
  pull_request?: unknown;
}

interface GitHubCommentPayload {
  id: number;
  body: string;
}

interface IssueCommentPayload extends Record<string, unknown> {
  action: string;
  repository: GitHubRepositoryPayload;
  issue: GitHubIssuePayload;
  comment: GitHubCommentPayload;
  sender: GitHubSenderPayload;
}

interface PullRequestReviewCommentPayload extends Record<string, unknown> {
  action: string;
  repository: GitHubRepositoryPayload;
  pull_request: {
    number: number;
    title: string;
    base: {
      ref: string;
    };
  };
  comment: GitHubCommentPayload & {
    path: string;
    diff_hunk: string;
    in_reply_to_id?: number;
  };
  sender: GitHubSenderPayload;
}

interface IssuesOpenedPayload extends Record<string, unknown> {
  action: string;
  repository: GitHubRepositoryPayload;
  issue: GitHubIssuePayload;
  sender: GitHubSenderPayload;
}
