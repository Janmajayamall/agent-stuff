import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "../src/contracts.ts";
import {
  COLLABORATION_WIDGET_KEY,
  installCollaborationUi,
  renderWidgetLines,
  showAgentsCommand,
} from "../src/monitor/ui.ts";
import { BoundedMonitorBuffer } from "../src/monitor/model.ts";
import type { ChildRecord, CollaborationRegistry } from "../src/registry.ts";
import { AsyncSerialQueue } from "../src/synchronization.ts";

class FakeRegistry {
  readonly interruptAgent = vi.fn(async (target: string) => ({
    target,
    previous_status: "running" as const,
  }));

  private readonly listeners = new Set<() => void>();

  constructor(readonly records: ChildRecord<BoundedMonitorBuffer>[]) {}

  children(): readonly Readonly<ChildRecord<BoundedMonitorBuffer>>[] {
    return this.records;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange(): void {
    for (const listener of [...this.listeners]) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  asRegistry(): CollaborationRegistry<BoundedMonitorBuffer> {
    return this as unknown as CollaborationRegistry<BoundedMonitorBuffer>;
  }
}

function createRecord(
  taskName: string,
  status: AgentStatus = "running",
  overrides: Partial<ChildRecord<BoundedMonitorBuffer>> = {},
): ChildRecord<BoundedMonitorBuffer> {
  return {
    id: `${taskName}-id`,
    taskName,
    canonicalPath: `/root/${taskName}`,
    parentPath: "/root",
    sessionFile: `/tmp/${taskName}.jsonl`,
    status,
    workerPhase: status === "running" ? "accepting" : "idle",
    workerGeneration: 1,
    createdAt: 1_000,
    turnStartedAt: status === "running" ? 2_000 : undefined,
    queuedMessages: [],
    monitor: new BoundedMonitorBuffer({ now: () => 2_000 }),
    lastActivity: status === "running" ? "running bash: npm test" : "completed",
    lifecycle: new AsyncSerialQueue(),
    finalizedTurnIds: new Set(),
    ...overrides,
  };
}

interface UiHarness {
  readonly context: ExtensionCommandContext;
  readonly setWidget: ReturnType<typeof vi.fn>;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly select: ReturnType<typeof vi.fn>;
  readonly confirm: ReturnType<typeof vi.fn>;
  readonly custom: ReturnType<typeof vi.fn>;
  readonly requestRender: ReturnType<typeof vi.fn>;
  readonly done: ReturnType<typeof vi.fn>;
  component: Component | undefined;
}

function createUiHarness(options: { mode?: "tui" | "rpc"; choice?: string | undefined } = {}): UiHarness {
  const setWidget = vi.fn();
  const notify = vi.fn();
  const select = vi.fn(async () => options.choice);
  const confirm = vi.fn(async () => false);
  const requestRender = vi.fn();
  const done = vi.fn();
  const tui = { requestRender } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
  const harness = {} as UiHarness;
  const custom = vi.fn(
    async (
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: unknown,
        done: (value?: void) => void,
      ) => Component,
    ) => {
      harness.component = factory(tui, theme, {}, done);
      return undefined;
    },
  );
  const ui = { setWidget, notify, select, confirm, custom };
  const context = {
    mode: options.mode ?? "tui",
    ui,
  } as unknown as ExtensionCommandContext;
  Object.assign(harness, {
    context,
    setWidget,
    notify,
    select,
    confirm,
    custom,
    requestRender,
    done,
    component: undefined,
  });
  return harness;
}

function renderedText(component: Component, width = 120): string {
  return component.render(width).join("\n");
}

function disposeComponent(component: Component): void {
  (component as Component & { dispose?: () => void }).dispose?.();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("collaboration widget", () => {
  it("renders a compact tree with status, elapsed time, and current observable activity", () => {
    const running = createRecord("build", "running", {
      turnStartedAt: 2_000,
      lastActivity: "running bash: npm test",
    });
    const completed = createRecord("review", { completed: "done" }, {
      createdAt: 500,
      turnStartedAt: undefined,
      lastActivity: "completed",
    });
    const registry = new FakeRegistry([running, completed]);

    expect(renderWidgetLines(registry.asRegistry(), 67_000)).toEqual([
      "Collaboration",
      "  /root/build  running 1m05s · running bash: npm test",
      "  /root/review  completed · completed",
    ]);
    expect(renderWidgetLines(new FakeRegistry([]).asRegistry(), 67_000)).toBeUndefined();
  });

  it("throttles registry bursts, updates active elapsed time, stops idle timers, and cleans up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const record = createRecord("build", "running", { turnStartedAt: 2_000 });
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness();

    const controller = installCollaborationUi(
      harness.context as ExtensionContext,
      registry.asRegistry(),
    );
    expect(harness.setWidget).toHaveBeenCalledTimes(1);
    expect(harness.setWidget).toHaveBeenLastCalledWith(
      COLLABORATION_WIDGET_KEY,
      expect.arrayContaining([expect.stringContaining("running 0s")]),
      { placement: "aboveEditor" },
    );
    expect(vi.getTimerCount()).toBe(1);

    registry.emitChange();
    registry.emitChange();
    registry.emitChange();
    controller.refresh();
    expect(harness.setWidget).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(harness.setWidget).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.setWidget).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.setWidget).toHaveBeenCalledTimes(3);
    expect(harness.setWidget).toHaveBeenLastCalledWith(
      COLLABORATION_WIDGET_KEY,
      expect.arrayContaining([expect.stringContaining("running 1s")]),
      { placement: "aboveEditor" },
    );

    record.status = { completed: "done" };
    record.lastActivity = "completed";
    registry.emitChange();
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    const drawCountBeforeIdleAdvance = harness.setWidget.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.setWidget).toHaveBeenCalledTimes(drawCountBeforeIdleAdvance);

    controller.dispose();
    controller.dispose();
    expect(registry.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.setWidget).toHaveBeenLastCalledWith(COLLABORATION_WIDGET_KEY, undefined);
  });

  it("cancels a queued throttled redraw when disposed", async () => {
    vi.useFakeTimers();
    const registry = new FakeRegistry([createRecord("queued")]);
    const harness = createUiHarness();
    const controller = installCollaborationUi(harness.context, registry.asRegistry());

    registry.emitChange();
    expect(vi.getTimerCount()).toBe(2);
    controller.dispose();
    const callsAfterDispose = harness.setWidget.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.setWidget).toHaveBeenCalledTimes(callsAfterDispose);
  });
});

describe("/agents selector and live transcript", () => {
  it("does nothing outside TUI mode and reports an empty root registry", async () => {
    const rpcHarness = createUiHarness({ mode: "rpc" });
    await showAgentsCommand(rpcHarness.context, new FakeRegistry([createRecord("child")]).asRegistry());
    expect(rpcHarness.select).not.toHaveBeenCalled();
    expect(rpcHarness.custom).not.toHaveBeenCalled();

    const emptyHarness = createUiHarness();
    await showAgentsCommand(emptyHarness.context, new FakeRegistry([]).asRegistry());
    expect(emptyHarness.notify).toHaveBeenCalledWith(
      "No collaboration children are registered.",
      "info",
    );
    expect(emptyHarness.select).not.toHaveBeenCalled();
  });

  it("shows child choices and opens the selected transcript", async () => {
    const first = createRecord("alpha");
    const second = createRecord("beta", { completed: "done" });
    const registry = new FakeRegistry([first, second]);
    const harness = createUiHarness({ choice: "/root/beta  [completed]" });

    await showAgentsCommand(harness.context, registry.asRegistry());

    expect(harness.select).toHaveBeenCalledWith("Inspect collaboration agent", [
      "/root/alpha  [running]",
      "/root/beta  [completed]",
    ]);
    expect(harness.custom).toHaveBeenCalledTimes(1);
    expect(harness.component).toBeDefined();
    expect(renderedText(harness.component!)).toContain("Agents · /root/beta");
    expect(renderedText(harness.component!)).toContain("Status: completed");
    disposeComponent(harness.component!);
  });

  it("uses sequence cursors and repaints when new observable events arrive", async () => {
    const record = createRecord("live");
    record.monitor.append({ kind: "assistant_text", text: "first visible line" });
    const getSince = vi.spyOn(record.monitor, "getSince");
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/live  [running]" });
    await showAgentsCommand(harness.context, registry.asRegistry());

    expect(getSince).toHaveBeenNthCalledWith(1, 0);
    expect(renderedText(harness.component!)).toContain("first visible line");
    record.monitor.append({
      kind: "tool",
      phase: "update",
      toolCallId: "call-1",
      toolName: "bash",
      arguments: { command: "npm test" },
      output: { content: [{ type: "text", text: "PASS" }] },
    });

    expect(getSince).toHaveBeenNthCalledWith(2, 1);
    expect(harness.requestRender).toHaveBeenCalledTimes(1);
    const transcript = renderedText(harness.component!);
    expect(transcript).toContain("first visible line");
    expect(transcript).toContain("bash");
    expect(transcript).toContain("npm test");
    expect(transcript).toContain("PASS");
    disposeComponent(harness.component!);

    record.monitor.append({ kind: "assistant_text", text: "after dispose" });
    expect(harness.requestRender).toHaveBeenCalledTimes(1);
  });

  it("keeps an open transcript cache within the monitor's event bound", async () => {
    const monitor = new BoundedMonitorBuffer({ maxEvents: 3, maxBytes: 10_000 });
    const record = createRecord("bounded_transcript", "running", { monitor });
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/bounded_transcript  [running]" });
    await showAgentsCommand(harness.context, registry.asRegistry());

    for (const text of ["evicted-one", "evicted-two", "visible-three", "visible-four", "visible-five"]) {
      monitor.append({ kind: "assistant_text", text });
    }

    const transcript = renderedText(harness.component!);
    expect(transcript).not.toContain("evicted-one");
    expect(transcript).not.toContain("evicted-two");
    expect(transcript).toContain("visible-three");
    expect(transcript).toContain("visible-four");
    expect(transcript).toContain("visible-five");
    disposeComponent(harness.component!);
  });

  it("Esc closes only the focused transcript and never interrupts its worker", async () => {
    const record = createRecord("esc");
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/esc  [running]" });
    await showAgentsCommand(harness.context, registry.asRegistry());

    harness.component!.handleInput?.("\u001b");
    expect(harness.done).toHaveBeenCalledTimes(1);
    expect(registry.interruptAgent).not.toHaveBeenCalled();
    expect(harness.confirm).not.toHaveBeenCalled();
    disposeComponent(harness.component!);
  });

  it("requires i confirmation and routes an accepted interrupt through the registry", async () => {
    const record = createRecord("interrupt");
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/interrupt  [running]" });
    harness.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await showAgentsCommand(harness.context, registry.asRegistry());

    harness.component!.handleInput?.("i");
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(1));
    expect(registry.interruptAgent).not.toHaveBeenCalled();

    harness.component!.handleInput?.("I");
    await vi.waitFor(() => {
      expect(registry.interruptAgent).toHaveBeenCalledWith("/root/interrupt");
    });
    expect(harness.confirm).toHaveBeenNthCalledWith(
      2,
      "Interrupt child?",
      "Interrupt /root/interrupt? Shared-file changes will not be reverted.",
    );
    expect(harness.requestRender).toHaveBeenCalledTimes(2);
    expect(harness.done).not.toHaveBeenCalled();
    disposeComponent(harness.component!);
  });

  it("does not offer registry interruption for an inactive child", async () => {
    const record = createRecord("done", { completed: "answer" });
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/done  [completed]" });
    await showAgentsCommand(harness.context, registry.asRegistry());

    harness.component!.handleInput?.("i");
    await vi.waitFor(() => {
      expect(harness.notify).toHaveBeenCalledWith("/root/done is not running.", "info");
    });
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(registry.interruptAgent).not.toHaveBeenCalled();
    disposeComponent(harness.component!);
  });

  it("renders an interrupt failure instead of leaking an unhandled UI rejection", async () => {
    const record = createRecord("interrupt_error");
    const registry = new FakeRegistry([record]);
    registry.interruptAgent.mockRejectedValueOnce(new Error("abort transport failed"));
    const harness = createUiHarness({ choice: "/root/interrupt_error  [running]" });
    harness.confirm.mockResolvedValueOnce(true);
    await showAgentsCommand(harness.context, registry.asRegistry());

    harness.component!.handleInput?.("i");
    await vi.waitFor(() => {
      expect(harness.notify).toHaveBeenCalledWith(
        "Unable to interrupt /root/interrupt_error: abort transport failed",
        "error",
      );
    });
    expect(harness.requestRender).toHaveBeenCalledTimes(1);
    disposeComponent(harness.component!);
  });

  it("lazily loads the full UTF-8 answer only after the explicit f action", async () => {
    const artifactPath = "/tmp/lazy.final.txt";
    const fullAnswer = "Complete artifact line one 🧪\n完整的第二行\nfinal line";
    const record = createRecord("lazy", { completed: "bounded preview" }, {
      finalAnswerFile: artifactPath,
    });
    record.monitor.append({
      kind: "final",
      status: { completed: "bounded preview" },
      summary: "bounded preview",
      fullAnswerFile: artifactPath,
    });
    const cursorBeforeLoad = record.monitor.latestSequence;
    const readTextFile = vi.fn(async (path: string) => {
      expect(path).toBe(artifactPath);
      return fullAnswer;
    });
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/lazy  [completed]" });

    await showAgentsCommand(harness.context, registry.asRegistry(), { readTextFile });

    expect(readTextFile).not.toHaveBeenCalled();
    const initialTranscript = renderedText(harness.component!);
    expect(initialTranscript).toContain("f full answer");
    expect(initialTranscript).toContain(artifactPath);
    expect(initialTranscript).not.toContain("Complete artifact line one");

    harness.component!.handleInput?.("f");
    expect(readTextFile).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(renderedText(harness.component!)).toContain("Complete artifact line one 🧪");
    });
    const loadedTranscript = renderedText(harness.component!);
    expect(loadedTranscript).toContain(`Full answer · ${artifactPath}`);
    expect(loadedTranscript).toContain("完整的第二行");
    expect(loadedTranscript).toContain("final line");
    expect(harness.requestRender).toHaveBeenCalledTimes(2);

    // Loaded text is component-local human UI state: it is neither appended to
    // the monitor nor delivered through any root-model messaging surface.
    expect(record.monitor.latestSequence).toBe(cursorBeforeLoad);
    expect(JSON.stringify(record.monitor.getSince(0).events)).not.toContain("完整的第二行");
    expect(harness.notify).not.toHaveBeenCalled();
    expect(registry.interruptAgent).not.toHaveBeenCalled();

    harness.component!.handleInput?.("F");
    await Promise.resolve();
    expect(readTextFile).toHaveBeenCalledTimes(1);
    disposeComponent(harness.component!);
  });

  it("renders lazy full-answer read failures without closing or controlling the child", async () => {
    const artifactPath = "/tmp/unreadable.final.txt";
    const record = createRecord("unreadable", { completed: "bounded preview" }, {
      finalAnswerFile: artifactPath,
    });
    const readTextFile = vi.fn(async () => {
      throw new Error("EACCES: permission denied");
    });
    const registry = new FakeRegistry([record]);
    const harness = createUiHarness({ choice: "/root/unreadable  [completed]" });
    await showAgentsCommand(harness.context, registry.asRegistry(), { readTextFile });

    harness.component!.handleInput?.("f");
    await vi.waitFor(() => {
      expect(renderedText(harness.component!)).toContain(
        `Unable to read ${artifactPath}: EACCES: permission denied`,
      );
    });

    expect(readTextFile).toHaveBeenCalledWith(artifactPath);
    expect(harness.requestRender).toHaveBeenCalledTimes(2);
    expect(harness.done).not.toHaveBeenCalled();
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(registry.interruptAgent).not.toHaveBeenCalled();
    disposeComponent(harness.component!);
  });
});
