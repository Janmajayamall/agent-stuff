import { describe, expect, it, vi } from "vitest";
import {
  BoundedMonitorBuffer,
  extractVisibleAssistantText,
  normalizeRpcMonitorEvent,
  sanitizeAssistantMessage,
} from "../src/monitor/model.ts";

function assistantMessage() {
  return {
    role: "assistant",
    api: "test-api",
    provider: "secret-provider",
    model: "secret-model",
    responseId: "response-secret",
    deferred: { id: "deferred-secret" },
    diagnostics: [{ type: "provider", details: { secret: "diagnostic-secret" } }],
    content: [
      { type: "thinking", thinking: "hidden chain of thought", thinkingSignature: "encrypted-secret", redacted: true },
      { type: "reasoning", text: "alternate hidden reasoning", signature: "reasoning-secret" },
      { type: "text", text: "Visible answer", textSignature: "text-secret", providerMetadata: "drop-me" },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "npm test", nested: { value: 1 } },
        thoughtSignature: "tool-secret",
      },
    ],
    usage: {
      input: 3,
      output: 5,
      reasoning: 4,
      totalTokens: 8,
      cost: { input: 0.1, output: 0.2, total: 0.3 },
      providerBreakdown: "drop-me",
    },
    stopReason: "stop",
    rawStopReason: "end_turn",
    errorMessage: undefined,
    timestamp: 123,
    unknownProviderField: "drop-me",
  };
}

describe("assistant monitor sanitization", () => {
  it("deep-clones only visible assistant text, observable tool calls, metadata, and usage", () => {
    const source = assistantMessage();
    const sanitized = sanitizeAssistantMessage(source);

    expect(sanitized).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Visible answer" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "npm test", nested: { value: 1 } },
        },
      ],
      usage: {
        input: 3,
        output: 5,
        reasoning: 4,
        totalTokens: 8,
        cost: { input: 0.1, output: 0.2, total: 0.3 },
      },
      stopReason: "stop",
      rawStopReason: "end_turn",
      timestamp: 123,
    });
    expect(extractVisibleAssistantText(source)).toBe("Visible answer");

    source.content[2]!.text = "mutated source";
    (source.content[3]!.arguments as { nested: { value: number } }).nested.value = 99;
    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain("Visible answer");
    expect(serialized).not.toContain("mutated source");
    expect(serialized).not.toMatch(/hidden|secret|drop-me|signature|responseId|deferred|diagnostic/i);
    expect(
      (sanitized.content[1] as unknown as { arguments: { nested: { value: number } } }).arguments.nested.value,
    ).toBe(1);
  });

  it("drops all thinking wire events before normalization", () => {
    for (const type of ["thinking_start", "thinking_delta", "thinking_end"] as const) {
      expect(normalizeRpcMonitorEvent({ type })).toEqual([]);
      expect(
        normalizeRpcMonitorEvent({
          type: "message_update",
          assistantMessageEvent: { type, delta: "never retain this reasoning" },
        }),
      ).toEqual([]);
    }
  });
});

describe("BoundedMonitorBuffer", () => {
  it("normalizes visible text, tool activity/output, usage, and errors with sequence cursors", () => {
    let now = 100;
    const monitor = new BoundedMonitorBuffer({ now: () => now++ });
    const observed: number[] = [];
    const unsubscribe = monitor.subscribe((event) => observed.push(event.sequence));

    monitor.ingest({ type: "agent_start" });
    monitor.ingest({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    monitor.ingest({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    const cumulative = { content: [{ type: "text", text: "line 1\nline 2" }] };
    monitor.ingest({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" },
      partialResult: cumulative,
    });
    monitor.ingest({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "passed" }] },
      isError: false,
    });
    monitor.ingest({ type: "message_end", message: assistantMessage() });
    unsubscribe();
    monitor.append({ kind: "error", message: "observable failure" });

    cumulative.content[0]!.text = "mutated after ingest";
    const firstPage = monitor.getSince(0);
    expect(firstPage.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(firstPage.nextCursor).toBe(8);
    expect(firstPage.droppedThrough).toBe(0);
    expect(monitor.currentActivity).toBe("error: observable failure");

    const update = firstPage.events.find(
      (event) => event.kind === "tool" && event.phase === "update",
    );
    expect(update).toMatchObject({
      kind: "tool",
      toolName: "bash",
      output: { content: [{ type: "text", text: "line 1\nline 2" }] },
    });
    expect(JSON.stringify(firstPage.events)).not.toContain("mutated after ingest");
    expect(firstPage.events.some((event) => event.kind === "usage")).toBe(true);

    expect(monitor.getSince(5).events.map((event) => event.sequence)).toEqual([6, 7, 8]);
  });

  it("never retains a raw assistant object or hidden reasoning at ingestion", () => {
    const monitor = new BoundedMonitorBuffer();
    const source = assistantMessage();
    monitor.ingest({ type: "message_start", message: source });
    monitor.ingest({
      type: "message_update",
      message: source,
      assistantMessageEvent: {
        type: "done",
        reason: "stop",
        message: source,
        partial: source,
      },
    });
    monitor.ingest({ type: "message_end", message: source });

    source.content[0]!.thinking = "later hidden mutation";
    source.content[2]!.text = "later visible mutation";
    const serialized = JSON.stringify(monitor.getSince(0).events);
    expect(serialized).toContain("Visible answer");
    expect(serialized).not.toMatch(/hidden|secret|signature|later visible mutation|provider|diagnostic|deferred/i);
  });

  it("evicts by count and reports cursor loss while preserving the latest terminal event", () => {
    const monitor = new BoundedMonitorBuffer({ maxEvents: 3, maxBytes: 10_000, now: () => 1 });
    monitor.append({ kind: "assistant_text", text: "one" });
    monitor.append({ kind: "final", status: { completed: "answer" }, summary: "complete" });
    monitor.append({ kind: "assistant_text", text: "three" });
    monitor.append({ kind: "assistant_text", text: "four" });
    monitor.append({ kind: "assistant_text", text: "five" });

    const page = monitor.getSince(0);
    expect(page.events.map((event) => event.sequence)).toEqual([2, 4, 5]);
    expect(page.droppedThrough).toBe(3);
    expect(page.nextCursor).toBe(5);
    expect(page.events.find((event) => event.kind === "final")).toMatchObject({
      status: { completed: "answer" },
    });

    monitor.beginTurn();
    monitor.append({ kind: "assistant_text", text: "six" });
    expect(monitor.getSince(0).events.map((event) => event.sequence)).toEqual([4, 5, 6]);
  });

  it("evicts by approximate UTF-8 bytes and bounds a single oversized event", () => {
    const monitor = new BoundedMonitorBuffer({ maxEvents: 20, maxBytes: 512, now: () => 1 });
    monitor.append({ kind: "assistant_text", text: "a".repeat(180) });
    monitor.append({ kind: "assistant_text", text: "🧪".repeat(50) });
    monitor.append({ kind: "error", message: "x".repeat(2_000) });

    expect(monitor.byteLength).toBeLessThanOrEqual(512);
    expect(monitor.length).toBeGreaterThan(0);
    expect(monitor.getSince(0).events.at(-1)).toMatchObject({
      kind: "notice",
      originalKind: "error",
    });
    expect(monitor.getSince(0).droppedThrough).toBeGreaterThan(0);
  });

  it("isolates listener failures and supports idempotent unsubscription", () => {
    const monitor = new BoundedMonitorBuffer();
    const throwing = vi.fn(() => {
      throw new Error("renderer failed");
    });
    const healthy = vi.fn();
    const unsubscribeThrowing = monitor.subscribe(throwing);
    const unsubscribeHealthy = monitor.subscribe(healthy);

    expect(() => monitor.append({ kind: "activity", activity: "working" })).not.toThrow();
    unsubscribeThrowing();
    unsubscribeThrowing();
    unsubscribeHealthy();
    monitor.append({ kind: "activity", activity: "done" });

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
