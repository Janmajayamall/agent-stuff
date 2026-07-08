/**
 * Pi sandbox extension for default tools.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  CONFIG_DIR_NAME,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getAgentDir,
  type AgentToolResult,
  type BashOperations,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

type DefaultToolName =
  | "read"
  | "write"
  | "edit"
  | "ls"
  | "find"
  | "grep"
  | "bash";
type WorkerToolName = Exclude<DefaultToolName, "bash">;

type SandboxConfig = SandboxRuntimeConfig & {
  /** Set false to disable this extension without removing it. */
  enabled?: boolean;
  /** If true, sandbox initialization failure blocks tool calls instead of falling back to host tools. */
  failClosed?: boolean;
  /** If true, block non-default/custom tools, with exception of `allowUnsandboxedCustomTools`, while the sandbox is active. */
  blockNonDefaultTools?: boolean;
  /** Custom tools that are allowed to run unsandboxed while, other, non-default tools are blocked. Supports `*` globs. */
  allowUnsandboxedCustomTools?: string[];
};

const DEFAULT_TOOLS = new Set<string>([
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
  "bash",
] satisfies DefaultToolName[]);
const WORKER_TOOLS = [
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
] as const satisfies WorkerToolName[];

const PI_CODING_AGENT_IMPORT_URL = import.meta
  .resolve("@earendil-works/pi-coding-agent");

const BUILTIN_TOOL_RUNNER_SCRIPT = `
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from ${JSON.stringify(PI_CODING_AGENT_IMPORT_URL)};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const factories = {
    read: createReadTool,
    write: createWriteTool,
    edit: createEditTool,
    ls: createLsTool,
    find: createFindTool,
    grep: createGrepTool,
  };
  const factory = factories[request.toolName];
  if (!factory) throw new Error(\`Unsupported sandboxed tool: \${request.toolName}\`);
  const tool = factory(request.cwd);
  const result = await tool.execute(request.toolCallId, request.params);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: errorMessage(error) }));
  process.exitCode = 1;
}
`;

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  failClosed: true,
  blockNonDefaultTools: true,
  allowUnsandboxedCustomTools: [],
  network: {
    allowedDomains: [
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
    ],
    deniedDomains: [],
    strictAllowlist: true,
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

interface SandboxedCommandOptions {
  input?: string | Buffer;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

interface SandboxedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

interface WorkerResponse {
  ok: boolean;
  result?: AgentToolResult;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(
  base: SandboxConfig,
  override: Partial<SandboxConfig>,
): SandboxConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override) as Array<
    [keyof SandboxConfig, unknown]
  >) {
    if (value === undefined) continue;
    const current = out[key as string];
    if (isRecord(current) && isRecord(value)) {
      out[key as string] = mergeConfig(
        current as SandboxConfig,
        value as Partial<SandboxConfig>,
      );
    } else {
      out[key as string] = value;
    }
  }
  return out as SandboxConfig;
}

function loadJsonConfig(configPath: string): Partial<SandboxConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as Partial<SandboxConfig>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid sandbox config JSON in ${configPath}: ${message}`);
  }
}

function loadConfig(cwd: string, includeProjectConfig: boolean): SandboxConfig {
  const globalPath = join(getAgentDir(), "extensions", "sandbox.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  const withGlobal = mergeConfig(DEFAULT_CONFIG, loadJsonConfig(globalPath));
  return includeProjectConfig
    ? mergeConfig(withGlobal, loadJsonConfig(projectPath))
    : withGlobal;
}

function runtimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
  const {
    enabled: _enabled,
    failClosed: _failClosed,
    blockNonDefaultTools: _blockNonDefaultTools,
    allowUnsandboxedCustomTools: _allowUnsandboxedCustomTools,
    ...sandboxConfig
  } = config;
  return sandboxConfig;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sandboxedNodeCommand(script: string): string {
  return [process.execPath, "--input-type=module", "-e", script]
    .map(shellQuote)
    .join(" ");
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

async function runSandboxedCommand(
  command: string,
  cwd: string,
  options: SandboxedCommandOptions = {},
): Promise<SandboxedCommandResult> {
  if (!existsSync(cwd))
    throw new Error(`Working directory does not exist: ${cwd}`);
  if (options.signal?.aborted) throw new Error("aborted");

  const wrappedCommand = await SandboxManager.wrapWithSandbox(
    command,
    undefined,
    undefined,
    options.signal,
  );

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", wrappedCommand], {
      cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let timedOut = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        SandboxManager.cleanupAfterCommand();
      } catch {
        // Best-effort cleanup for Linux bwrap mount-point placeholders.
      }
      fn();
    };

    const onAbort = (): void => {
      if (child.pid) killProcessGroup(child.pid);
    };

    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessGroup(child.pid);
      }, options.timeout * 1000);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      options.onData?.(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      options.onData?.(chunk);
    });

    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() => {
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else
          resolve({
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            exitCode: code,
          });
      }),
    );
  });
}

function parseWorkerResponse(stdout: Buffer, stderr: Buffer): WorkerResponse {
  const text = stdout.toString("utf8").trim();
  const stderrText = stderr.toString("utf8").trim();
  if (!text)
    throw new Error(stderrText || "Sandboxed tool produced no response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const suffix = stderrText ? ` Stderr: ${stderrText}` : "";
    throw new Error(
      `Sandboxed tool returned invalid JSON: ${error instanceof Error ? error.message : error}.${suffix}`,
    );
  }

  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    throw new Error("Sandboxed tool returned invalid response shape");
  }
  return {
    ok: parsed.ok,
    result: isRecord(parsed.result)
      ? (parsed.result as AgentToolResult)
      : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  };
}

async function runSandboxedWorkerTool(
  toolName: WorkerToolName,
  cwd: string,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  const result = await runSandboxedCommand(
    sandboxedNodeCommand(BUILTIN_TOOL_RUNNER_SCRIPT),
    cwd,
    {
      input: JSON.stringify({ toolName, cwd, toolCallId, params }),
      signal,
    },
  );
  const response = parseWorkerResponse(result.stdout, result.stderr);
  if (!response.ok)
    throw new Error(response.error ?? `${toolName} failed in sandbox`);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString("utf8").trim() ||
        `${toolName} sandbox subprocess exited with code ${result.exitCode}`,
    );
  }
  if (!response.result)
    throw new Error(`${toolName} sandbox subprocess did not return a result`);
  return response.result;
}

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function resolveToolPath(filePath: string, cwd: string): string {
  const normalized = stripAtPrefix(filePath.trim());
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/"))
    return resolvePath(homedir(), normalized.slice(2));
  if (isAbsolute(normalized)) return resolvePath(normalized);
  return resolvePath(cwd, normalized);
}

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const result = await runSandboxedCommand(command, cwd, {
        onData,
        signal,
        timeout,
        env,
      });
      return { exitCode: result.exitCode };
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function toolNameMatchesPattern(toolName: string, pattern: string): boolean {
  if (!pattern.includes("*")) return toolName === pattern;
  const regex = new RegExp(
    `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
  );
  return regex.test(toolName);
}

function isAllowedUnsandboxedCustomTool(
  toolName: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => toolNameMatchesPattern(toolName, pattern));
}

const workerToolFactories = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  ls: createLsTool,
  find: createFindTool,
  grep: createGrepTool,
} as const;

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable sandboxing for Pi default tool calls",
    type: "boolean",
    default: false,
  });

  const initialCwd = process.cwd();
  let sandboxRequired = true;
  let sandboxActive = false;
  let failClosed = DEFAULT_CONFIG.failClosed ?? true;
  let blockNonDefaultTools = DEFAULT_CONFIG.blockNonDefaultTools ?? true;
  let allowUnsandboxedCustomTools =
    DEFAULT_CONFIG.allowUnsandboxedCustomTools ?? [];
  let unavailableReason: string | undefined;

  function sandboxReadyOrFallback(): boolean {
    if (sandboxActive) return true;
    if (sandboxRequired && failClosed)
      throw new Error(unavailableReason ?? "Sandbox is not active");
    return false;
  }

  for (const toolName of WORKER_TOOLS) {
    const localTool = workerToolFactories[toolName](initialCwd) as any;
    pi.registerTool({
      ...localTool,
      label: `${localTool.label ?? toolName} (sandboxed)`,
      async execute(
        id: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: any,
        ctx?: any,
      ) {
        const cwd = ctx?.cwd ?? initialCwd;
        if (!sandboxReadyOrFallback()) {
          return (workerToolFactories[toolName](cwd) as any).execute(
            id,
            params,
            signal,
            onUpdate,
            ctx,
          );
        }

        const run = () =>
          runSandboxedWorkerTool(toolName, cwd, id, params, signal);
        if (
          (toolName === "write" || toolName === "edit") &&
          typeof params?.path === "string"
        ) {
          return withFileMutationQueue(resolveToolPath(params.path, cwd), run);
        }
        return run();
      },
    });
  }

  const localBash = createBashTool(initialCwd) as any;
  pi.registerTool({
    ...localBash,
    label: `${localBash.label ?? "bash"} (sandboxed)`,
    async execute(
      id: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: any,
      ctx?: any,
    ) {
      const cwd = ctx?.cwd ?? initialCwd;
      if (!sandboxReadyOrFallback())
        return (createBashTool(cwd) as any).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      return (
        createBashTool(cwd, { operations: createSandboxedBashOps() }) as any
      ).execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on("tool_call", (event) => {
    if (sandboxRequired && !sandboxActive && failClosed) {
      return {
        block: true,
        reason: unavailableReason ?? "Sandbox is not active",
      };
    }
    if (
      sandboxActive &&
      blockNonDefaultTools &&
      !DEFAULT_TOOLS.has(event.toolName) &&
      !isAllowedUnsandboxedCustomTool(
        event.toolName,
        allowUnsandboxedCustomTools,
      )
    ) {
      return {
        block: true,
        reason: `${event.toolName} is not a default tool covered by the sandbox extension`,
      };
    }
  });

  pi.on("user_bash", () => {
    if (sandboxActive) return { operations: createSandboxedBashOps() };
    if (sandboxRequired && failClosed) {
      return {
        result: {
          output: unavailableReason ?? "Sandbox is not active",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxRequired = false;
      sandboxActive = false;
      ctx.ui.setStatus("sandbox", undefined);
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    let config: SandboxConfig;
    try {
      config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    } catch (error) {
      failClosed = true;
      blockNonDefaultTools = true;
      allowUnsandboxedCustomTools = [];
      sandboxRequired = true;
      sandboxActive = false;
      unavailableReason =
        error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("error", "Sandbox: config error"),
      );
      ctx.ui.notify(
        `${unavailableReason}; tool calls will be blocked`,
        "error",
      );
      return;
    }

    failClosed = config.failClosed ?? true;
    blockNonDefaultTools = config.blockNonDefaultTools ?? true;
    allowUnsandboxedCustomTools = config.allowUnsandboxedCustomTools ?? [];
    unavailableReason = undefined;

    if (config.enabled === false) {
      sandboxRequired = false;
      sandboxActive = false;
      ctx.ui.setStatus("sandbox", undefined);
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    sandboxRequired = true;
    try {
      await SandboxManager.initialize(runtimeConfig(config));
      sandboxActive = true;
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox active"));
      ctx.ui.notify("Sandbox initialized for Pi default tools", "info");
    } catch (error) {
      sandboxActive = false;
      unavailableReason = `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`;
      ctx.ui.notify(
        failClosed
          ? `${unavailableReason}; tool calls will be blocked`
          : unavailableReason,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await SandboxManager.reset();
    } catch {
      // Ignore cleanup failures, including partially failed initialization.
    }
    sandboxActive = false;
    ctx.ui.setStatus("sandbox", undefined);
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox status/config summary",
    handler: async (_args, ctx) => {
      let config: SandboxConfig;
      try {
        config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
      ctx.ui.notify(
        [
          `Sandbox: ${sandboxActive ? "active" : sandboxRequired ? "required but inactive" : "disabled"}`,
          unavailableReason ? `Reason: ${unavailableReason}` : undefined,
          `Fail closed: ${failClosed ? "yes" : "no"}`,
          `Block non-default tools: ${blockNonDefaultTools ? "yes" : "no"}`,
          `Allowed unsandboxed custom tools: ${[...allowUnsandboxedCustomTools].sort().join(", ") || "(none)"}`,
          `Default tools: ${[...DEFAULT_TOOLS].sort().join(", ")}`,
          `Allowed domains: ${config.network.allowedDomains.join(", ") || "(none)"}`,
          `Allow write: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
          `Deny read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
          `Deny write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    },
  });
}
