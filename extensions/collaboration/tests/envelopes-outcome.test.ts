import { describe, expect, it } from "vitest";

import {
  composeInactiveTaskPrompt,
  createParentEnvelope,
  createQueuedParentMessage,
} from "../src/envelopes.ts";
import { formatStatusPayload, mapSettledOutcome } from "../src/outcome.ts";

describe("literal parent-to-child envelopes", () => {
  it.each(["/child-command --dangerous", "/skill-name argument", "/prompt-template value"])(
    "wraps a leading-slash payload without trimming or interpreting it: %s",
    (payload) => {
      const envelope = createParentEnvelope("TASK", "/root/tests", payload, "message-1");

      expect(envelope).toBe(
        [
          "Message Type: TASK",
          "Sender: /root",
          "Recipient: /root/tests",
          "Message-ID: message-1",
          "Payload:",
          payload,
        ].join("\n"),
      );
      expect(envelope.startsWith("/")).toBe(false);
      expect(envelope.endsWith(payload)).toBe(true);
    },
  );

  it("preserves arbitrary payload whitespace and newlines verbatim", () => {
    const payload = "  leading spaces\n\ntrailing spaces  \n";
    const envelope = createParentEnvelope("MESSAGE", "/root/worker", payload, "message-2");

    expect(envelope.slice(envelope.indexOf("Payload:\n") + "Payload:\n".length)).toBe(payload);
  });

  it("creates queued messages with an injected stable id", () => {
    expect(createQueuedParentMessage("information", () => "queued-1")).toEqual({
      id: "queued-1",
      message: "information",
    });
  });

  it("composes queued MESSAGE envelopes FIFO followed by exactly one TASK", () => {
    const prompt = composeInactiveTaskPrompt(
      "/root/tests",
      [
        { id: "queued-1", message: "first\nline" },
        { id: "queued-2", message: "/literal-command" },
        { id: "queued-3", message: "third" },
      ],
      "new task",
      () => "task-1",
    );

    const first = prompt.indexOf("Message-ID: queued-1");
    const second = prompt.indexOf("Message-ID: queued-2");
    const third = prompt.indexOf("Message-ID: queued-3");
    const task = prompt.indexOf("Message-ID: task-1");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(third).toBeLessThan(task);
    expect(prompt.match(/Message Type: MESSAGE/g)).toHaveLength(3);
    expect(prompt.match(/Message Type: TASK/g)).toHaveLength(1);
    expect(prompt).toContain("Payload:\n/literal-command");
    expect(prompt.endsWith("Payload:\nnew task")).toBe(true);
  });

  it("emits an active follow-up with the dedicated FOLLOW_UP type", () => {
    expect(createParentEnvelope("FOLLOW_UP", "/root/tests", "continue", "follow-1")).toContain(
      "Message Type: FOLLOW_UP",
    );
  });
});

describe("settled child outcome mapping", () => {
  it("gives extension-owned interruption precedence over provider metadata", () => {
    expect(
      mapSettledOutcome({
        interruptedByExtension: true,
        finalAssistant: assistant("partial", "error", "provider failed"),
      }),
    ).toBe("interrupted");
  });

  it("maps absence of a current-turn assistant to a null completion", () => {
    expect(mapSettledOutcome({ interruptedByExtension: false })).toEqual({ completed: null });
  });

  it.each([
    ["error", "provider exploded", { errored: "provider exploded" }],
    ["error", undefined, { errored: "Child provider/runtime error" }],
    ["aborted", "remote abort", { errored: "remote abort" }],
    ["aborted", undefined, { errored: "Child turn aborted unexpectedly" }],
    ["length", "ignored", { errored: "Child response reached the output limit" }],
    [
      "deferred",
      undefined,
      { errored: "Deferred child responses are unsupported by per-turn workers" },
    ],
    ["pending", undefined, { errored: "Child settled with an incomplete assistant response" }],
  ] as const)("maps stopReason %s exactly", (stopReason, errorMessage, expected) => {
    expect(
      mapSettledOutcome({
        interruptedByExtension: false,
        finalAssistant: assistant("partial output", stopReason, errorMessage),
      }),
    ).toEqual(expected);
  });

  it.each(["stop", "toolUse"] as const)("maps valid %s completion to visible final text", (stopReason) => {
    expect(
      mapSettledOutcome({
        interruptedByExtension: false,
        finalAssistant: {
          role: "assistant",
          stopReason,
          content: [
            { type: "thinking", thinking: "secret", thinkingSignature: "secret-signature" },
            { type: "text", text: "visible ", textSignature: "opaque-signature" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
            { type: "text", text: "answer" },
          ],
        },
      }),
    ).toEqual({ completed: "visible answer" });
  });

  it("treats an assistant with no visible text as a null completion", () => {
    expect(
      mapSettledOutcome({
        interruptedByExtension: false,
        finalAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        },
      }),
    ).toEqual({ completed: null });
  });

  it("accepts missing stopReason as a completed legacy assistant", () => {
    expect(
      mapSettledOutcome({
        interruptedByExtension: false,
        finalAssistant: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ).toEqual({ completed: "done" });
  });

  it("maps an unknown stop reason to a diagnostic error", () => {
    expect(
      mapSettledOutcome({
        interruptedByExtension: false,
        finalAssistant: assistant("partial", "future_reason"),
      }),
    ).toEqual({ errored: "Child settled with unsupported stop reason future_reason" });
  });

  it("formats only the bounded logical status payload, never monitor data", () => {
    expect(formatStatusPayload({ completed: "answer" })).toBe("answer");
    expect(formatStatusPayload({ completed: null })).toBe("Child completed without a final answer.");
    expect(formatStatusPayload({ errored: "failed" })).toBe("Child error: failed");
    expect(formatStatusPayload("interrupted")).toBe("Child turn was interrupted.");
    expect(formatStatusPayload("shutdown")).toBe("Child status: shutdown");
  });
});

function assistant(text: string, stopReason: string, errorMessage?: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text", text }],
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}
