import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCollaborationExtension,
  renderMailboxMessage,
} from "../index.ts";
import { COLLABORATION_TOOL_NAMES } from "../src/contracts.ts";
import {
  COLLABORATION_MAILBOX_TYPE,
  RootMailbox,
  type MailboxMessageDetails,
} from "../src/mailbox.ts";
import { freshHistorySeeder, type HistorySeedRequest } from "../src/history-seeder.ts";
import { CollaborationRegistry } from "../src/registry.ts";
import { COLLABORATION_CHILD_ENV } from "../src/rpc-child.ts";

type ExtensionEventHandler = (event: unknown, context: ExtensionContext) => unknown;
type MessageRenderer = (
  message: { content: string | Array<{ type: string; text?: string }>; details?: MailboxMessageDetails },
  options: MessageRenderOptions,
  theme: Theme,
) => Component | undefined;

interface TestTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
}

interface FakePiHarness {
  readonly pi: ExtensionAPI;
  readonly tools: TestTool[];
  readonly commands: Map<string, unknown>;
  readonly renderers: Map<string, MessageRenderer>;
  readonly handlers: Map<string, ExtensionEventHandler[]>;
  readonly sentMessages: unknown[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const originalChildMarker = process.env[COLLABORATION_CHILD_ENV];

afterEach(() => {
  if (originalChildMarker === undefined) {
    delete process.env[COLLABORATION_CHILD_ENV];
  } else {
    process.env[COLLABORATION_CHILD_ENV] = originalChildMarker;
  }
});

function rootProcess(): void {
  delete process.env[COLLABORATION_CHILD_ENV];
}

function createFakePi(): FakePiHarness {
  const tools: TestTool[] = [];
  const commands = new Map<string, unknown>();
  const renderers = new Map<string, MessageRenderer>();
  const handlers = new Map<string, ExtensionEventHandler[]>();
  const sentMessages: unknown[] = [];

  const implementation = {
    registerTool(definition: unknown) {
      tools.push(definition as TestTool);
    },
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
    registerMessageRenderer(customType: string, renderer: MessageRenderer) {
      renderers.set(customType, renderer);
    },
    on(event: string, handler: ExtensionEventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
  };

  return {
    pi: implementation as unknown as ExtensionAPI,
    tools,
    commands,
    renderers,
    handlers,
    sentMessages,
  };
}

function createContext(sessionFile: string | undefined): ExtensionContext {
  const model = {
    provider: "test-provider",
    id: "gpt-5.6-sol",
    reasoning: true,
  };
  return {
    mode: "rpc",
    cwd: "/tmp/collaboration-index-test",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "root-session-id",
    },
    model,
    scopedModels: [],
    thinkingLevel: "medium",
    modelRegistry: {
      getAvailable: () => [model],
      getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function onlyHandler(harness: FakePiHarness, event: string): ExtensionEventHandler {
  const handlers = harness.handlers.get(event);
  expect(handlers, `missing ${event} handler`).toHaveLength(1);
  return handlers![0]!;
}

function tool(harness: FakePiHarness, name: string): TestTool {
  const registered = harness.tools.find((candidate) => candidate.name === name);
  if (!registered) throw new Error(`Missing tool ${name}`);
  return registered;
}

async function invoke(
  registered: TestTool,
  params: Record<string, unknown>,
  context: ExtensionContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  return registered.execute("index-test-call", params, signal, undefined, context);
}

async function startSession(harness: FakePiHarness, context: ExtensionContext): Promise<void> {
  await onlyHandler(harness, "session_start")(
    { type: "session_start", reason: "startup" },
    context,
  );
}

async function shutdownSession(harness: FakePiHarness, context: ExtensionContext): Promise<void> {
  await onlyHandler(harness, "session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
}

describe("collaboration extension registration", () => {
  it("returns at the child marker before registering any root behavior", () => {
    process.env[COLLABORATION_CHILD_ENV] = "1";
    const harness = createFakePi();
    const resolveAgentDirectory = vi.fn(() => "/tmp/pi-agent");

    createCollaborationExtension({ resolveAgentDirectory })(harness.pi);

    expect(harness.tools).toHaveLength(0);
    expect(harness.commands.size).toBe(0);
    expect(harness.renderers.size).toBe(0);
    expect(harness.handlers.size).toBe(0);
    expect(resolveAgentDirectory).not.toHaveBeenCalled();
  });

  it("registers exactly the six collaboration tools, /agents, the mailbox renderer, and lifecycle handlers", () => {
    rootProcess();
    const harness = createFakePi();

    createCollaborationExtension()(harness.pi);

    expect(harness.tools.map(({ name }) => name)).toEqual(COLLABORATION_TOOL_NAMES);
    expect([...harness.commands.keys()]).toEqual(["agents"]);
    expect([...harness.renderers.keys()]).toEqual([COLLABORATION_MAILBOX_TYPE]);
    expect([...harness.handlers.keys()].sort()).toEqual([
      "input",
      "session_shutdown",
      "session_start",
    ]);
    for (const handlers of harness.handlers.values()) expect(handlers).toHaveLength(1);
  });
});

describe("collaboration extension session lifecycle", () => {
  it("starts a live registry and wakes a wait tool only for human input steered into the active turn", async () => {
    rootProcess();
    const harness = createFakePi();
    const context = createContext("/tmp/root-session.jsonl");
    createCollaborationExtension()(harness.pi);
    await startSession(harness, context);

    const listed = await invoke(tool(harness, "collaboration_list_agents"), {}, context);
    expect(listed.details).toEqual({
      agents: [{ agent_name: "/root", agent_status: "running" }],
    });

    const waiting = invoke(
      tool(harness, "collaboration_wait_agent"),
      { timeout_ms: 10_000 },
      context,
    );
    let waitSettled = false;
    void waiting.then(
      () => { waitSettled = true; },
      () => { waitSettled = true; },
    );

    await onlyHandler(harness, "input")(
      { type: "input", text: "idle prompt", source: "interactive" },
      context,
    );
    await onlyHandler(harness, "input")(
      { type: "input", text: "queued follow-up", source: "rpc", streamingBehavior: "followUp" },
      context,
    );
    await onlyHandler(harness, "input")(
      { type: "input", text: "extension steering", source: "extension", streamingBehavior: "steer" },
      context,
    );
    await flushTasks();
    expect(waitSettled).toBe(false);

    await onlyHandler(harness, "input")(
      { type: "input", text: "status?", source: "interactive", streamingBehavior: "steer" },
      context,
    );
    await expect(waiting).resolves.toMatchObject({
      details: {
        message: "Human user input received from interactive.",
        timed_out: false,
      },
    });

    await shutdownSession(harness, context);
  });

  it("leaves a clean no-active state when replacement initialization fails", async () => {
    rootProcess();
    const harness = createFakePi();
    const persistedContext = createContext("/tmp/root-session.jsonl");
    const noSessionContext = createContext(undefined);
    const resolveAgentDirectory = vi.fn(async () => {
      throw new Error("agent directory unavailable");
    });
    createCollaborationExtension({ resolveAgentDirectory })(harness.pi);
    await startSession(harness, persistedContext);

    const oldWaiter = invoke(
      tool(harness, "collaboration_wait_agent"),
      { timeout_ms: 10_000 },
      persistedContext,
    );
    await expect(startSession(harness, noSessionContext)).rejects.toThrow(
      "agent directory unavailable",
    );
    await expect(oldWaiter).resolves.toMatchObject({
      details: {
        message: "Collaboration session shut down.",
        timed_out: false,
      },
    });

    expect(() => onlyHandler(harness, "input")(
      { type: "input", text: "late steering", source: "interactive", streamingBehavior: "steer" },
      noSessionContext,
    )).not.toThrow();
    await expect(invoke(
      tool(harness, "collaboration_list_agents"),
      {},
      noSessionContext,
    )).rejects.toThrow(
      /Lifecycle error: collaboration is not attached to an active root session/,
    );
    await shutdownSession(harness, noSessionContext);
  });

  it("does not publish a late session start after shutdown advances the lifecycle generation", async () => {
    rootProcess();
    const harness = createFakePi();
    const context = createContext(undefined);
    const agentDirectory = deferred<string>();
    const resolveAgentDirectory = vi.fn(() => agentDirectory.promise);
    createCollaborationExtension({ resolveAgentDirectory })(harness.pi);

    const starting = startSession(harness, context);
    expect(resolveAgentDirectory).toHaveBeenCalledTimes(1);
    await shutdownSession(harness, context);
    agentDirectory.resolve("/tmp/late-agent-directory");
    await expect(starting).resolves.toBeUndefined();

    await expect(invoke(
      tool(harness, "collaboration_list_agents"),
      {},
      context,
    )).rejects.toThrow(
      /Lifecycle error: collaboration is not attached to an active root session/,
    );
  });

  it("disposes unpublished mailbox and registry state when TUI setup fails", async () => {
    rootProcess();
    const harness = createFakePi();
    const rpcContext = createContext("/tmp/root-session.jsonl");
    const context = {
      ...rpcContext,
      mode: "tui",
      ui: {
        setWidget() {
          throw new Error("widget setup failed");
        },
      },
    } as unknown as ExtensionContext;
    const shutdownMailbox = vi.spyOn(RootMailbox.prototype, "shutdown");
    const disposeRegistry = vi.spyOn(CollaborationRegistry.prototype, "dispose");
    createCollaborationExtension()(harness.pi);

    await expect(startSession(harness, context)).rejects.toThrow("widget setup failed");
    expect(shutdownMailbox).toHaveBeenCalledTimes(1);
    expect(disposeRegistry).toHaveBeenCalledTimes(1);
    await expect(invoke(
      tool(harness, "collaboration_list_agents"),
      {},
      context,
    )).rejects.toThrow(
      /Lifecycle error: collaboration is not attached to an active root session/,
    );
    await shutdownSession(harness, context);
  });

  it("removes a pre-usable allocation when it finishes after root teardown", async () => {
    rootProcess();
    const sandbox = await mkdtemp(join(tmpdir(), "pi-collaboration-index-"));
    const harness = createFakePi();
    const context = createContext(join(sandbox, "root.jsonl"));
    const seedStarted = deferred<HistorySeedRequest>();
    const releaseSeed = deferred<void>();
    vi.spyOn(freshHistorySeeder, "seed").mockImplementation(async (request) => {
      seedStarted.resolve(request);
      await releaseSeed.promise;
      return { kind: "fresh", seededParentMessages: 0 };
    });

    try {
      createCollaborationExtension()(harness.pi);
      await startSession(harness, context);
      const spawning = invoke(
        tool(harness, "collaboration_spawn_agent"),
        { task_name: "late_allocation", message: "work" },
        context,
      );
      const seedRequest = await seedStarted.promise;
      await expect(access(seedRequest.childSessionFile)).resolves.toBeUndefined();

      await shutdownSession(harness, context);
      releaseSeed.resolve(undefined);

      await expect(spawning).rejects.toThrow(/registry is shut down/);
      await expect(access(seedRequest.childSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseSeed.resolve(undefined);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("settles an outstanding waiter on shutdown and makes every registered tool reject afterward", async () => {
    rootProcess();
    const harness = createFakePi();
    const context = createContext("/tmp/root-session.jsonl");
    createCollaborationExtension()(harness.pi);
    await startSession(harness, context);

    const outstandingWait = invoke(
      tool(harness, "collaboration_wait_agent"),
      { timeout_ms: 10_000 },
      context,
    );
    await shutdownSession(harness, context);

    await expect(outstandingWait).resolves.toMatchObject({
      details: {
        message: "Collaboration session shut down.",
        timed_out: false,
      },
    });

    const validInputs: Readonly<Record<string, Record<string, unknown>>> = {
      collaboration_spawn_agent: { task_name: "after_shutdown", message: "work" },
      collaboration_send_message: { target: "child", message: "context" },
      collaboration_followup_task: { target: "child", message: "continue" },
      collaboration_interrupt_agent: { target: "child" },
      collaboration_list_agents: {},
      collaboration_wait_agent: { timeout_ms: 10_000 },
    };
    for (const registered of harness.tools) {
      await expect(invoke(registered, validInputs[registered.name]!, context)).rejects.toThrow(
        /Lifecycle error: collaboration is not attached to an active root session/,
      );
    }
  });

  it("still shuts down the mailbox and registry when TUI disposal throws", async () => {
    rootProcess();
    const harness = createFakePi();
    let failWidgetRemoval = false;
    const rpcContext = createContext("/tmp/root-session.jsonl");
    const context = {
      ...rpcContext,
      mode: "tui",
      ui: {
        setWidget(_key: string, value: unknown) {
          if (failWidgetRemoval && value === undefined) {
            throw new Error("widget teardown failed");
          }
        },
      },
    } as unknown as ExtensionContext;
    createCollaborationExtension()(harness.pi);
    await startSession(harness, context);

    const controller = new AbortController();
    const outstandingWait = invoke(
      tool(harness, "collaboration_wait_agent"),
      { timeout_ms: 10_000 },
      context,
      controller.signal,
    );
    failWidgetRemoval = true;

    try {
      await shutdownSession(harness, context).catch(() => undefined);
      const outcome = await Promise.race([
        outstandingWait.then((result) => ({ kind: "settled" as const, result })),
        new Promise<{ kind: "pending" }>((resolve) => {
          setImmediate(() => resolve({ kind: "pending" }));
        }),
      ]);
      expect(outcome).toMatchObject({
        kind: "settled",
        result: {
          details: {
            message: "Collaboration session shut down.",
            timed_out: false,
          },
        },
      });
    } finally {
      controller.abort();
      await outstandingWait.catch(() => undefined);
    }
  });

  it("resolves the injected Pi agent directory only for a --no-session root", async () => {
    rootProcess();
    const noSessionHarness = createFakePi();
    const noSessionContext = createContext(undefined);
    const noSessionResolver = vi.fn(async () => "/tmp/injected-pi-agent");
    createCollaborationExtension({ resolveAgentDirectory: noSessionResolver })(noSessionHarness.pi);

    await startSession(noSessionHarness, noSessionContext);
    expect(noSessionResolver).toHaveBeenCalledTimes(1);
    await shutdownSession(noSessionHarness, noSessionContext);

    const persistedHarness = createFakePi();
    const persistedContext = createContext("/tmp/persisted/root.jsonl");
    const persistedResolver = vi.fn(async () => "/tmp/must-not-be-read");
    createCollaborationExtension({ resolveAgentDirectory: persistedResolver })(persistedHarness.pi);

    await startSession(persistedHarness, persistedContext);
    expect(persistedResolver).not.toHaveBeenCalled();
    await shutdownSession(persistedHarness, persistedContext);
  });
});

describe("mailbox transcript rendering", () => {
  const theme = {
    fg: (color: string, text: string) => `[${color}]${text}`,
  } as unknown as Theme;
  const details: MailboxMessageDetails = {
    sender: "/root/tests",
    taskName: "/root",
    status: { completed: "first line\nsecond line" },
    truncated: false,
    fullBytes: 22,
  };
  const content = [
    "Message Type: FINAL_ANSWER",
    "Task name: /root",
    "Sender: /root/tests",
    "Payload:",
    "first line",
    "second line",
  ].join("\n");

  it("renders one concise payload line by default", () => {
    const component = renderMailboxMessage(
      content,
      details,
      { expanded: false, outputPad: 2 },
      theme,
    );

    expect(component.render(80)).toEqual([
      "  [accent]/root/tests · completed",
      "  [muted]first line",
    ]);
  });

  it("renders the complete payload when expanded", () => {
    const component = renderMailboxMessage(
      content,
      details,
      { expanded: true, outputPad: 1 },
      theme,
    );

    expect(component.render(80)).toEqual([
      " [accent]/root/tests · completed",
      " first line",
      " second line",
    ]);
  });

  it("truncates ANSI-styled lines by terminal cells without splitting wide Unicode", () => {
    const ansiTheme = {
      fg: (color: string, text: string) =>
        color === "accent"
          ? `\u001b[31m${text}\u001b[39m`
          : `\u001b[2m${text}\u001b[22m`,
    } as unknown as Theme;
    const wideContent = [
      "Message Type: FINAL_ANSWER",
      "Task name: /root",
      "Sender: /root/tests",
      "Payload:",
      "界🙂界A",
    ].join("\n");
    const component = renderMailboxMessage(
      wideContent,
      details,
      { expanded: false, outputPad: 1 },
      ansiTheme,
    );

    expect(component.render(6)).toEqual([
      " \u001b[31m/root\u001b[0m",
      " \u001b[2m界🙂\u001b[0m",
    ]);
  });
});
