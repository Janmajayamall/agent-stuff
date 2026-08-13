import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it, vi } from "vitest";
import {
	buildPiRpcArgs,
	createPiRpcLaunch,
	LfJsonlDecoder,
	resolvePiInvocation,
	RpcChildWorker,
	RpcCommandError,
	RpcDeliveryRacedSettlementError,
	RpcProcessExitError,
	RpcStateMismatchError,
	sanitizeRpcEvent,
	type RpcChildWorkerOptions,
	type RpcLaunchSpec,
	type SpawnedRpcProcess,
	type WorkerToken,
} from "../src/rpc-child.ts";

const TOKEN: WorkerToken = {
	childId: "child-1",
	activeTurnId: "turn-7",
	workerGeneration: 3,
};

const LAUNCH: RpcLaunchSpec = {
	command: "fake-pi",
	args: ["--mode", "rpc"],
	cwd: "/work",
	env: {},
};

type WireObject = Record<string, unknown>;

class FakeRpcChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly pid = 4242;
	readonly commands: WireObject[] = [];
	readonly signals: NodeJS.Signals[] = [];
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	stdinEnded = false;
	private closed = false;
	private inputBuffer = "";
	private readonly inputDecoder = new StringDecoder("utf8");

	constructor(
		private readonly closeOnInputEnd = true,
		private readonly closeOnSignal?: NodeJS.Signals,
	) {
		super();
		this.stdin = new Writable({
			write: (chunk: Buffer | string, _encoding, callback) => {
				this.inputBuffer +=
					typeof chunk === "string" ? chunk : this.inputDecoder.write(chunk);
				this.readCommands();
				callback();
			},
			final: (callback) => {
				this.inputBuffer += this.inputDecoder.end();
				this.readCommands();
				this.stdinEnded = true;
				callback();
				if (this.closeOnInputEnd) queueMicrotask(() => this.close(0, null));
			},
		});
	}

	emitRecord(record: unknown, cuts: readonly number[] = []): void {
		const wire = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		let offset = 0;
		for (const requestedEnd of cuts) {
			const end = Math.max(offset, Math.min(wire.length, requestedEnd));
			if (end > offset) this.stdout.write(wire.subarray(offset, end));
			offset = end;
		}
		if (offset < wire.length) this.stdout.write(wire.subarray(offset));
	}

	respond(command: WireObject, data?: unknown, cuts?: readonly number[]): void {
		const response: WireObject = {
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
		};
		if (data !== undefined) response.data = data;
		this.emitRecord(response, cuts);
	}

	fail(command: WireObject, error: string): void {
		this.emitRecord({
			type: "response",
			id: command.id,
			command: command.type,
			success: false,
			error,
		});
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		if (typeof signal === "number") return false;
		this.signals.push(signal);
		if (signal === this.closeOnSignal) queueMicrotask(() => this.close(null, signal));
		return true;
	}

	close(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.closed) return;
		this.closed = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code, signal);
	}

	private readCommands(): void {
		while (true) {
			const newline = this.inputBuffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.inputBuffer.slice(0, newline);
			this.inputBuffer = this.inputBuffer.slice(newline + 1);
			if (line.length > 0) this.commands.push(JSON.parse(line) as WireObject);
		}
	}
}

function makeWorker(
	child: FakeRpcChild,
	options: Partial<Omit<RpcChildWorkerOptions, "launch" | "token" | "spawn">> = {},
): RpcChildWorker {
	return new RpcChildWorker({
		launch: LAUNCH,
		token: TOKEN,
		spawn: () => child as unknown as SpawnedRpcProcess,
		commandTimeoutMs: 500,
		startTimeoutMs: 500,
		drainTimeoutMs: 25,
		exitGraceMs: 25,
		abortGraceMs: 25,
		termGraceMs: 25,
		killGraceMs: 25,
		...options,
	}).start();
}

async function waitForCommand(child: FakeRpcChild, index: number): Promise<WireObject> {
	await waitUntil(() => child.commands.length > index);
	return child.commands[index]!;
}

async function readyWorker(child: FakeRpcChild, options: Parameters<typeof makeWorker>[1] = {}): Promise<RpcChildWorker> {
	const worker = makeWorker(child, options);
	const started = worker.promptAndWaitForStart("do the task");
	const prompt = await waitForCommand(child, 0);
	child.respond(prompt);
	child.emitRecord({ type: "agent_start" });
	await started;
	return worker;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for fake child state");
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

describe("Pi RPC launch resolution", () => {
	it("prefers the live Pi entry script, supports packaged binaries, and falls back to PATH", () => {
		expect(
			resolvePiInvocation(["--mode", "rpc"], {
				argv: ["node", "/repo/src/cli.ts"],
				execPath: "/usr/local/bin/node",
				pathExists: (path) => path === "/repo/src/cli.ts",
			}),
		).toEqual({
			command: "/usr/local/bin/node",
			args: ["/repo/src/cli.ts", "--mode", "rpc"],
		});

		expect(
			resolvePiInvocation(["--mode", "rpc"], {
				argv: ["/Applications/pi"],
				execPath: "/Applications/pi",
				pathExists: () => false,
			}),
		).toEqual({ command: "/Applications/pi", args: ["--mode", "rpc"] });

		expect(
			resolvePiInvocation(["--mode", "rpc"], {
				argv: ["bun", "/$bunfs/root/pi.js"],
				execPath: "/usr/local/bin/bun",
				pathExists: () => true,
			}),
		).toEqual({ command: "pi", args: ["--mode", "rpc"] });
	});

	it("builds an exact persistent RPC launch and depth marker", () => {
		const args = buildPiRpcArgs({
			sessionFile: "/sessions/child.jsonl",
			name: "/root/tests",
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "xhigh",
			tools: ["read", "bash"],
			extensionPaths: ["/ext/a.ts", "/ext/a.ts", "/ext/b.ts"],
			appendSystemPrompt: "child envelope",
			projectTrusted: false,
		});
		expect(args).toEqual([
			"--mode",
			"rpc",
			"--session",
			"/sessions/child.jsonl",
			"--name",
			"/root/tests",
			"--model",
			"openai-codex/gpt-5.6-sol",
			"--thinking",
			"xhigh",
			"--tools",
			"read,bash",
			"--extension",
			"/ext/a.ts",
			"--extension",
			"/ext/b.ts",
			"--append-system-prompt",
			"child envelope",
			"--no-approve",
		]);

		const launch = createPiRpcLaunch({
			sessionFile: "/sessions/child.jsonl",
			name: "/root/tests",
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
			tools: [],
			appendSystemPrompt: "child",
			projectTrusted: true,
			cwd: "/work",
			env: { TEST_ONLY: "yes" },
			invocationRuntime: {
				argv: ["node", "/repo/pi.ts"],
				execPath: "/bin/node",
				pathExists: () => true,
			},
		});
		expect(launch.command).toBe("/bin/node");
		expect(launch.args[0]).toBe("/repo/pi.ts");
		expect(launch.args).toContain("--no-tools");
		expect(launch.env.PI_COLLABORATION_CHILD).toBe("1");
		expect(launch.env.TEST_ONLY).toBe("yes");
	});
});

describe("LF-only JSONL decoding", () => {
	it("preserves split UTF-8 and treats U+2028/U+2029 as ordinary JSON text", () => {
		const lines: string[] = [];
		const decoder = new LfJsonlDecoder((line) => lines.push(line));
		const first = Buffer.from('{"text":"a😀b c d"}\r\n{"next":1}\n', "utf8");
		const emoji = first.indexOf(Buffer.from("😀"));
		decoder.feed(first.subarray(0, emoji + 1));
		decoder.feed(first.subarray(emoji + 1, emoji + 3));
		decoder.feed(first.subarray(emoji + 3));
		decoder.end();
		expect(lines).toEqual(['{"text":"a😀b c d"}', '{"next":1}']);
	});
});

describe("RpcChildWorker protocol", () => {
	it("requires matching prompt acknowledgement and agent_start in either order", async () => {
		const firstChild = new FakeRpcChild(false);
		const first = makeWorker(firstChild, { autoCloseOnSettled: false });
		let firstReady = false;
		const firstStart = first.promptAndWaitForStart("first").then(() => {
			firstReady = true;
		});
		const firstPrompt = await waitForCommand(firstChild, 0);
		firstChild.emitRecord({ type: "agent_start", cwd: "split-😀" }, [3, 19, 23]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(firstReady).toBe(false);
		firstChild.respond(firstPrompt, undefined, [2, 7, 15]);
		await firstStart;
		expect(first.phase).toBe("accepting");
		firstChild.close(0, null);

		const secondChild = new FakeRpcChild(false);
		const second = makeWorker(secondChild, { autoCloseOnSettled: false });
		let secondReady = false;
		const secondStart = second.promptAndWaitForStart("second").then(() => {
			secondReady = true;
		});
		const secondPrompt = await waitForCommand(secondChild, 0);
		secondChild.respond(secondPrompt);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondReady).toBe(false);
		secondChild.emitRecord({ type: "agent_start" });
		await secondStart;
		expect(second.phase).toBe("accepting");
		secondChild.close(0, null);
	});

	it("keeps prompt readiness successful across a rapid settlement", async () => {
		const child = new FakeRpcChild();
		const worker = makeWorker(child);
		const start = worker.promptAndWaitForStart("fast task");
		const prompt = await waitForCommand(child, 0);
		child.respond(prompt);
		child.emitRecord({ type: "agent_start" });
		child.emitRecord({ type: "agent_settled" });
		await expect(start).resolves.toBeUndefined();
		await expect(worker.closed).resolves.toMatchObject({ settled: true, expected: true });
	});

	it("verifies the selected model, thinking level, session, and streaming state", async () => {
		const child = new FakeRpcChild(false);
		const worker = makeWorker(child, { autoCloseOnSettled: false });
		const verification = worker.verifyState({
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
			sessionFile: "/sessions/one.jsonl",
			isStreaming: false,
		});
		const command = await waitForCommand(child, 0);
		child.respond(command, {
			model: { provider: "openai-codex", id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			sessionFile: "/sessions/one.jsonl",
			isStreaming: false,
		});
		await expect(verification).resolves.toMatchObject({ thinkingLevel: "high" });

		const mismatch = worker.verifyState({
			provider: "openai-codex",
			modelId: "gpt-5.6-terra",
			thinkingLevel: "low",
		});
		const mismatchCommand = await waitForCommand(child, 1);
		child.respond(mismatchCommand, {
			model: { provider: "openai-codex", id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			isStreaming: false,
		});
		await expect(mismatch).rejects.toBeInstanceOf(RpcStateMismatchError);
		child.close(0, null);
	});

	it("sanitizes hidden thinking and signatures before tokenized callbacks", async () => {
		const child = new FakeRpcChild(false);
		const events: unknown[] = [];
		const tokens: WorkerToken[] = [];
		makeWorker(child, {
			autoCloseOnSettled: false,
			onEvent: (event, token) => {
				events.push(event);
				tokens.push(token);
			},
		});

		child.emitRecord({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "private chain" },
		});
		child.emitRecord({
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					role: "assistant",
					responseId: "opaque-response",
					content: [
						{ type: "thinking", thinking: "private chain", thinkingSignature: "secret" },
						{ type: "text", text: "visible", textSignature: "secret-text" },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "a" },
							thoughtSignature: "secret-tool",
						},
					],
				},
			},
		});

		expect(events).toHaveLength(1);
		expect(tokens).toEqual([TOKEN]);
		const serialized = JSON.stringify(events[0]);
		expect(serialized).toContain("visible");
		expect(serialized).not.toMatch(/private chain|Signature|opaque-response|secret/);
		child.close(0, null);
	});

	it("allowlists assistant message fields and deep-clones visible content at the transport boundary", () => {
		const raw = {
			type: "message_end",
			message: {
				role: "assistant",
				api: "PRIVATE_API_SENTINEL",
				provider: "PRIVATE_PROVIDER_SENTINEL",
				model: "PRIVATE_MODEL_SENTINEL",
				responseModel: "PRIVATE_RESPONSE_MODEL_SENTINEL",
				responseId: "PRIVATE_RESPONSE_ID_SENTINEL",
				deferred: { data: "PRIVATE_DEFERRED_SENTINEL" },
				diagnostics: [{ details: { raw: "PRIVATE_DIAGNOSTIC_SENTINEL" } }],
				content: [
					{
						type: "thinking",
						thinking: "PRIVATE_THINKING_SENTINEL",
						thinkingSignature: "PRIVATE_THINKING_SIGNATURE_SENTINEL",
					},
					{
						type: "redacted_thinking",
						data: "PRIVATE_REDACTED_SENTINEL",
						signature: "PRIVATE_REDACTED_SIGNATURE_SENTINEL",
					},
					{
						type: "reasoning",
						text: "PRIVATE_REASONING_SENTINEL",
						reasoningSignature: "PRIVATE_REASONING_SIGNATURE_SENTINEL",
					},
					{
						type: "reasoning_details",
						encrypted_content: "PRIVATE_ENCRYPTED_REASONING_SENTINEL",
					},
					{
						type: "text",
						text: "VISIBLE_TEXT_SENTINEL",
						textSignature: "PRIVATE_TEXT_SIGNATURE_SENTINEL",
						providerMetadata: "PRIVATE_TEXT_METADATA_SENTINEL",
					},
					{
						type: "toolCall",
						id: "visible-call",
						name: "read",
						arguments: { path: "visible.txt", nested: { value: 1 } },
						thoughtSignature: "PRIVATE_TOOL_SIGNATURE_SENTINEL",
						providerMetadata: "PRIVATE_TOOL_METADATA_SENTINEL",
					},
				],
				stopReason: "stop",
				rawStopReason: "end_turn",
				usage: {
					input: 2,
					output: 3,
					totalTokens: 5,
					cost: { input: 0.1, output: 0.2, total: 0.3 },
					providerMetadata: "PRIVATE_USAGE_METADATA_SENTINEL",
				},
				timestamp: 123,
				providerMetadata: "PRIVATE_MESSAGE_METADATA_SENTINEL",
			},
		};

		const sanitized = sanitizeRpcEvent(raw);
		expect(sanitized).toEqual({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "VISIBLE_TEXT_SENTINEL" },
					{
						type: "toolCall",
						id: "visible-call",
						name: "read",
						arguments: { path: "visible.txt", nested: { value: 1 } },
					},
				],
				stopReason: "stop",
				rawStopReason: "end_turn",
				usage: {
					input: 2,
					output: 3,
					totalTokens: 5,
					cost: { input: 0.1, output: 0.2, total: 0.3 },
				},
				timestamp: 123,
			},
		});

		(raw.message.content[4] as { text: string }).text = "MUTATED_VISIBLE_SENTINEL";
		(
			raw.message.content[5] as { arguments: { nested: { value: number } } }
		).arguments.nested.value = 999;
		const serialized = JSON.stringify(sanitized);
		expect(serialized).toContain("VISIBLE_TEXT_SENTINEL");
		expect(serialized).toContain("visible.txt");
		expect(serialized).not.toMatch(
			/PRIVATE_|MUTATED_VISIBLE_SENTINEL|thinking|reasoning|signature|provider|responseId|deferred|diagnostic/i,
		);
	});

	it("drops raw partial snapshots and provider metadata from every message_update variant", () => {
		const rawPartial = {
			role: "assistant",
			provider: "PRIVATE_PARTIAL_PROVIDER_SENTINEL",
			content: [
				{ type: "thinking", thinking: "PRIVATE_PARTIAL_THINKING_SENTINEL" },
				{ type: "text", text: "PRIVATE_PARTIAL_TEXT_SENTINEL", textSignature: "PRIVATE_PARTIAL_SIGNATURE" },
			],
		};
		const variants = [
			{
				type: "message_update",
				providerMetadata: "PRIVATE_TOP_UPDATE_METADATA_SENTINEL",
				message: rawPartial,
				assistantMessageEvent: {
					type: "start",
					partial: rawPartial,
					providerMetadata: "PRIVATE_START_METADATA_SENTINEL",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 4,
					delta: "VISIBLE_DELTA_SENTINEL",
					partial: rawPartial,
					message: rawPartial,
					textSignature: "PRIVATE_DELTA_SIGNATURE_SENTINEL",
					providerMetadata: "PRIVATE_DELTA_METADATA_SENTINEL",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_end",
					contentIndex: 4,
					content: "VISIBLE_END_SENTINEL",
					partial: rawPartial,
					contentSignature: "PRIVATE_END_SIGNATURE_SENTINEL",
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 5,
					partial: rawPartial,
					toolCall: {
						type: "toolCall",
						id: "visible-call",
						name: "bash",
						arguments: { command: "VISIBLE_COMMAND_SENTINEL" },
						thoughtSignature: "PRIVATE_TOOLCALL_SIGNATURE_SENTINEL",
						providerMetadata: "PRIVATE_TOOLCALL_METADATA_SENTINEL",
					},
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "done",
					reason: "stop",
					partial: rawPartial,
					providerMetadata: "PRIVATE_DONE_METADATA_SENTINEL",
					message: {
						...rawPartial,
						content: [{ type: "text", text: "VISIBLE_DONE_SENTINEL", textSignature: "PRIVATE_DONE_SIGNATURE" }],
						stopReason: "stop",
					},
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "error",
					reason: "error",
					partial: rawPartial,
					providerMetadata: "PRIVATE_ERROR_METADATA_SENTINEL",
					error: {
						...rawPartial,
						content: [{ type: "text", text: "VISIBLE_ERROR_SENTINEL", textSignature: "PRIVATE_ERROR_SIGNATURE" }],
						stopReason: "error",
						errorMessage: "VISIBLE_ERROR_MESSAGE_SENTINEL",
					},
				},
			},
		];

		const sanitized = variants.map(sanitizeRpcEvent);
		expect(sanitized).toEqual([
			{ type: "message_update", assistantMessageEvent: { type: "start" } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 4, delta: "VISIBLE_DELTA_SENTINEL" },
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_end", contentIndex: 4, content: "VISIBLE_END_SENTINEL" },
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 5,
					toolCall: {
						type: "toolCall",
						id: "visible-call",
						name: "bash",
						arguments: { command: "VISIBLE_COMMAND_SENTINEL" },
					},
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "VISIBLE_DONE_SENTINEL" }],
						stopReason: "stop",
					},
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [{ type: "text", text: "VISIBLE_ERROR_SENTINEL" }],
						stopReason: "error",
						errorMessage: "VISIBLE_ERROR_MESSAGE_SENTINEL",
					},
				},
			},
		]);
		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toMatch(/PRIVATE_|partial|signature|providerMetadata/i);
	});

	it("discards direct thinking/reasoning wire events and event-level private metadata", () => {
		for (const type of [
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"reasoning_start",
			"reasoning_delta",
			"reasoning_end",
			"redacted_thinking_delta",
		] as const) {
			expect.soft(
				sanitizeRpcEvent({
					type,
					delta: "PRIVATE_DIRECT_REASONING_SENTINEL",
					signature: "PRIVATE_DIRECT_SIGNATURE_SENTINEL",
					providerMetadata: "PRIVATE_DIRECT_METADATA_SENTINEL",
				}),
			).toBeUndefined();
		}

		const sanitized = sanitizeRpcEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "VISIBLE_START_SENTINEL" }],
			},
			partial: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "PRIVATE_EVENT_PARTIAL_SENTINEL" }],
			},
			providerMetadata: "PRIVATE_EVENT_METADATA_SENTINEL",
			signature: "PRIVATE_EVENT_SIGNATURE_SENTINEL",
		});
		expect.soft(sanitized).toEqual({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "VISIBLE_START_SENTINEL" }],
			},
		});
	});

	it("preserves the legitimate thinking-level lifecycle event without treating its name as hidden content", () => {
		expect(
			sanitizeRpcEvent({
				type: "thinking_level_changed",
				level: "high",
				// Event allowlisting must still discard unexpected payloads.
				providerMetadata: "PRIVATE_LEVEL_METADATA_SENTINEL",
			}),
		).toEqual({ type: "thinking_level_changed", level: "high" });
	});

	it("drains the abort response after agent_settled before closing stdin", async () => {
		const child = new FakeRpcChild();
		const worker = await readyWorker(child);
		const abort = worker.abort();
		const command = await waitForCommand(child, 1);
		child.emitRecord({ type: "agent_settled" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(child.stdinEnded).toBe(false);
		child.respond(command);
		await expect(abort).resolves.toBeUndefined();
		await expect(worker.closed).resolves.toMatchObject({ settled: true });
		expect(child.stdinEnded).toBe(true);
		expect(worker.getCommandTracking().at(-1)).toMatchObject({
			command: "abort",
			state: "drained",
		});
	});

	it("coalesces concurrent interruption ownership into one abort and escalation path", async () => {
		const child = new FakeRpcChild(false);
		const worker = await readyWorker(child, { autoCloseOnSettled: false });
		const first = worker.interrupt();
		const second = worker.interrupt();
		expect(second).toBe(first);

		const abortCommand = await waitForCommand(child, 1);
		expect(abortCommand.type).toBe("abort");
		expect(child.commands.filter((command) => command.type === "abort")).toHaveLength(1);
		child.emitRecord({ type: "agent_settled" });
		child.respond(abortCommand);

		await expect(first).resolves.toMatchObject({ settled: true });
		await expect(second).resolves.toMatchObject({ settled: true });
		expect(child.commands.filter((command) => command.type === "abort")).toHaveLength(1);
		child.close(0, null);
	});

	it("signals a delivery race when steer/follow_up acknowledgement follows settlement", async () => {
		const child = new FakeRpcChild();
		const worker = await readyWorker(child);
		const delivery = worker.steer("late information");
		const command = await waitForCommand(child, 1);
		child.emitRecord({ type: "agent_settled" });
		child.respond(command);
		await expect(delivery).rejects.toBeInstanceOf(RpcDeliveryRacedSettlementError);
		await worker.closed;
		expect(worker.getCommandTracking().at(-1)).toMatchObject({
			command: "steer",
			state: "drained",
			responseAfterSettlement: true,
		});
	});

	it("closes stdin after the bounded post-settlement response deadline", async () => {
		const child = new FakeRpcChild();
		const worker = await readyWorker(child, { drainTimeoutMs: 10 });
		const delivery = worker.followUp("will not be acknowledged");
		await waitForCommand(child, 1);
		child.emitRecord({ type: "agent_settled" });
		await expect(delivery).rejects.toBeInstanceOf(RpcCommandError);
		await worker.closed;
		expect(child.stdinEnded).toBe(true);
	});

	it("rejects pending commands and reports tokenized bounded stderr on unexpected exit", async () => {
		const child = new FakeRpcChild(false);
		const unexpected = vi.fn();
		const worker = makeWorker(child, {
			autoCloseOnSettled: false,
			stderrMaxBytes: 12,
			onUnexpectedExit: unexpected,
		});
		const state = worker.getState();
		await waitForCommand(child, 0);
		const stderr = Buffer.from("old-prefix-😀-tail", "utf8");
		const emoji = stderr.indexOf(Buffer.from("😀"));
		child.stderr.write(stderr.subarray(0, emoji + 2));
		child.stderr.write(stderr.subarray(emoji + 2));
		child.close(7, null);
		await expect(state).rejects.toBeInstanceOf(RpcProcessExitError);
		const exit = await worker.closed;
		expect(exit).toMatchObject({ code: 7, expected: false, settled: false });
		expect(Buffer.byteLength(exit.stderr, "utf8")).toBeLessThanOrEqual(12);
		expect(exit.stderr).not.toContain("�");
		expect(unexpected).toHaveBeenCalledTimes(1);
		expect(unexpected.mock.calls[0]?.[1]).toEqual(TOKEN);
	});

	it("aborts first, then escalates SIGTERM to SIGKILL after bounded grace", async () => {
		const child = new FakeRpcChild(false, "SIGKILL");
		const worker = makeWorker(child, {
			abortGraceMs: 10,
			termGraceMs: 10,
			killGraceMs: 100,
		});
		const interrupted = worker.interrupt();
		const abort = await waitForCommand(child, 0);
		expect(abort.type).toBe("abort");
		await expect(interrupted).resolves.toMatchObject({ exited: true, settled: false });
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
		await expect(worker.closed).resolves.toMatchObject({
			expected: true,
			forced: true,
			signal: "SIGKILL",
		});
	});
});
