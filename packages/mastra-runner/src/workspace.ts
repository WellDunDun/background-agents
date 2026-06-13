import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { DaytonaSandbox } from "@mastra/daytona";
import type { MastraRunnerConfig } from "./types";

export type MastraWorkspace = Workspace;

const MASTRA_CODE_TOOL_OVERRIDES = {
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: "view" },
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
    name: "write_file",
    requireReadBeforeWrite: true,
  },
  [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: "string_replace_lsp" },
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: "find_files" },
  [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
    name: "delete_file",
    requireApproval: true,
  },
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { name: "file_stat" },
  [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { name: "mkdir" },
  [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: "search_content" },
  [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { name: "ast_smart_edit" },
  [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
    name: "execute_command",
    maxOutputTokens: 5_000,
  },
  [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: { name: "get_process_output" },
  [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: { name: "kill_process" },
  [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: { name: "lsp_inspect" },
} as const;

export function createMastraWorkspace(config: MastraRunnerConfig): MastraWorkspace {
  if (config.sandboxMode === "existing") {
    return new Workspace({
      filesystem: new LocalFilesystem({
        basePath: config.workspacePath,
      }),
      sandbox: new LocalSandbox({
        workingDirectory: config.workspacePath,
      }),
      tools: {
        ...MASTRA_CODE_TOOL_OVERRIDES,
      },
    });
  }

  return new Workspace({
    sandbox: new DaytonaSandbox({
      id: config.daytonaSandboxId,
      apiKey: config.daytonaApiKey,
      apiUrl: config.daytonaApiUrl,
      target: config.daytonaTarget,
      snapshot: config.daytonaSnapshot,
      timeout: config.daytonaTimeoutMs,
      autoStopInterval: config.daytonaAutoStopIntervalMinutes,
      language: "typescript",
      labels: {
        app: "open-inspect",
        runner: "mastra-codex-acp",
      },
    }),
    tools: {
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
        name: "execute_command",
        maxOutputTokens: 5_000,
        backgroundProcesses: {
          abortSignal: null,
        },
      },
    },
  });
}
