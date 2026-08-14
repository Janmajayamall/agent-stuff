import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
	COLLABORATION_TOOL_NAMES,
	CollaborationSchemaError,
	type CollaborationSuccessResult,
} from "../src/contracts.ts";
import type { RootMailbox } from "../src/mailbox.ts";
import type { CollaborationRegistry } from "../src/registry.ts";
import { registerCollaborationTools } from "../src/tools.ts";

interface RegisteredTestTool {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	executionMode?: "sequential" | "parallel";
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}

const VALID_ARGUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
	collaboration_spawn_agent: { task_name: "tests", message: "Run the tests" },
	collaboration_send_message: { target: "tests", message: "More context" },
	collaboration_followup_task: { target: "/root/tests", message: "Continue" },
	collaboration_interrupt_agent: { target: "tests" },
	collaboration_list_agents: { path_prefix: "/root/tests" },
	collaboration_wait_agent: { timeout_ms: 10_000 },
};

const WRONG_PRIMITIVE_ARGUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
	collaboration_spawn_agent: { task_name: 7, message: "Run" },
	collaboration_send_message: { target: false, message: "Context" },
	collaboration_followup_task: { target: "tests", message: 9 },
	collaboration_interrupt_agent: { target: null },
	collaboration_list_agents: { path_prefix: 12 },
	collaboration_wait_agent: { timeout_ms: "10000" },
};

const INVALID_SCHEMA_ARGUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
	collaboration_spawn_agent: { task_name: "Bad-Name", message: "Run" },
	collaboration_send_message: { target: " ", message: "Context" },
	collaboration_followup_task: { target: "tests", message: "\t" },
	collaboration_interrupt_agent: { target: "" },
	collaboration_list_agents: { path_prefix: "/root/" },
	collaboration_wait_agent: { timeout_ms: 9_999 },
};

function registerWith(
	registry: CollaborationRegistry<unknown>,
	mailbox: RootMailbox,
): RegisteredTestTool[] {
	const registered: RegisteredTestTool[] = [];
	const pi = {
		registerTool(definition: unknown) {
			registered.push(definition as RegisteredTestTool);
		},
	} as unknown as ExtensionAPI;
	registerCollaborationTools(pi, () => registry, () => mailbox);
	return registered;
}

function byName(tools: readonly RegisteredTestTool[], name: string): RegisteredTestTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing registered tool ${name}`);
	return tool;
}

async function invokeLikePi(
	tool: RegisteredTestTool,
	raw: unknown,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	if (!tool.prepareArguments) throw new Error(`Tool ${tool.name} omitted prepareArguments`);
	const prepared = tool.prepareArguments(raw);
	const converted = structuredClone(prepared);
	Value.Convert(tool.parameters, converted);
	if (!Value.Check(tool.parameters, converted)) {
		throw new Error(`Schema validation failed for ${tool.name}`);
	}
	return tool.execute(
		"tool-call-1",
		converted,
		signal,
		undefined,
		{} as ExtensionContext,
	);
}

function expectSuccess(result: AgentToolResult<unknown>, logical: CollaborationSuccessResult): void {
	expect(result.details).toBe(logical);
	expect(result.content).toEqual([{ type: "text", text: JSON.stringify(logical) }]);
	expect(Object.keys(result).sort()).toEqual(["content", "details"]);
}

function successFixture(): {
	registry: CollaborationRegistry<unknown>;
	mailbox: RootMailbox;
	logical: Readonly<Record<string, CollaborationSuccessResult>>;
	spies: {
		spawn: ReturnType<typeof vi.fn>;
		sendMessage: ReturnType<typeof vi.fn>;
		followupTask: ReturnType<typeof vi.fn>;
		interruptAgent: ReturnType<typeof vi.fn>;
		listAgents: ReturnType<typeof vi.fn>;
		wait: ReturnType<typeof vi.fn>;
	};
} {
	const logical: Readonly<Record<string, CollaborationSuccessResult>> = {
		collaboration_spawn_agent: { task_name: "/root/tests" },
		collaboration_send_message: { target: "/root/tests", delivery: "steered" },
		collaboration_followup_task: { target: "/root/tests", delivery: "follow_up" },
		collaboration_interrupt_agent: { target: "/root/tests", previous_status: "running" },
		collaboration_list_agents: {
			agents: [
				{ agent_name: "/root", agent_status: "running" },
				{ agent_name: "/root/tests", agent_status: { completed: "done" } },
			],
		},
		collaboration_wait_agent: { message: "Child /root/tests completed.", timed_out: false },
	};
	const spawn = vi.fn(async () => logical.collaboration_spawn_agent!);
	const sendMessage = vi.fn(async () => logical.collaboration_send_message!);
	const followupTask = vi.fn(async () => logical.collaboration_followup_task!);
	const interruptAgent = vi.fn(async () => logical.collaboration_interrupt_agent!);
	const listAgents = vi.fn(() => logical.collaboration_list_agents!);
	const wait = vi.fn(async () => logical.collaboration_wait_agent!);
	const registry = {
		spawn,
		sendMessage,
		followupTask,
		interruptAgent,
		listAgents,
	} as unknown as CollaborationRegistry<unknown>;
	const mailbox = { wait } as unknown as RootMailbox;
	return {
		registry,
		mailbox,
		logical,
		spies: { spawn, sendMessage, followupTask, interruptAgent, listAgents, wait },
	};
}

describe("collaboration tool registration", () => {
	it("registers exactly six provider-safe parallel adapters with strict schemas and raw preparers", () => {
		const fixture = successFixture();
		const tools = registerWith(fixture.registry, fixture.mailbox);
		expect(tools.map((tool) => tool.name)).toEqual(COLLABORATION_TOOL_NAMES);
		expect(tools.map((tool) => tool.label)).toEqual([
			"collaboration.spawn_agent",
			"collaboration.send_message",
			"collaboration.followup_task",
			"collaboration.interrupt_agent",
			"collaboration.list_agents",
			"collaboration.wait_agent",
		]);

		for (const tool of tools) {
			expect(tool.executionMode).toBe("parallel");
			expect((tool.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
			expect(tool.description.length).toBeGreaterThan(20);
			const raw = VALID_ARGUMENTS[tool.name]!;
			expect(tool.prepareArguments?.(raw)).toBe(raw);
			expect(() => tool.prepareArguments?.({ ...raw, unknown: true })).toThrow(
				CollaborationSchemaError,
			);
			expect(() => tool.prepareArguments?.(WRONG_PRIMITIVE_ARGUMENTS[tool.name]!)).toThrow(
				CollaborationSchemaError,
			);
		}
		expect(() => byName(tools, "collaboration_spawn_agent").prepareArguments?.({
			task_name: "tests",
			message: "Run",
			fork_turns: "all",
		})).toThrow(/unknown property "fork_turns"/);
		expect(() => byName(tools, "collaboration_wait_agent").prepareArguments?.({
			timeout_ms: 10_000.5,
		})).toThrow(/JSON integer/);
	});

	it("lets Pi schema validation reject invalid-but-correctly-typed arguments before execute", async () => {
		const fixture = successFixture();
		const tools = registerWith(fixture.registry, fixture.mailbox);
		for (const tool of tools) {
			await expect(invokeLikePi(tool, INVALID_SCHEMA_ARGUMENTS[tool.name]!)).rejects.toThrow(
				/Schema validation failed/,
			);
		}
		expect(fixture.spies.spawn).not.toHaveBeenCalled();
		expect(fixture.spies.sendMessage).not.toHaveBeenCalled();
		expect(fixture.spies.followupTask).not.toHaveBeenCalled();
		expect(fixture.spies.interruptAgent).not.toHaveBeenCalled();
		expect(fixture.spies.listAgents).not.toHaveBeenCalled();
		expect(fixture.spies.wait).not.toHaveBeenCalled();
	});
});

describe("collaboration tool execution adapters", () => {
	it("delegates all six calls and encodes each logical success identically", async () => {
		const fixture = successFixture();
		const tools = registerWith(fixture.registry, fixture.mailbox);
		const controller = new AbortController();

		for (const tool of tools) {
			const result = await invokeLikePi(tool, VALID_ARGUMENTS[tool.name]!, controller.signal);
			expectSuccess(result, fixture.logical[tool.name]!);
		}

		expect(fixture.spies.spawn).toHaveBeenCalledWith({
			task_name: "tests",
			message: "Run the tests",
		});
		expect(fixture.spies.sendMessage).toHaveBeenCalledWith("tests", "More context");
		expect(fixture.spies.followupTask).toHaveBeenCalledWith("/root/tests", "Continue");
		expect(fixture.spies.interruptAgent).toHaveBeenCalledWith("tests");
		expect(fixture.spies.listAgents).toHaveBeenCalledWith("/root/tests");
		expect(fixture.spies.wait).toHaveBeenCalledWith(10_000, controller.signal);
	});

	it("uses the documented wait default and forwards the execution abort signal", async () => {
		const fixture = successFixture();
		const tools = registerWith(fixture.registry, fixture.mailbox);
		const controller = new AbortController();
		const result = await invokeLikePi(
			byName(tools, "collaboration_wait_agent"),
			{},
			controller.signal,
		);
		expectSuccess(result, fixture.logical.collaboration_wait_agent!);
		expect(fixture.spies.wait).toHaveBeenCalledWith(30_000, controller.signal);
	});

	it("propagates every registry/mailbox failure so Pi marks the tool result as an error", async () => {
		const failures = new Map<string, Error>();
		const fail = (name: string): Error => {
			const error = new Error(`${name} failed`);
			failures.set(name, error);
			return error;
		};
		const registry = {
			spawn: vi.fn(async () => { throw fail("collaboration_spawn_agent"); }),
			sendMessage: vi.fn(async () => { throw fail("collaboration_send_message"); }),
			followupTask: vi.fn(async () => { throw fail("collaboration_followup_task"); }),
			interruptAgent: vi.fn(async () => { throw fail("collaboration_interrupt_agent"); }),
			listAgents: vi.fn(() => { throw fail("collaboration_list_agents"); }),
		} as unknown as CollaborationRegistry<unknown>;
		const mailbox = {
			wait: vi.fn(async () => { throw fail("collaboration_wait_agent"); }),
		} as unknown as RootMailbox;
		const tools = registerWith(registry, mailbox);

		for (const tool of tools) {
			await expect(invokeLikePi(tool, VALID_ARGUMENTS[tool.name]!)).rejects.toSatisfy(
				(error: unknown) => error === failures.get(tool.name),
			);
		}
	});
});
