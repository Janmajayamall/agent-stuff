import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { AgentStatus, SpawnAgentInput } from "../src/contracts.ts";
import type { ChildRuntimeSnapshot } from "../src/launch-config.ts";
import {
  CollaborationRegistry,
  type RegistryDependencies,
  type WorkerFactoryOptions,
} from "../src/registry.ts";
import {
  RpcDeliveryRacedSettlementError,
  type ExpectedRpcState,
  type RpcChildWorker,
  type RpcExitInfo,
  type RpcInterruptResult,
  type SanitizedRpcEvent,
  type WorkerToken,
} from "../src/rpc-child.ts";

describe("CollaborationRegistry target and capacity rules", () => {
  it("resolves a short name, canonical path, and internal id", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("alpha"));
    const record = harness.registry.children()[0]!;
    const worker = harness.workers[0]!;

    await expect(harness.registry.sendMessage("alpha", "one")).resolves.toEqual({
      target: "/root/alpha",
      delivery: "steered",
    });
    await expect(harness.registry.sendMessage("/root/alpha", "two")).resolves.toEqual({
      target: "/root/alpha",
      delivery: "steered",
    });
    await expect(harness.registry.sendMessage(record.id, "three")).resolves.toEqual({
      target: "/root/alpha",
      delivery: "steered",
    });
    expect(worker.steers.map(payloadOf)).toEqual(["one", "two", "three"]);
    await expect(harness.registry.sendMessage("missing", "no")).rejects.toThrow(/unknown agent/);
    await expect(harness.registry.sendMessage("/root", "no")).rejects.toThrow(/cannot target itself/);
  });

  it("detects an identifier/name collision as ambiguous", async () => {
    const harness = createHarness({ ids: ["collision", "turn-a", "child-b", "turn-b"] });
    await harness.registry.spawn(spawnInput("alpha"));
    await harness.registry.spawn(spawnInput("collision"));

    await expect(harness.registry.sendMessage("collision", "ambiguous")).rejects.toThrow(
      /ambiguous agent target/,
    );
  });

  it("reserves a task name for the registry lifetime after completion", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("unique"));
    harness.workers[0]!.complete("done");
    await flushMicrotasks();

    await expect(harness.registry.spawn(spawnInput("unique"))).rejects.toThrow(/already reserved/);
    expect(harness.registry.children()).toHaveLength(1);
  });

  it("atomically admits three active starts, rejects a fourth, and releases a slot once", async () => {
    const harness = createHarness();
    await Promise.all([
      harness.registry.spawn(spawnInput("one")),
      harness.registry.spawn(spawnInput("two")),
      harness.registry.spawn(spawnInput("three")),
    ]);
    expect(harness.registry.activeTurnCount).toBe(3);

    await expect(harness.registry.spawn(spawnInput("four"))).rejects.toThrow(
      /all 3 child turn slots are active/,
    );

    const first = harness.workers[0]!;
    first.complete("done");
    first.settle();
    expect(harness.registry.activeTurnCount).toBe(2);
    await harness.registry.spawn(spawnInput("four"));
    expect(harness.registry.activeTurnCount).toBe(3);

    // Duplicate terminal callbacks from the first worker cannot release a
    // slot now owned by the fourth child.
    first.settle();
    first.unexpectedExit(new Error("late exit"));
    expect(harness.registry.activeTurnCount).toBe(3);
  });

  it("includes root, sorts deterministically, and applies canonical prefix filtering", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("zeta"));
    await harness.registry.spawn(spawnInput("alpha"));

    expect(harness.registry.listAgents().agents.map((agent) => agent.agent_name)).toEqual([
      "/root",
      "/root/alpha",
      "/root/zeta",
    ]);
    expect(harness.registry.listAgents("/root/a").agents).toEqual([
      { agent_name: "/root/alpha", agent_status: "running" },
    ]);
    expect(harness.registry.listAgents("no-match").agents).toEqual([]);
    expect(() => harness.registry.listAgents("/root/")).toThrow(/must not end/);
    expect(() => harness.registry.listAgents(" ")).toThrow(/non-whitespace/);
  });
});

describe("CollaborationRegistry start and settlement lifecycle", () => {
  it("does not resolve spawn until worker state and prompt readiness complete", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate }] });
    let resolved = false;
    const spawning = harness.registry.spawn(spawnInput("slow")).then((result) => {
      resolved = true;
      return result;
    });

    await flushMicrotasks();
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.started).toBe(true);
    expect(harness.workers[0]!.verifiedStates).toHaveLength(1);
    expect(resolved).toBe(false);
    expect(harness.registry.children()[0]!.status).toBe("pending_init");

    promptGate.resolve();
    await expect(spawning).resolves.toEqual({ task_name: "/root/slow" });
    expect(harness.registry.children()[0]!.status).toBe("running");
  });

  it("allows an initializing worker to be interrupted before prompt readiness", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate }] });
    const spawning = harness.registry.spawn(spawnInput("initializing"));
    await flushMicrotasks();
    const interrupting = harness.registry.interruptAgent("initializing");
    await flushMicrotasks();

    // Capture the observation before releasing readiness, but clean up both
    // public calls before asserting so a regression never leaves a live test.
    const interruptCallsBeforeReadiness = harness.workers[0]!.interruptCalls;
    promptGate.resolve();
    await spawning;
    const interruptResult = await interrupting;

    expect(interruptCallsBeforeReadiness).toBe(1);
    expect(interruptResult.previous_status).toBe("pending_init");
  });

  it("retains an initializing child and its session when interruption prevents prompt readiness", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness({
      workerPlans: [
        {
          promptGate,
          onInterrupt(worker) {
            worker.settle();
            promptGate.reject(new Error("prompt cancelled before readiness"));
          },
        },
      ],
    });
    const spawning = harness.registry.spawn(spawnInput("cancelled_start"));
    await flushMicrotasks();

    await expect(harness.registry.interruptAgent("cancelled_start")).resolves.toEqual({
      target: "/root/cancelled_start",
      previous_status: "pending_init",
    });
    await expect(spawning).rejects.toThrow("prompt cancelled before readiness");
    await flushMicrotasks();

    expect(harness.registry.children()).toHaveLength(1);
    expect(harness.registry.children()[0]!.status).toBe("interrupted");
    expect(harness.registry.children()[0]!.sessionFile).toBe("/sessions/id-1.jsonl");
    expect(harness.removedSessions).toEqual([]);
    expect(harness.registry.activeTurnCount).toBe(0);
  });

  it("coalesces repeated concurrent interrupts of the same initializing worker", async () => {
    const promptGate = deferred<void>();
    const interruptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate, interruptGate }] });
    const spawning = harness.registry.spawn(spawnInput("interrupt_once"));
    await flushMicrotasks();

    const first = harness.registry.interruptAgent("interrupt_once");
    const second = harness.registry.interruptAgent("interrupt_once");
    await flushMicrotasks();
    const callsBeforeRelease = harness.workers[0]!.interruptCalls;

    interruptGate.resolve();
    promptGate.resolve();
    await Promise.all([first, second, spawning]);

    expect(callsBeforeRelease).toBe(1);
    expect(harness.workers[0]!.interruptCalls).toBe(1);
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.deliveries).toHaveLength(1);
  });

  it("clears rejected coalesced interrupt ownership before a later natural settlement", async () => {
    const promptGate = deferred<void>();
    const interruptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate, interruptGate }] });
    const spawning = harness.registry.spawn(spawnInput("interrupt_rejected"));
    await flushMicrotasks();

    const first = harness.registry.interruptAgent("interrupt_rejected");
    const second = harness.registry.interruptAgent("interrupt_rejected");
    const interruptOutcomes = Promise.allSettled([first, second]);
    await flushMicrotasks();

    interruptGate.reject(new Error("abort transport failed"));
    const outcomes = await interruptOutcomes;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(harness.workers[0]!.interruptCalls).toBe(1);

    promptGate.resolve();
    await spawning;
    harness.workers[0]!.complete("natural completion");
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toEqual({ completed: "natural completion" });
  });

  it("waits for an owned initializing interrupt before deciding whether startup rolls back", async () => {
    const promptGate = deferred<void>();
    const interruptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate, interruptGate }] });
    const spawning = harness.registry.spawn(spawnInput("interrupt_start_race"));
    const spawnOutcome = spawning.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();

    const interrupting = harness.registry.interruptAgent("interrupt_start_race");
    await flushMicrotasks();
    promptGate.reject(new Error("prompt cancelled before abort settled"));
    await flushMicrotasks();
    interruptGate.resolve();

    await expect(interrupting).resolves.toEqual({
      target: "/root/interrupt_start_race",
      previous_status: "pending_init",
    });
    expect(await spawnOutcome).toMatchObject({ message: "prompt cancelled before abort settled" });
    expect(harness.registry.children()).toHaveLength(1);
    expect(harness.registry.children()[0]!.status).toBe("interrupted");
    expect(harness.removedSessions).toEqual([]);
    expect(harness.deliveries).toHaveLength(1);
  });

  it("retains interruption when an inactive follow-up is cancelled before readiness", async () => {
    const restartPromptGate = deferred<void>();
    const harness = createHarness({
      workerPlans: [
        {},
        {
          promptGate: restartPromptGate,
          onInterrupt(worker) {
            worker.settle();
            restartPromptGate.reject(new Error("restart cancelled before readiness"));
          },
        },
      ],
    });
    await harness.registry.spawn(spawnInput("cancelled_restart"));
    harness.workers[0]!.complete("first turn");
    harness.workers[0]!.close();
    await flushMicrotasks();
    const following = harness.registry.followupTask("cancelled_restart", "second turn");
    await flushMicrotasks();

    await expect(harness.registry.interruptAgent("cancelled_restart")).resolves.toEqual({
      target: "/root/cancelled_restart",
      previous_status: "pending_init",
    });
    await expect(following).rejects.toThrow("restart cancelled before readiness");

    expect(harness.registry.children()[0]!.status).toBe("interrupted");
    expect(harness.registry.children()[0]!.sessionFile).toBe("/sessions/id-1.jsonl");
    expect(harness.registry.activeTurnCount).toBe(0);
  });

  it("preserves a rapid terminal status when settlement precedes readiness observation", async () => {
    const harness = createHarness({
      workerPlans: [
        {
          onPrompt(worker) {
            worker.complete("rapid answer");
          },
        },
      ],
    });

    await expect(harness.registry.spawn(spawnInput("rapid"))).resolves.toEqual({
      task_name: "/root/rapid",
    });
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toEqual({ completed: "rapid answer" });
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]!.payload).toBe("rapid answer");
  });

  it("rolls back a worker startup failure, session artifact, registry entry, and slot", async () => {
    const harness = createHarness({ workerPlans: [{ verifyError: new Error("state mismatch") }] });

    await expect(harness.registry.spawn(spawnInput("broken"))).rejects.toThrow("state mismatch");
    expect(harness.registry.children()).toEqual([]);
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.removedSessions).toEqual(["/sessions/id-1.jsonl"]);
    expect(harness.workers[0]!.shutdownCalls).toBe(1);
  });

  it("restores an inactive child after restart preflight failure without a false terminal mailbox", async () => {
    const harness = createHarness({ workerPlans: [{}, { verifyError: new Error("restart mismatch") }] });
    await harness.registry.spawn(spawnInput("retry"));
    harness.workers[0]!.complete("prior answer");
    harness.workers[0]!.close();
    await flushMicrotasks();
    const deliveriesBefore = harness.deliveries.length;
    await harness.registry.sendMessage("retry", "preserve me");

    await expect(harness.registry.followupTask("retry", "try again")).rejects.toThrow(
      "restart mismatch",
    );
    await flushMicrotasks();

    const record = harness.registry.children()[0]!;
    expect(record.status).toEqual({ completed: "prior answer" });
    expect(record.queuedMessages.map((entry) => entry.message)).toEqual(["preserve me"]);
    expect(record.worker).toBeUndefined();
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.deliveries).toHaveLength(deliveriesBefore);
  });

  it("rejects a queued operation whose pending spawn rolled back instead of accepting a stale record", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate }] });
    const spawning = harness.registry.spawn(spawnInput("vanishing"));
    await flushMicrotasks();
    const sending = harness.registry.sendMessage("vanishing", "must not be accepted").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );

    promptGate.reject(new Error("prompt preflight failed"));
    await expect(spawning).rejects.toThrow("prompt preflight failed");

    expect(await sending).toBe("rejected");
    expect(harness.registry.children()).toEqual([]);
  });

  it("maps an unexpected active-worker exit once and releases capacity", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("crash"));
    const worker = harness.workers[0]!;

    worker.unexpectedExit(new Error("worker disappeared"));
    worker.unexpectedExit(new Error("duplicate"));
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toEqual({ errored: "worker disappeared" });
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.deliveries).toHaveLength(1);
  });

  it("emits one terminal mailbox across real unexpected-exit callback ordering", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("crash_once"));
    const worker = harness.workers[0]!;

    worker.unexpectedExit(new Error("process exited"));
    worker.close(exitInfo(false, "stderr detail"));
    worker.settle();
    await flushMicrotasks();

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.registry.children()[0]!.status).toEqual({ errored: "process exited" });
    expect(harness.registry.children()[0]!.worker).toBeUndefined();
    expect(harness.registry.activeTurnCount).toBe(0);
  });

  it("treats an unexpected exit before readiness as startup rollback, not a final mailbox", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate }] });
    const spawning = harness.registry.spawn(spawnInput("early_exit"));
    await flushMicrotasks();
    const worker = harness.workers[0]!;

    worker.unexpectedExit(new Error("exited before readiness"));
    worker.close(exitInfo(false, "startup stderr"));
    promptGate.reject(new Error("prompt never became ready"));
    await expect(spawning).rejects.toThrow("prompt never became ready");
    await flushMicrotasks();

    expect(harness.registry.children()).toEqual([]);
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.removedSessions).toEqual(["/sessions/id-1.jsonl"]);
    expect(harness.deliveries).toEqual([]);
  });

  it("ignores callbacks whose full child/turn/generation token is stale", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("reuse"));
    const oldWorker = harness.workers[0]!;
    oldWorker.complete("turn one");
    oldWorker.close();
    await flushMicrotasks();
    await harness.registry.followupTask("reuse", "turn two");
    const newWorker = harness.workers[1]!;
    const monitorCount = harness.monitors[0]!.length;
    const deliveryCount = harness.deliveries.length;

    oldWorker.options.onEvent({ type: "message_update" } as SanitizedRpcEvent, oldWorker.token);
    oldWorker.options.onSettled(oldWorker.token);
    oldWorker.options.onUnexpectedExit(new Error("stale"), oldWorker.token);
    oldWorker.options.onExit(exitInfo(false, "stale stderr"), oldWorker.token);
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toBe("running");
    expect(harness.registry.children()[0]!.workerGeneration).toBe(2);
    expect(harness.monitors[0]).toHaveLength(monitorCount);
    expect(harness.deliveries).toHaveLength(deliveryCount);
    expect(harness.registry.activeTurnCount).toBe(1);
    expect(newWorker.started).toBe(true);
  });

  it("does not let an older mailbox completion overwrite the newer turn's answer artifact", async () => {
    const firstDelivery = deferred<DeliveryResult>();
    const secondDelivery = deferred<DeliveryResult>();
    const harness = createHarness({ deliveryGates: [firstDelivery, secondDelivery] });
    await harness.registry.spawn(spawnInput("artifact_race"));
    harness.workers[0]!.complete("first full answer");
    harness.workers[0]!.close();
    await flushMicrotasks();

    await harness.registry.followupTask("artifact_race", "second turn");
    harness.workers[1]!.complete("second full answer");
    await flushMicrotasks();

    secondDelivery.resolve({
      status: { completed: "second bounded answer" },
      fullAnswerFile: "/sessions/second.final.txt",
    });
    await flushMicrotasks();
    expect(harness.registry.children()[0]!.finalAnswerFile).toBe("/sessions/second.final.txt");

    firstDelivery.resolve({
      status: { completed: "first bounded answer" },
      fullAnswerFile: "/sessions/first.final.txt",
    });
    await flushMicrotasks();

    const record = harness.registry.children()[0]!;
    expect(record.status).toEqual({ completed: "second bounded answer" });
    expect(record.finalAnswerFile).toBe("/sessions/second.final.txt");
  });

  it("does not let an older mailbox failure overwrite newer-turn activity", async () => {
    const firstDelivery = deferred<DeliveryResult>();
    const harness = createHarness({ deliveryGates: [firstDelivery] });
    await harness.registry.spawn(spawnInput("mailbox_failure_race"));
    harness.workers[0]!.complete("first answer");
    harness.workers[0]!.close();
    await flushMicrotasks();
    await harness.registry.followupTask("mailbox_failure_race", "second turn");
    expect(harness.registry.children()[0]!.lastActivity).toBe("running");

    firstDelivery.reject(new Error("old mailbox failed"));
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toBe("running");
    expect(harness.registry.children()[0]!.lastActivity).toBe("running");
  });

  it("appends exactly one final monitor event when mailbox delivery creates an artifact", async () => {
    const delivery = deferred<DeliveryResult>();
    const harness = createHarness({ deliveryGates: [delivery] });
    await harness.registry.spawn(spawnInput("monitor_final_once"));
    harness.workers[0]!.complete("large answer");
    await flushMicrotasks();
    expect(harness.finalMonitorEvents).toHaveLength(1);

    delivery.resolve({
      status: { completed: "bounded answer" },
      fullAnswerFile: "/sessions/id-1.final.txt",
    });
    await flushMicrotasks();

    expect(harness.finalMonitorEvents).toHaveLength(1);
    expect(harness.registry.children()[0]!.finalAnswerFile).toBe("/sessions/id-1.final.txt");
  });

  it("clears a prior truncated-answer artifact when a later short turn completes", async () => {
    const firstDelivery = deferred<DeliveryResult>();
    const harness = createHarness({ deliveryGates: [firstDelivery] });
    await harness.registry.spawn(spawnInput("artifact_then_short"));
    harness.workers[0]!.complete("large first answer");
    firstDelivery.resolve({
      status: { completed: "bounded first answer" },
      fullAnswerFile: "/sessions/id-1.final.txt",
    });
    await flushMicrotasks();
    expect(harness.registry.children()[0]!.finalAnswerFile).toBe("/sessions/id-1.final.txt");
    harness.workers[0]!.close();

    await harness.registry.followupTask("artifact_then_short", "short second turn");
    harness.workers[1]!.complete("short answer");
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toEqual({ completed: "short answer" });
    expect(harness.registry.children()[0]!.finalAnswerFile).toBeUndefined();
  });

  it("restores a pending prior artifact result when a later restart fails", async () => {
    const firstDelivery = deferred<DeliveryResult>();
    const harness = createHarness({
      deliveryGates: [firstDelivery],
      workerPlans: [{}, { verifyError: new Error("restart failed") }],
    });
    await harness.registry.spawn(spawnInput("artifact_failed_restart"));
    harness.workers[0]!.complete("large first answer");
    harness.workers[0]!.close();
    await flushMicrotasks();

    await expect(
      harness.registry.followupTask("artifact_failed_restart", "failing second turn"),
    ).rejects.toThrow("restart failed");
    firstDelivery.resolve({
      status: { completed: "bounded first answer" },
      fullAnswerFile: "/sessions/id-1.final.txt",
    });
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toEqual({ completed: "bounded first answer" });
    expect(harness.registry.children()[0]!.finalAnswerFile).toBe("/sessions/id-1.final.txt");
  });

});

describe("CollaborationRegistry send and follow-up routing", () => {
  it("steers an active worker with a literal MESSAGE envelope", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("worker"));

    await expect(harness.registry.sendMessage("worker", "/literal-command")).resolves.toEqual({
      target: "/root/worker",
      delivery: "steered",
    });
    const envelope = harness.workers[0]!.steers[0]!;
    expect(envelope.startsWith("Message Type: MESSAGE\n")).toBe(true);
    expect(envelope).toContain("Recipient: /root/worker");
    expect(envelope.endsWith("Payload:\n/literal-command")).toBe(true);
  });

  it("queues an informational message for an inactive live child without creating a worker", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("worker"));
    harness.workers[0]!.complete("done");
    await flushMicrotasks();

    await expect(harness.registry.sendMessage("worker", "remember this")).resolves.toEqual({
      target: "/root/worker",
      delivery: "queued",
    });
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.steers).toEqual([]);
    expect(harness.registry.children()[0]!.queuedMessages.map((entry) => entry.message)).toEqual([
      "remember this",
    ]);
  });

  it("reroutes an unacknowledged steer that races settlement to the inactive inbox", async () => {
    const steerGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ steerGate }] });
    await harness.registry.spawn(spawnInput("worker"));
    const worker = harness.workers[0]!;
    const sending = harness.registry.sendMessage("worker", "do not lose this");
    await flushMicrotasks();

    worker.complete("done");
    steerGate.reject(new RpcDeliveryRacedSettlementError("steer", "steer-1"));
    worker.close();

    await expect(sending).resolves.toEqual({ target: "/root/worker", delivery: "queued" });
    expect(harness.registry.children()[0]!.queuedMessages.map((entry) => entry.message)).toEqual([
      "do not lose this",
    ]);
  });

  it("uses active follow_up without opening a second worker", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("worker"));

    await expect(harness.registry.followupTask("worker", "continue now")).resolves.toEqual({
      target: "/root/worker",
      delivery: "follow_up",
    });
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.followUps[0]).toMatch(/^Message Type: FOLLOW_UP\n/);
    expect(harness.workers[0]!.followUps[0]).toContain("Payload:\ncontinue now");
  });

  it("waits for old-worker close, reuses the session, and drains queued messages FIFO", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("worker"));
    const oldWorker = harness.workers[0]!;
    oldWorker.complete("done");
    await flushMicrotasks();
    await harness.registry.sendMessage("worker", "first information");
    await harness.registry.sendMessage("worker", "/second-information");

    let followupResolved = false;
    const following = harness.registry.followupTask("worker", "new executable task").then((result) => {
      followupResolved = true;
      return result;
    });
    await flushMicrotasks();
    expect(harness.workers).toHaveLength(1);
    expect(followupResolved).toBe(false);

    oldWorker.close();
    await expect(following).resolves.toEqual({ target: "/root/worker", delivery: "started" });
    const restarted = harness.workers[1]!;
    expect(restarted.verifiedStates[0]!.sessionFile).toBe("/sessions/id-1.jsonl");
    const prompt = restarted.prompts[0]!;
    expect(prompt.indexOf("Payload:\nfirst information")).toBeLessThan(
      prompt.indexOf("Payload:\n/second-information"),
    );
    expect(prompt.indexOf("Payload:\n/second-information")).toBeLessThan(
      prompt.indexOf("Payload:\nnew executable task"),
    );
    expect(prompt.match(/Message Type: MESSAGE/g)).toHaveLength(2);
    expect(prompt.match(/Message Type: TASK/g)).toHaveLength(1);
    expect(harness.registry.children()[0]!.queuedMessages).toEqual([]);
  });

  it("reroutes a follow_up settlement race onto a new worker after close", async () => {
    const followupGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ followupGate }] });
    await harness.registry.spawn(spawnInput("worker"));
    const oldWorker = harness.workers[0]!;
    const following = harness.registry.followupTask("worker", "must run next");
    await flushMicrotasks();

    oldWorker.complete("old done");
    followupGate.reject(new RpcDeliveryRacedSettlementError("follow_up", "follow-1"));
    oldWorker.close();

    await expect(following).resolves.toEqual({ target: "/root/worker", delivery: "started" });
    expect(harness.workers).toHaveLength(2);
    expect(harness.workers[1]!.prompts[0]).toMatch(/^Message Type: TASK\n/);
    expect(harness.workers[1]!.prompts[0]).toContain("Payload:\nmust run next");
  });

  it("serializes parallel inactive follow-ups so only one new process is created", async () => {
    const restartGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{}, { promptGate: restartGate }] });
    await harness.registry.spawn(spawnInput("worker"));
    harness.workers[0]!.complete("done");
    harness.workers[0]!.close();
    await flushMicrotasks();

    const first = harness.registry.followupTask("worker", "first task");
    const second = harness.registry.followupTask("worker", "second task");
    await flushMicrotasks();
    expect(harness.workers).toHaveLength(2);
    expect(harness.workers[1]!.followUps).toEqual([]);

    restartGate.resolve();
    await expect(first).resolves.toEqual({ target: "/root/worker", delivery: "started" });
    await expect(second).resolves.toEqual({ target: "/root/worker", delivery: "follow_up" });
    expect(harness.workers).toHaveLength(2);
    expect(harness.workers[1]!.followUps.map(payloadOf)).toEqual(["second task"]);
  });

  it("rejects an inactive restart when three other turns own capacity", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("inactive"));
    harness.workers[0]!.complete("done");
    harness.workers[0]!.close();
    await flushMicrotasks();
    await Promise.all([
      harness.registry.spawn(spawnInput("one")),
      harness.registry.spawn(spawnInput("two")),
      harness.registry.spawn(spawnInput("three")),
    ]);

    await expect(harness.registry.followupTask("inactive", "cannot start")).rejects.toThrow(
      /all 3 child turn slots are active/,
    );
    expect(harness.registry.children().find((record) => record.taskName === "inactive")!.status).toEqual({
      completed: "done",
    });
  });
});

describe("CollaborationRegistry interruption and shutdown", () => {
  it("owns interruption before awaiting abort and finalizes exactly once", async () => {
    const harness = createHarness({
      workerPlans: [
        {
          onInterrupt(worker) {
            worker.settle();
          },
        },
      ],
    });
    await harness.registry.spawn(spawnInput("worker"));

    await expect(harness.registry.interruptAgent("worker")).resolves.toEqual({
      target: "/root/worker",
      previous_status: "running",
    });
    await flushMicrotasks();
    expect(harness.registry.children()[0]!.status).toBe("interrupted");
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.workers[0]!.interruptCalls).toBe(1);
    expect(harness.deliveries).toHaveLength(1);
  });

  it("clears rejected running-turn interrupt ownership before natural settlement", async () => {
    const interruptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ interruptGate }] });
    await harness.registry.spawn(spawnInput("running_interrupt_rejected"));

    const interrupting = harness.registry.interruptAgent("running_interrupt_rejected");
    interruptGate.reject(new Error("abort transport failed"));
    await expect(interrupting).rejects.toThrow("abort transport failed");

    harness.workers[0]!.complete("natural completion");
    await flushMicrotasks();

    expect(harness.registry.children()[0]!.status).toEqual({ completed: "natural completion" });
  });

  it("returns an inactive child's previous status without starting or interrupting work", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("worker"));
    harness.workers[0]!.complete("done");
    await flushMicrotasks();

    await expect(harness.registry.interruptAgent("worker")).resolves.toEqual({
      target: "/root/worker",
      previous_status: { completed: "done" },
    });
    expect(harness.workers[0]!.interruptCalls).toBe(0);
    expect(harness.workers).toHaveLength(1);
  });

  it("shuts workers down, releases slots, clears state, and ignores all late callbacks", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("one"));
    await harness.registry.spawn(spawnInput("two"));
    const workers = [...harness.workers];
    const deliveriesBefore = harness.deliveries.length;

    await harness.registry.dispose();

    expect(harness.registry.isDisposed).toBe(true);
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.registry.children()).toEqual([]);
    expect(workers.map((worker) => worker.shutdownCalls)).toEqual([1, 1]);
    expect(() => harness.registry.listAgents()).toThrow(/shut down/);
    await expect(harness.registry.spawn(spawnInput("late"))).rejects.toThrow(/shut down/);

    for (const worker of workers) {
      worker.options.onEvent({ type: "message_update" } as SanitizedRpcEvent, worker.token);
      worker.options.onSettled(worker.token);
      worker.options.onUnexpectedExit(new Error("late"), worker.token);
    }
    await flushMicrotasks();
    expect(harness.deliveries).toHaveLength(deliveriesBefore);
  });

  it("does not restart a terminal child after shutdown wins the old-worker close race", async () => {
    const harness = createHarness();
    await harness.registry.spawn(spawnInput("closing"));
    harness.workers[0]!.complete("done");
    await flushMicrotasks();
    const following = harness.registry.followupTask("closing", "must not restart").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await flushMicrotasks();
    expect(harness.workers).toHaveLength(1);

    await harness.registry.dispose();
    const followupOutcome = await following;

    expect(followupOutcome).toBe("rejected");
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.shutdownCalls).toBe(1);
  });

  it("cleans an allocation that finishes after shutdown instead of leaking an orphan JSONL", async () => {
    const allocationGate = deferred<void>();
    const harness = createHarness({ allocationGate });
    const spawning = harness.registry.spawn(spawnInput("allocation_race"));
    await flushMicrotasks();
    expect(harness.allocationCalls).toEqual(["id-1"]);

    await harness.registry.dispose();
    allocationGate.resolve();
    await expect(spawning).rejects.toThrow(/shut down|stale/);

    expect(harness.workers).toEqual([]);
    expect(harness.removedSessions).toEqual(["/sessions/id-1.jsonl"]);
  });

  it("preserves an already-allocated child session when root shutdown interrupts initialization", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate }] });
    const spawning = harness.registry.spawn(spawnInput("shutdown_pending"));
    await flushMicrotasks();
    expect(harness.workers).toHaveLength(1);

    await harness.registry.dispose();
    promptGate.reject(new Error("worker closed for root shutdown"));
    await expect(spawning).rejects.toThrow("worker closed for root shutdown");

    expect(harness.removedSessions).toEqual([]);
  });

  it("does not finalize or emit a mailbox when dispose overtakes an in-flight interrupt", async () => {
    const interruptGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ interruptGate }] });
    await harness.registry.spawn(spawnInput("dispose_interrupt"));
    const interrupting = harness.registry.interruptAgent("dispose_interrupt");
    await flushMicrotasks();
    expect(harness.workers[0]!.interruptCalls).toBe(1);

    await harness.registry.dispose();
    const deliveryCountAtDispose = harness.deliveries.length;
    interruptGate.resolve();
    await interrupting;
    await flushMicrotasks();

    expect(harness.registry.children()).toEqual([]);
    expect(harness.registry.activeTurnCount).toBe(0);
    expect(harness.deliveries).toHaveLength(deliveryCountAtDispose);
  });

  it("ignores a pending-init interrupt rejection that arrives during dispose", async () => {
    const promptGate = deferred<void>();
    const interruptGate = deferred<void>();
    const shutdownGate = deferred<void>();
    const harness = createHarness({ workerPlans: [{ promptGate, interruptGate, shutdownGate }] });
    const spawning = harness.registry.spawn(spawnInput("dispose_rejected_interrupt"));
    const spawnOutcome = spawning.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();
    const record = harness.registry.children()[0]!;

    const interrupting = harness.registry.interruptAgent("dispose_rejected_interrupt");
    const interruptOutcome = interrupting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();
    const disposing = harness.registry.dispose();
    await flushMicrotasks();
    expect(record.status).toBe("shutdown");
    const activityAtDispose = record.lastActivity;

    interruptGate.reject(new Error("abort failed during shutdown"));
    expect(await interruptOutcome).toMatchObject({ message: "abort failed during shutdown" });
    expect(record.status).toBe("shutdown");
    expect(record.lastActivity).toBe(activityAtDispose);

    shutdownGate.resolve();
    await disposing;
    promptGate.reject(new Error("prompt closed during shutdown"));
    await spawnOutcome;
  });

  it("clears deferred restart bookkeeping from records retired by dispose", async () => {
    const firstDelivery = deferred<DeliveryResult>();
    const restartPromptGate = deferred<void>();
    const harness = createHarness({
      deliveryGates: [firstDelivery],
      workerPlans: [{}, { promptGate: restartPromptGate }],
    });
    await harness.registry.spawn(spawnInput("dispose_restart_state"));
    const record = harness.registry.children()[0]!;
    const firstTurnId = record.activeTurnId;
    harness.workers[0]!.complete("first answer");
    harness.workers[0]!.close();
    await flushMicrotasks();

    const following = harness.registry.followupTask("dispose_restart_state", "second task");
    const followupOutcome = following.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();
    expect(record.restorableTurnId).toBe(firstTurnId);

    firstDelivery.resolve({
      status: { completed: "bounded first answer" },
      fullAnswerFile: "/sessions/id-1.final.txt",
    });
    await flushMicrotasks();
    expect(record.deferredDelivery).toMatchObject({ turnId: firstTurnId });

    await harness.registry.dispose();
    restartPromptGate.reject(new Error("restart stopped by shutdown"));
    expect(await followupOutcome).toMatchObject({ message: "restart stopped by shutdown" });

    expect(record.restorableTurnId).toBeUndefined();
    expect(record.deferredDelivery).toBeUndefined();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeWorkerPlan {
  verifyGate?: Deferred<void>;
  verifyError?: Error;
  promptGate?: Deferred<void>;
  promptError?: Error;
  steerGate?: Deferred<void>;
  followupGate?: Deferred<void>;
  interruptGate?: Deferred<void>;
  shutdownGate?: Deferred<void>;
  onPrompt?: (worker: FakeWorker) => void;
  onInterrupt?: (worker: FakeWorker) => void;
}

class FakeWorker {
  readonly token: WorkerToken;
  readonly closed: Promise<RpcExitInfo>;
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  readonly verifiedStates: ExpectedRpcState[] = [];
  started = false;
  isClosed = false;
  isSettled = false;
  interruptCalls = 0;
  shutdownCalls = 0;
  private readonly closedDeferred = deferred<RpcExitInfo>();

  constructor(
    readonly options: WorkerFactoryOptions,
    private readonly plan: FakeWorkerPlan,
  ) {
    this.token = options.token;
    this.closed = this.closedDeferred.promise;
  }

  start(): this {
    this.started = true;
    return this;
  }

  async verifyState(expected: ExpectedRpcState): Promise<RpcSessionState> {
    this.verifiedStates.push(expected);
    if (this.plan.verifyError) throw this.plan.verifyError;
    if (this.plan.verifyGate) await this.plan.verifyGate.promise;
    return {} as RpcSessionState;
  }

  async promptAndWaitForStart(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    this.plan.onPrompt?.(this);
    if (this.plan.promptError) throw this.plan.promptError;
    if (this.plan.promptGate) await this.plan.promptGate.promise;
  }

  async steer(message: string): Promise<void> {
    this.steers.push(message);
    if (this.plan.steerGate) await this.plan.steerGate.promise;
  }

  async followUp(message: string): Promise<void> {
    this.followUps.push(message);
    if (this.plan.followupGate) await this.plan.followupGate.promise;
  }

  async interrupt(): Promise<RpcInterruptResult> {
    this.interruptCalls += 1;
    this.plan.onInterrupt?.(this);
    if (this.plan.interruptGate) await this.plan.interruptGate.promise;
    return { settled: this.isSettled, exited: this.isClosed, abortAcknowledged: true };
  }

  async shutdown(): Promise<RpcExitInfo> {
    this.shutdownCalls += 1;
    if (this.plan.shutdownGate) await this.plan.shutdownGate.promise;
    if (!this.isClosed) this.close({ ...exitInfo(this.isSettled), expected: true });
    return this.closed;
  }

  emit(event: SanitizedRpcEvent): void {
    this.options.onEvent(event, this.token);
  }

  complete(text: string | null, stopReason = "stop", errorMessage?: string): void {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: text === null ? [] : [{ type: "text", text }],
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    } as SanitizedRpcEvent);
    this.settle();
  }

  settle(): void {
    this.isSettled = true;
    this.options.onSettled(this.token);
  }

  unexpectedExit(error: Error): void {
    this.options.onUnexpectedExit(error, this.token);
  }

  close(exit: RpcExitInfo = exitInfo(this.isSettled)): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closedDeferred.resolve(exit);
    this.options.onExit(exit, this.token);
  }
}

interface HarnessOptions {
  ids?: string[];
  workerPlans?: FakeWorkerPlan[];
  snapshotError?: Error;
  allocationError?: Error;
  allocationGate?: Deferred<void>;
  deliveryGates?: Deferred<DeliveryResult>[];
}

interface Delivery {
  path: string;
  status: AgentStatus;
  payload: string;
}

interface FinalMonitorEvent {
  status: AgentStatus;
  summary: string;
  fullAnswerFile?: string;
}

interface DeliveryResult {
  status?: AgentStatus;
  fullAnswerFile?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const workers: FakeWorker[] = [];
  const monitors: SanitizedRpcEvent[][] = [];
  const deliveries: Delivery[] = [];
  const finalMonitorEvents: FinalMonitorEvent[] = [];
  const removedSessions: string[] = [];
  const allocationCalls: string[] = [];
  const workerPlans = [...(options.workerPlans ?? [])];
  const deliveryGates = [...(options.deliveryGates ?? [])];
  const ids = [...(options.ids ?? [])];
  let idSequence = 0;
  let messageSequence = 0;
  let now = 1_000;
  const runtime: ChildRuntimeSnapshot = {
    provider: "test-provider",
    modelId: "test-model",
    thinkingLevel: "medium" as ThinkingLevel,
    activeTools: ["read"],
    extensionPaths: [],
    cwd: "/workspace",
    projectTrusted: true,
  };

  const dependencies: RegistryDependencies<SanitizedRpcEvent[]> = {
    async allocateSession(childId) {
      if (options.allocationError) throw options.allocationError;
      allocationCalls.push(childId);
      if (options.allocationGate) await options.allocationGate.promise;
      return { sessionFile: `/sessions/${childId}.jsonl` };
    },
    async removeFailedSession(sessionFile) {
      removedSessions.push(sessionFile);
    },
    async snapshotRuntime(_input: SpawnAgentInput) {
      if (options.snapshotError) throw options.snapshotError;
      return runtime;
    },
    buildLaunch(record) {
      return {
        command: "fake-pi",
        args: ["--session", record.sessionFile],
        cwd: "/workspace",
        env: {},
      };
    },
    createWorker(workerOptions) {
      const worker = new FakeWorker(workerOptions, workerPlans.shift() ?? {});
      workers.push(worker);
      return worker as unknown as RpcChildWorker;
    },
    createMonitor() {
      const monitor: SanitizedRpcEvent[] = [];
      monitors.push(monitor);
      return monitor;
    },
    ingestMonitor(monitor, event) {
      monitor.push(event);
    },
    appendFinalMonitor(_monitor, status, summary, fullAnswerFile) {
      finalMonitorEvents.push({
        status,
        summary,
        ...(fullAnswerFile === undefined ? {} : { fullAnswerFile }),
      });
    },
    async deliverFinal(record, status, payload) {
      deliveries.push({ path: record.canonicalPath, status, payload });
      const gate = deliveryGates.shift();
      if (gate) return gate.promise;
      return {};
    },
    now() {
      now += 10;
      return now;
    },
    createId() {
      return ids.shift() ?? `id-${++idSequence}`;
    },
    createMessageId() {
      return `message-${++messageSequence}`;
    },
  };

  const registry = new CollaborationRegistry(dependencies);
  return {
    registry,
    workers,
    monitors,
    deliveries,
    finalMonitorEvents,
    removedSessions,
    allocationCalls,
    runtime,
  };
}

function spawnInput(taskName: string): SpawnAgentInput {
  return { task_name: taskName, message: `Task for ${taskName}` };
}

function payloadOf(envelope: string): string {
  const marker = "Payload:\n";
  return envelope.slice(envelope.indexOf(marker) + marker.length);
}

function exitInfo(settled: boolean, stderr = ""): RpcExitInfo {
  return {
    code: 0,
    signal: null,
    expected: settled,
    settled,
    forced: false,
    timedOut: false,
    stderr,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
