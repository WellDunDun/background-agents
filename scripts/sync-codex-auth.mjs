#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".dev.vars");
const codexAuthPath = resolve(homedir(), ".codex/auth.json");

function parseDotEnv(source) {
  const entries = [];

  for (const line of source.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line) || !line.includes("=")) {
      entries.push({ type: "raw", line });
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      entries.push({ type: "raw", line });
      continue;
    }

    entries.push({ type: "entry", key: match[1], value: match[2] });
  }

  return entries;
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value));
}

function setEnv(entries, key, value) {
  const existing = entries.find((entry) => entry.type === "entry" && entry.key === key);
  if (existing) {
    existing.value = quoteEnvValue(value);
    return;
  }

  entries.push({ type: "entry", key, value: quoteEnvValue(value) });
}

function serializeDotEnv(entries) {
  const body = entries
    .map((entry) => (entry.type === "entry" ? entry.key + "=" + entry.value : entry.line))
    .join("\n")
    .replace(/\n+$/, "");

  return body + "\n";
}

if (!existsSync(codexAuthPath)) {
  throw new Error("Codex auth file not found at " + codexAuthPath + ". Run codex login first.");
}

if (!existsSync(envPath)) {
  throw new Error("Local env file not found at " + envPath + ". Create .dev.vars before syncing auth.");
}

const codexAuth = JSON.parse(readFileSync(codexAuthPath, "utf8"));
const tokens = codexAuth.tokens;

if (!tokens?.access_token || !tokens?.refresh_token) {
  throw new Error("Codex auth file does not contain access_token and refresh_token fields.");
}

const entries = parseDotEnv(readFileSync(envPath, "utf8"));
setEnv(entries, "OPENAI_CODEX_ACCESS_TOKEN", tokens.access_token);
setEnv(entries, "OPENAI_CODEX_REFRESH_TOKEN", tokens.refresh_token);

if (tokens.account_id) {
  setEnv(entries, "OPENAI_CODEX_ACCOUNT_ID", tokens.account_id);
}

writeFileSync(envPath, serializeDotEnv(entries), { mode: 0o600 });

console.log(
  JSON.stringify(
    {
      ok: true,
      envPath,
      codexAuthPath,
      updated: [
        "OPENAI_CODEX_ACCESS_TOKEN",
        "OPENAI_CODEX_REFRESH_TOKEN",
        ...(tokens.account_id ? ["OPENAI_CODEX_ACCOUNT_ID"] : []),
      ],
      lastRefresh: codexAuth.last_refresh ?? null,
    },
    null,
    2,
  ),
);
