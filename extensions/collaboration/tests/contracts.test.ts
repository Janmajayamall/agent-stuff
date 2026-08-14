import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
  type CollaborationSuccessResult,
  CollaborationSchemaError,
  DEFAULT_WAIT_TIMEOUT_MS,
  FollowupTaskInputSchema,
  InterruptAgentInputSchema,
  isActiveStatus,
  isCompletedStatus,
  isErroredStatus,
  isInactiveLiveStatus,
  ListAgentsInputSchema,
  prepareFollowupTaskArguments,
  prepareInterruptAgentArguments,
  prepareListAgentsArguments,
  prepareSendMessageArguments,
  prepareSpawnAgentArguments,
  prepareWaitAgentArguments,
  SendMessageInputSchema,
  SpawnAgentInputSchema,
  createSuccessResult,
  waitTimeoutMs,
  WaitAgentInputSchema,
} from "../src/contracts.ts";

const strictSchemas = [
  SpawnAgentInputSchema,
  SendMessageInputSchema,
  FollowupTaskInputSchema,
  InterruptAgentInputSchema,
  ListAgentsInputSchema,
  WaitAgentInputSchema,
];

describe("collaboration input contracts", () => {
  it("makes every top-level object schema strict", () => {
    for (const schema of strictSchemas) {
      expect((schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("accepts the complete Sprint 1 spawn shape and omission of fork_turns", () => {
    expect(
      Value.Check(SpawnAgentInputSchema, {
        task_name: "tests_1",
        message: "Run the tests",
        model: "gpt-5.6-terra",
        reasoning_effort: "max",
      }),
    ).toBe(true);
    expect(Value.Check(SpawnAgentInputSchema, { task_name: "tests", message: "Run" })).toBe(true);
  });

  it.each([
    [{ message: "Run" }, "missing task name"],
    [{ task_name: "Bad-Name", message: "Run" }, "invalid task name"],
    [{ task_name: "tests", message: "   \t" }, "blank task"],
    [{ task_name: "tests", message: "Run", fork_turns: "all" }, "Sprint 2 fork_turns"],
    [{ task_name: "tests", message: "Run", model: "gpt-5.6-luna" }, "unsupported model"],
    [{ task_name: "tests", message: "Run", reasoning_effort: "ultra" }, "unsupported effort"],
  ])("rejects %s (%s)", (input, _description) => {
    expect(Value.Check(SpawnAgentInputSchema, input)).toBe(false);
  });

  it("rejects missing, unknown, and blank message/target properties", () => {
    expect(Value.Check(SendMessageInputSchema, { target: "worker", message: "hi" })).toBe(true);
    expect(Value.Check(SendMessageInputSchema, { target: "worker" })).toBe(false);
    expect(Value.Check(SendMessageInputSchema, { target: " ", message: "hi" })).toBe(false);
    expect(Value.Check(SendMessageInputSchema, { target: "worker", message: "\n", extra: true })).toBe(
      false,
    );
    expect(Value.Check(FollowupTaskInputSchema, { target: "worker", message: "\t" })).toBe(false);
    expect(Value.Check(InterruptAgentInputSchema, {})).toBe(false);
    expect(Value.Check(InterruptAgentInputSchema, { target: "worker", extra: "no" })).toBe(false);
  });

  it("enforces list prefix and wait timeout constraints", () => {
    expect(Value.Check(ListAgentsInputSchema, {})).toBe(true);
    expect(Value.Check(ListAgentsInputSchema, { path_prefix: "/root/tests" })).toBe(true);
    expect(Value.Check(ListAgentsInputSchema, { path_prefix: "" })).toBe(false);
    expect(Value.Check(ListAgentsInputSchema, { path_prefix: "/root/" })).toBe(false);

    expect(Value.Check(WaitAgentInputSchema, {})).toBe(true);
    expect(Value.Check(WaitAgentInputSchema, { timeout_ms: 10_000 })).toBe(true);
    expect(Value.Check(WaitAgentInputSchema, { timeout_ms: 3_600_000 })).toBe(true);
    expect(Value.Check(WaitAgentInputSchema, { timeout_ms: 9_999 })).toBe(false);
    expect(Value.Check(WaitAgentInputSchema, { timeout_ms: 3_600_001 })).toBe(false);
    expect(Value.Check(WaitAgentInputSchema, { timeout_ms: 10_000.5 })).toBe(false);
    expect(Value.Check(WaitAgentInputSchema, { timeout_ms: 10_000, extra: 1 })).toBe(false);
  });

  it("returns the same raw object and rejects unknown or wrong primitive types before coercion", () => {
    const spawn = { task_name: "tests", message: "Run" };
    expect(prepareSpawnAgentArguments(spawn)).toBe(spawn);

    expect(() => prepareSpawnAgentArguments({ task_name: 1, message: "Run" })).toThrow(
      CollaborationSchemaError,
    );
    expect(() => prepareSpawnAgentArguments({ task_name: "tests", message: "Run", fork_turns: "all" })).toThrow(
      /unknown property "fork_turns"/,
    );
    expect(() => prepareSendMessageArguments({ target: "tests", message: false })).toThrow(/JSON string/);
    expect(() => prepareFollowupTaskArguments({ target: 1, message: "Run" })).toThrow(/JSON string/);
    expect(() => prepareInterruptAgentArguments({ target: null })).toThrow(/JSON string/);
    expect(() => prepareListAgentsArguments({ path_prefix: 1 })).toThrow(/JSON string/);
    expect(() => prepareWaitAgentArguments({ timeout_ms: "10000" })).toThrow(/JSON number/);
    expect(() => prepareWaitAgentArguments({ timeout_ms: 10_000.5 })).toThrow(/integer/);
    expect(() => prepareWaitAgentArguments([])).toThrow(/plain, non-array object/);
    expect(() => prepareWaitAgentArguments(null)).toThrow(/plain, non-array object/);
  });

  it("blocks string timeout_ms through Pi's real prepare/convert/validate/execute path", async () => {
    const invalid = await runThroughPiToolPipeline({ timeout_ms: "10000" });
    expect(invalid.execute).not.toHaveBeenCalled();
    expect(invalid.error).toContain('property "timeout_ms" must be a JSON number');

    const valid = await runThroughPiToolPipeline({ timeout_ms: 10_000 });
    expect(valid.execute).toHaveBeenCalledOnce();
    expect(valid.execute).toHaveBeenCalledWith(10_000);
    expect(valid.error).toBeUndefined();

    // This demonstrates the coercion the raw hook is specifically preventing.
    const convertedWithoutPrepare = structuredClone({ timeout_ms: "10000" });
    Value.Convert(WaitAgentInputSchema, convertedWithoutPrepare);
    expect(convertedWithoutPrepare).toEqual({ timeout_ms: 10_000 });
    expect(Value.Check(WaitAgentInputSchema, convertedWithoutPrepare)).toBe(true);
  });

  it("blocks fractional timeout_ms before Pi's integer conversion truncates it", async () => {
    const invalid = await runThroughPiToolPipeline({ timeout_ms: 10_000.5 });
    expect(invalid.execute).not.toHaveBeenCalled();
    expect(invalid.error).toContain("integer");

    // Pi's conversion turns the invalid JSON number into a valid integer, so
    // this constraint must be enforced by prepareArguments on the raw value.
    const convertedWithoutPrepare = structuredClone({ timeout_ms: 10_000.5 });
    Value.Convert(WaitAgentInputSchema, convertedWithoutPrepare);
    expect(convertedWithoutPrepare).toEqual({ timeout_ms: 10_000 });
    expect(Value.Check(WaitAgentInputSchema, convertedWithoutPrepare)).toBe(true);
  });
});

describe("logical result and status helpers", () => {
  it("encodes every success shape identically in content and details", () => {
    const logicalResults: CollaborationSuccessResult[] = [
      { task_name: "/root/tests" },
      { target: "/root/tests", delivery: "steered" },
      { target: "/root/tests", delivery: "queued" },
      { target: "/root/tests", delivery: "follow_up" },
      { target: "/root/tests", delivery: "started" },
      { target: "/root/tests", previous_status: { completed: null } },
      {
        agents: [
          { agent_name: "/root", agent_status: "running" },
          { agent_name: "/root/tests", agent_status: { errored: "failed" } },
        ],
      },
      { message: "No updates", timed_out: true },
    ];

    for (const logicalResult of logicalResults) {
      const result = createSuccessResult(logicalResult);
      expect(result.details).toBe(logicalResult);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(logicalResult) }]);
      expect(Object.keys(result).sort()).toEqual(["content", "details"]);
    }
  });

  it("classifies logical statuses without introducing worker phases", () => {
    expect(isActiveStatus("pending_init")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isInactiveLiveStatus("interrupted")).toBe(true);
    expect(isInactiveLiveStatus({ completed: null })).toBe(true);
    expect(isInactiveLiveStatus({ errored: "failed" })).toBe(true);
    expect(isInactiveLiveStatus("shutdown")).toBe(false);
    expect(isCompletedStatus({ completed: "done" })).toBe(true);
    expect(isErroredStatus({ errored: "failed" })).toBe(true);
  });

  it("resolves the documented wait default", () => {
    expect(waitTimeoutMs({})).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(waitTimeoutMs({ timeout_ms: 45_000 })).toBe(45_000);
  });
});

async function runThroughPiToolPipeline(raw: Record<string, unknown>): Promise<{
  execute: ReturnType<typeof vi.fn<(timeout: number) => void>>;
  error: string | undefined;
}> {
  const execute = vi.fn<(timeout: number) => void>();
  try {
    // This is Pi 0.84.1's real agent-loop ordering and validator: raw
    // prepareArguments first, then validateToolArguments clones, converts,
    // compiles/checks the TypeBox schema, and only then execute runs.
    const prepared = prepareWaitAgentArguments(raw);
    const validated = validateToolArguments(
      {
        name: "collaboration_wait_agent",
        description: "test",
        parameters: WaitAgentInputSchema,
      },
      {
        type: "toolCall",
        id: "tool-call-1",
        name: "collaboration_wait_agent",
        arguments: prepared,
      },
    ) as { timeout_ms?: number };
    execute(validated.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS);
    return { execute, error: undefined };
  } catch (error) {
    return { execute, error: error instanceof Error ? error.message : String(error) };
  }
}
