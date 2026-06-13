#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runMastraCodexTask } from "./runner";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      task: {
        type: "string",
        short: "t",
      },
    },
    allowPositionals: true,
  });

  const argTask = values.task ?? positionals.join(" ");
  const task = argTask || (await readStdin());
  if (!task) {
    throw new Error("Provide a task with --task, positional args, or stdin");
  }

  for await (const event of runMastraCodexTask({ task })) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
