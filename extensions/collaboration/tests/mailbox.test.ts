import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_MAILBOX_TYPE,
  MailboxWaitAbortedError,
  RootMailbox,
  boundMailboxPayload,
  formatMailboxEnvelope,
  utf8Prefix,
  type MailboxCustomMessage,
  type MailboxDeliveryAdapter,
  type MailboxSendOptions,
} from "../src/mailbox.ts";

interface DeliveryCall {
  message: MailboxCustomMessage;
  options: MailboxSendOptions;
}

function deliveryAdapter(idle: boolean, calls: DeliveryCall[]): MailboxDeliveryAdapter {
  return {
    isIdle: () => idle,
    sendMessage(message, options) {
      calls.push({ message, options });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mailbox payload bounding", () => {
  it("takes deterministic UTF-8-safe prefixes", () => {
    expect(utf8Prefix("A🧪B", 1)).toBe("A");
    expect(utf8Prefix("A🧪B", 4)).toBe("A");
    expect(utf8Prefix("A🧪B", 5)).toBe("A🧪");
    expect(utf8Prefix("A🧪B", 6)).toBe("A🧪B");
    expect(() => utf8Prefix("x", -1)).toThrow(/non-negative/);
  });

  it("keeps a small final answer unchanged and does not create an artifact", async () => {
    const artifactWriter = vi.fn(async () => "/should/not/exist");
    const bounded = await boundMailboxPayload(
      { sender: "/root/test", sessionFile: "/tmp/child.jsonl", status: { completed: "answer" } },
      { artifactWriter, maxMailboxBytes: 512 },
    );

    expect(bounded).toEqual({
      status: { completed: "answer" },
      payload: "answer",
      truncated: false,
      fullBytes: 6,
    });
    expect(artifactWriter).not.toHaveBeenCalled();
  });

  it("atomically persists a complete Unicode answer with owner-only permissions", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-collaboration-mailbox-"));
    const sessionFile = join(temporaryDirectory, "child.jsonl");
    const answer = `leading-${"🧪漢字".repeat(160)}-trailing`;
    const calls: DeliveryCall[] = [];
    const mailbox = new RootMailbox({
      delivery: deliveryAdapter(true, calls),
      maxMailboxBytes: 512,
    });

    try {
      const delivered = await mailbox.deliverFinal({
        sender: "/root/unicode",
        sessionFile,
        status: { completed: answer },
        dedupeKey: "turn-unicode",
      });
      expect(calls).toHaveLength(1);
      expect(Buffer.byteLength(calls[0]!.message.content, "utf8")).toBeLessThanOrEqual(512);
      expect(calls[0]!.message.content).not.toContain("�");
      expect(delivered.status).toEqual({ completed: expect.stringContaining("Answer truncated") });
      expect(delivered.message.details).toMatchObject({
        truncated: true,
        fullBytes: Buffer.byteLength(answer, "utf8"),
      });

      const artifact = delivered.message.details.fullAnswerFile;
      expect(artifact).toBe(join(temporaryDirectory, "child.final.txt"));
      await expect(readFile(artifact!, "utf8")).resolves.toBe(answer);
      expect((await stat(artifact!)).mode & 0o777).toBe(0o600);
    } finally {
      mailbox.shutdown();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("bounds error diagnostics without writing an answer artifact", async () => {
    const artifactWriter = vi.fn(async () => "/not-written");
    const result = await boundMailboxPayload(
      {
        sender: "/root/error",
        sessionFile: "/tmp/error.jsonl",
        status: { errored: `failure-${"🧯".repeat(500)}` },
      },
      { artifactWriter, maxMailboxBytes: 700, maxErrorBytes: 512 },
    );

    expect(result.truncated).toBe(true);
    expect(result.fullAnswerFile).toBeUndefined();
    expect(result.payload).toContain("Diagnostic truncated");
    expect(result.payload).not.toContain("�");
    expect(Buffer.byteLength(formatMailboxEnvelope("/root/error", result.payload), "utf8")).toBeLessThanOrEqual(700);
    expect(artifactWriter).not.toHaveBeenCalled();
  });
});

describe("RootMailbox delivery", () => {
  it("delivers once, wakes once, and chooses the safe idle delivery mode", async () => {
    const calls: DeliveryCall[] = [];
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, calls) });
    const input = {
      sender: "/root/tests",
      sessionFile: "/tmp/tests.jsonl",
      status: { completed: "finished" } as const,
      dedupeKey: "child-id:turn-id",
    };

    const [first, duplicate] = await Promise.all([
      mailbox.deliverFinal(input),
      mailbox.deliverFinal(input),
    ]);

    expect(first).toBe(duplicate);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      message: {
        customType: COLLABORATION_MAILBOX_TYPE,
        content: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/tests\nPayload:\nfinished",
        display: true,
        details: {
          sender: "/root/tests",
          taskName: "/root",
          status: { completed: "finished" },
          truncated: false,
          fullBytes: 8,
        },
      },
      options: { triggerTurn: false, deliverAs: "nextTurn" },
    });
    expect(mailbox.pendingWakeCount).toBe(1);
    await expect(mailbox.wait(10_000)).resolves.toEqual({
      message: "Agent /root/tests finished: completed",
      timed_out: false,
    });
    expect(mailbox.pendingWakeCount).toBe(0);
    expect(first.wakeSequence).toBe(1);
    mailbox.shutdown();
  });

  it("steers at a safe message boundary while root is streaming", async () => {
    const calls: DeliveryCall[] = [];
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(false, calls) });
    await mailbox.deliverFinal({
      sender: "/root/streaming",
      sessionFile: "/tmp/streaming.jsonl",
      status: { errored: "provider unavailable" },
    });

    expect(calls[0]!.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
    expect(calls[0]!.message.content).toContain("Child error: provider unavailable");
    mailbox.shutdown();
  });

  it("never includes unrelated raw monitor events in the root custom message", async () => {
    const calls: DeliveryCall[] = [];
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, calls) });
    const rawHumanOnlyMonitorState = {
      thinking_delta: "HIDDEN_REASONING_SENTINEL",
      toolOutput: "RAW_TOOL_OUTPUT_SENTINEL",
      partialText: "PARTIAL_TEXT_SENTINEL",
    };

    await mailbox.deliverFinal({
      sender: "/root/isolation",
      sessionFile: "/tmp/isolation.jsonl",
      status: { completed: "VISIBLE_FINAL_ONLY" },
    });

    expect(rawHumanOnlyMonitorState).toBeDefined();
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).toContain("VISIBLE_FINAL_ONLY");
    expect(serialized).not.toMatch(/HIDDEN_REASONING_SENTINEL|RAW_TOOL_OUTPUT_SENTINEL|PARTIAL_TEXT_SENTINEL/);
    mailbox.shutdown();
  });

  it("does not enqueue a wake when delivery fails and permits an idempotent retry", async () => {
    const calls: DeliveryCall[] = [];
    let fail = true;
    const mailbox = new RootMailbox({
      delivery: {
        isIdle: () => true,
        sendMessage(message, options) {
          calls.push({ message, options });
          if (fail) throw new Error("send failed");
        },
      },
    });
    const input = {
      sender: "/root/retry",
      sessionFile: "/tmp/retry.jsonl",
      status: { completed: "done" } as const,
      dedupeKey: "retry-turn",
    };

    await expect(mailbox.deliverFinal(input)).rejects.toThrow("send failed");
    expect(mailbox.pendingWakeCount).toBe(0);
    fail = false;
    await expect(mailbox.deliverFinal(input)).resolves.toMatchObject({ wakeSequence: 1 });
    expect(calls).toHaveLength(2);
    expect(mailbox.pendingWakeCount).toBe(1);
    mailbox.shutdown();
  });
});

describe("RootMailbox globally-consumable waits", () => {
  it("serves simultaneous waiters in FIFO order and leaves later waits pending", async () => {
    vi.useFakeTimers();
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, []) });
    const first = mailbox.wait(1_000);
    const second = mailbox.wait(1_000);
    const third = mailbox.wait(1_000);
    expect(mailbox.pendingWaiterCount).toBe(3);

    mailbox.enqueueWake("final", "first event");
    mailbox.enqueueWake("human_input", "second event");
    await expect(first).resolves.toEqual({ message: "first event", timed_out: false });
    await expect(second).resolves.toEqual({ message: "second event", timed_out: false });
    expect(mailbox.pendingWaiterCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(third).resolves.toEqual({
      message: "No collaboration events within 1000ms.",
      timed_out: true,
    });
    expect(mailbox.pendingWaiterCount).toBe(0);
    mailbox.shutdown();
  });

  it("queues events for one-time immediate consumption with monotonic sequences", async () => {
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, []), now: () => 44 });
    const first = mailbox.enqueueWake("final", "event one");
    const second = mailbox.enqueueWake("final", "event two");
    expect(first).toEqual({ sequence: 1, timestamp: 44, kind: "final", message: "event one" });
    expect(second.sequence).toBe(2);

    await expect(mailbox.wait(1_000)).resolves.toEqual({ message: "event one", timed_out: false });
    await expect(mailbox.wait(1_000)).resolves.toEqual({ message: "event two", timed_out: false });
    expect(mailbox.pendingWakeCount).toBe(0);
    mailbox.shutdown();
  });

  it("wakes only for interactive/rpc human input and ignores extension-generated input", async () => {
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, []) });
    expect(mailbox.notifyHumanInput("extension")).toBeUndefined();
    expect(mailbox.pendingWakeCount).toBe(0);

    expect(mailbox.notifyHumanInput("interactive")?.sequence).toBe(1);
    expect(mailbox.notifyHumanInput("rpc")?.sequence).toBe(2);
    await expect(mailbox.wait(1_000)).resolves.toEqual({
      message: "Human user input received from interactive.",
      timed_out: false,
    });
    await expect(mailbox.wait(1_000)).resolves.toEqual({
      message: "Human user input received from rpc.",
      timed_out: false,
    });
    mailbox.shutdown();
  });

  it("rejects on abort and removes both waiter and abort listener", async () => {
    vi.useFakeTimers();
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, []) });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const wait = mailbox.wait(10_000, controller.signal);
    expect(mailbox.pendingWaiterCount).toBe(1);

    controller.abort();
    await expect(wait).rejects.toBeInstanceOf(MailboxWaitAbortedError);
    expect(mailbox.pendingWaiterCount).toBe(0);
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));

    mailbox.enqueueWake("final", "still available");
    await expect(mailbox.wait(10_000)).resolves.toEqual({ message: "still available", timed_out: false });
    mailbox.shutdown();
  });

  it("resolves every pending waiter and removes abort listeners on idempotent shutdown", async () => {
    vi.useFakeTimers();
    const mailbox = new RootMailbox({ delivery: deliveryAdapter(true, []) });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRemove = vi.spyOn(firstController.signal, "removeEventListener");
    const secondRemove = vi.spyOn(secondController.signal, "removeEventListener");
    const first = mailbox.wait(10_000, firstController.signal);
    const second = mailbox.wait(20_000, secondController.signal);

    mailbox.shutdown();
    mailbox.shutdown();
    await expect(first).resolves.toEqual({ message: "Collaboration session shut down.", timed_out: false });
    await expect(second).resolves.toEqual({ message: "Collaboration session shut down.", timed_out: false });
    expect(mailbox.pendingWaiterCount).toBe(0);
    expect(firstRemove).toHaveBeenCalledTimes(1);
    expect(secondRemove).toHaveBeenCalledTimes(1);
    await expect(mailbox.wait(10_000)).resolves.toEqual({
      message: "Collaboration session shut down.",
      timed_out: false,
    });
    expect(() => mailbox.enqueueWake("final", "late")).toThrow(/shut down/);
  });
});
