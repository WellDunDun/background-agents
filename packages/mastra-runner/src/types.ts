export type MastraSandboxMode = "existing" | "daytona";
export type MastraCodeMode = "build" | "plan" | "fast";
export type MastraOmScope = "thread" | "resource";
export type MastraPermissionPolicy = "allow" | "ask" | "deny";

export interface MastraPermissionRules {
  categories: Record<string, MastraPermissionPolicy>;
  tools: Record<string, MastraPermissionPolicy>;
}

export interface MastraRunnerConfig {
  /** Where Mastra Code should execute commands. */
  sandboxMode: MastraSandboxMode;
  /** Repository/workspace path inside the current process environment. */
  workspacePath: string;
  /** Required when sandboxMode is existing to avoid accidental host execution. */
  allowLocalSandbox: boolean;
  /** Optional Mastra model id, for example openai/gpt-5.5. */
  modelId?: string;
  /** Mastra Code mode to use for the task. Defaults to Mastra Code's own default. */
  mode?: MastraCodeMode;
  /** Existing Mastra Code thread id to continue. */
  threadId?: string;
  /** Title for a new thread. If omitted, Mastra Code selects or creates a thread. */
  newThreadTitle?: string;
  /** Initialize the Mastra Harness before the first call. */
  initHarness: boolean;
  /** Destroy harness resources after a task completes or fails. */
  destroyHarnessOnFinish: boolean;
  /** Disable file and config based MCP discovery. */
  disableMcp: boolean;
  /** Disable Mastra Code hooks. */
  disableHooks: boolean;
  /** Mastra Code config directory name. Defaults to .mastracode. */
  configDir: string;
  /** Auto-approve tool calls. Keep false unless the outer sandbox policy is trusted. */
  yolo: boolean;
  /** Per-category and per-tool permissions passed to Mastra Code state. */
  permissionRules: MastraPermissionRules;
  /** LibSQL URL for Mastra Code storage. If omitted, Mastra Code reads its own env/config. */
  storageUrl?: string;
  /** Auth token for remote LibSQL storage. */
  storageAuthToken?: string;
  /** Observational memory scope. */
  omScope?: MastraOmScope;
  /** Observer model id. */
  observerModelId?: string;
  /** Reflector model id. */
  reflectorModelId?: string;
  /** Message token threshold that triggers observation. */
  observationThreshold?: number;
  /** Observation token threshold that triggers reflection. */
  reflectionThreshold?: number;
  /** Reconstruct OM progress after selecting the thread. */
  loadObservationalMemory: boolean;
  /** Daytona API key. Falls back to DAYTONA_API_KEY inside @mastra/daytona. */
  daytonaApiKey?: string;
  /** Daytona API URL. Falls back to DAYTONA_API_URL inside @mastra/daytona. */
  daytonaApiUrl?: string;
  /** Daytona runner region/target. Falls back to DAYTONA_TARGET inside @mastra/daytona. */
  daytonaTarget?: string;
  /** Daytona sandbox id to reconnect to. */
  daytonaSandboxId?: string;
  /** Daytona snapshot name/id for standalone experiments. */
  daytonaSnapshot?: string;
  /** Daytona execution timeout in milliseconds. */
  daytonaTimeoutMs: number;
  /** Daytona auto-stop interval in minutes. */
  daytonaAutoStopIntervalMinutes?: number;
}

export interface MastraRunnerInput {
  task: string;
  config?: Partial<MastraRunnerConfig>;
}

export type MastraRunnerEvent =
  | {
      type: "runner.started";
      runtime: "mastra-code";
      sandboxMode: MastraSandboxMode;
      workspacePath: string;
      modelId?: string;
      mode?: MastraCodeMode;
      threadId?: string;
      timestamp: string;
    }
  | {
      type: "runner.warning";
      code: string;
      message: string;
      timestamp: string;
    }
  | {
      type: "mastra.text_delta";
      text: string;
      messageId?: string;
      timestamp: string;
    }
  | {
      type: "mastra.harness_event";
      event: unknown;
      timestamp: string;
    }
  | {
      type: "runner.completed";
      text: string;
      timestamp: string;
    }
  | {
      type: "runner.failed";
      error: string;
      timestamp: string;
    };

export interface MastraRunnerResult {
  text: string;
}
