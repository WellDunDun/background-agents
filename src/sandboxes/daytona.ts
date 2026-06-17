// flue-blueprint: sandbox/daytona@1
import {
  SandboxOperationUnsupportedError,
  createSandboxSessionEnv,
  type FileStat,
  type SandboxApi,
  type SandboxFactory,
  type SessionEnv,
} from "@flue/runtime";
import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { Buffer } from "node:buffer";

const PROVIDER = "daytona";

class DaytonaSandboxApi implements SandboxApi {
  constructor(private readonly sandbox: DaytonaSandbox) {}

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return new TextDecoder().decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const buffer = await this.sandbox.fs.downloadFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.sandbox.fs.uploadFile(Buffer.from(bytes), path);
  }

  async stat(path: string): Promise<FileStat> {
    const info = await this.sandbox.fs.getFileDetails(path);
    return {
      isFile: !info.isDir,
      isDirectory: info.isDir,
      size: info.size,
      ...(parseModifiedAt(info.modifiedAt) ? { mtime: parseModifiedAt(info.modifiedAt) } : {}),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.sandbox.fs.listFiles(path);
    return entries.map((entry) => entry.name);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.sandbox.fs.getFileDetails(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      await this.exec("mkdir -p " + quotePosix(path));
      return;
    }

    await this.sandbox.fs.createFolder(path, "755");
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (options?.force) {
      throw new SandboxOperationUnsupportedError({
        operation: "rm",
        provider: PROVIDER,
        options: ["force"],
      });
    }

    await this.sandbox.fs.deleteFile(path, options?.recursive);
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    options?.signal?.throwIfAborted();
    const timeoutSeconds =
      options?.timeoutMs === undefined ? undefined : Math.ceil(options.timeoutMs / 1000);
    const result = await this.sandbox.process.executeCommand(
      command,
      options?.cwd,
      options?.env,
      timeoutSeconds,
    );
    options?.signal?.throwIfAborted();

    return {
      stdout: result.artifacts?.stdout ?? result.result ?? "",
      stderr: "",
      exitCode: result.exitCode,
    };
  }
}

export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = (await sandbox.getWorkDir()) ?? (await sandbox.getUserHomeDir()) ?? "/home/daytona";
      return createSandboxSessionEnv(new DaytonaSandboxApi(sandbox), sandboxCwd);
    },
  };
}

function parseModifiedAt(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

function quotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

