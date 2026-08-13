import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	RpcCommand,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { sanitizeAssistantMessage as sanitizeVisibleAssistantMessage } from "./monitor/model.ts";

export const COLLABORATION_CHILD_ENV = "PI_COLLABORATION_CHILD";

export interface WorkerToken {
	childId: string;
	activeTurnId: string;
	workerGeneration: number;
}

export function workerTokensEqual(left: WorkerToken, right: WorkerToken): boolean {
	return (
		left.childId === right.childId &&
		left.activeTurnId === right.activeTurnId &&
		left.workerGeneration === right.workerGeneration
	);
}

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface PiInvocationRuntime {
	argv?: readonly string[];
	execPath?: string;
	pathExists?: (filePath: string) => boolean;
}

/**
 * Resolve the currently-running Pi entry point without assuming that `pi` is on PATH.
 *
 * This mirrors Pi's maintained subagent example and covers source/tsx, Node, Bun,
 * packaged executables, and an installed `pi` binary. Bun's virtual script path cannot
 * be launched as a normal file and deliberately falls through to the runtime/binary
 * branches.
 */
export function resolvePiInvocation(args: readonly string[], runtime: PiInvocationRuntime = {}): PiInvocation {
	const argv = runtime.argv ?? process.argv;
	const execPath = runtime.execPath ?? process.execPath;
	const pathExists = runtime.pathExists ?? existsSync;
	const currentScript = argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;

	if (currentScript && !isBunVirtualScript && pathExists(currentScript)) {
		return { command: execPath, args: [currentScript, ...args] };
	}

	const executableName = basename(execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
	if (!isGenericRuntime) {
		return { command: execPath, args: [...args] };
	}

	return { command: "pi", args: [...args] };
}

export interface PiRpcArgsOptions {
	sessionFile: string;
	name: string;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	tools: readonly string[];
	appendSystemPrompt: string;
	projectTrusted: boolean;
	extensionPaths?: readonly string[];
}

/** Build the exact argument vector for a persistent-session RPC worker. */
export function buildPiRpcArgs(options: PiRpcArgsOptions): string[] {
	const args = [
		"--mode",
		"rpc",
		"--session",
		options.sessionFile,
		"--name",
		options.name,
		"--model",
		`${options.provider}/${options.modelId}`,
		"--thinking",
		options.thinkingLevel,
	];

	if (options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	} else {
		args.push("--no-tools");
	}

	for (const extensionPath of new Set(options.extensionPaths ?? [])) {
		args.push("--extension", extensionPath);
	}

	args.push("--append-system-prompt", options.appendSystemPrompt);
	args.push(options.projectTrusted ? "--approve" : "--no-approve");
	return args;
}

export interface PiRpcLaunchOptions extends PiRpcArgsOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	invocationRuntime?: PiInvocationRuntime;
}

export interface RpcLaunchSpec extends PiInvocation {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Resolve Pi and preserve the parent environment while marking the depth-one child. */
export function createPiRpcLaunch(options: PiRpcLaunchOptions): RpcLaunchSpec {
	const invocation = resolvePiInvocation(buildPiRpcArgs(options), options.invocationRuntime);
	return {
		...invocation,
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
			[COLLABORATION_CHILD_ENV]: "1",
		},
	};
}

export interface SpawnedRpcProcess {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	readonly pid?: number | undefined;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
}

export type RpcSpawn = (launch: RpcLaunchSpec) => SpawnedRpcProcess;

export const spawnRpcProcess: RpcSpawn = (launch) =>
	spawn(launch.command, launch.args, {
		cwd: launch.cwd,
		env: launch.env,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});

export class LfJsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private ended = false;

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly maxBufferedBytes = 8 * 1024 * 1024,
	) {}

	feed(chunk: string | Buffer): void {
		if (this.ended) throw new Error("Cannot feed an ended JSONL decoder");
		this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		this.emitCompleteLines();
		if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferedBytes) {
			throw new Error(`RPC JSONL record exceeded ${this.maxBufferedBytes} buffered bytes`);
		}
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.buffer += this.decoder.end();
		this.emitCompleteLines();
		if (this.buffer.length > 0) {
			this.emit(this.buffer);
			this.buffer = "";
		}
	}

	private emitCompleteLines(): void {
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.emit(line);
		}
	}

	private emit(line: string): void {
		const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
		const bytes = Buffer.byteLength(normalized, "utf8");
		if (bytes > this.maxBufferedBytes) {
			throw new Error(`RPC JSONL record exceeded ${this.maxBufferedBytes} bytes`);
		}
		this.onLine(normalized);
	}
}

function cloneJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
}

function sanitizeToolCall(value: unknown): unknown {
	const block = sanitizeVisibleAssistantMessage({ role: "assistant", content: [value] }).content[0];
	return block?.type === "toolCall" ? block : undefined;
}

function sanitizeAssistantMessage(value: unknown): unknown {
	return sanitizeVisibleAssistantMessage(value);
}

function sanitizeMessageUpdate(value: Record<string, unknown>): SanitizedRpcEvent | undefined {
	const assistantEvent = value.assistantMessageEvent;
	if (!isRecord(assistantEvent) || typeof assistantEvent.type !== "string") return undefined;
	if (
		assistantEvent.type === "thinking_start" ||
		assistantEvent.type === "thinking_delta" ||
		assistantEvent.type === "thinking_end"
	) {
		return undefined;
	}

	const contentIndex = typeof assistantEvent.contentIndex === "number"
		? assistantEvent.contentIndex
		: undefined;
	const withIndex = contentIndex === undefined ? {} : { contentIndex };
	let sanitizedAssistantEvent: Record<string, unknown>;
	if (assistantEvent.type === "done" && assistantEvent.message !== undefined) {
		sanitizedAssistantEvent = {
			type: "done",
			...(typeof assistantEvent.reason === "string" ? { reason: assistantEvent.reason } : {}),
			message: sanitizeAssistantMessage(assistantEvent.message),
		};
	} else if (assistantEvent.type === "error" && assistantEvent.error !== undefined) {
		sanitizedAssistantEvent = {
			type: "error",
			...(typeof assistantEvent.reason === "string" ? { reason: assistantEvent.reason } : {}),
			error: sanitizeAssistantMessage(assistantEvent.error),
		};
	} else if (assistantEvent.type === "toolcall_end") {
		const toolCall = sanitizeToolCall(assistantEvent.toolCall);
		if (toolCall === undefined) return undefined;
		sanitizedAssistantEvent = { type: "toolcall_end", ...withIndex, toolCall };
	} else if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
		sanitizedAssistantEvent = { type: "text_delta", ...withIndex, delta: assistantEvent.delta };
	} else if (assistantEvent.type === "text_end" && typeof assistantEvent.content === "string") {
		sanitizedAssistantEvent = { type: "text_end", ...withIndex, content: assistantEvent.content };
	} else if (
		assistantEvent.type === "start" ||
		assistantEvent.type === "text_start" ||
		assistantEvent.type === "toolcall_start"
	) {
		sanitizedAssistantEvent = { type: assistantEvent.type, ...withIndex };
	} else if (assistantEvent.type === "toolcall_delta" && typeof assistantEvent.delta === "string") {
		sanitizedAssistantEvent = { type: "toolcall_delta", ...withIndex, delta: assistantEvent.delta };
	} else {
		return undefined;
	}

	return { type: "message_update", assistantMessageEvent: sanitizedAssistantEvent } as SanitizedRpcEvent;
}

export type SanitizedRpcEvent = { type: string } & Record<string, unknown>;

/**
 * Sanitize at the transport boundary. Hidden thinking blocks and opaque signatures
 * never enter callbacks or controller-owned state.
 */
export function sanitizeRpcEvent(value: unknown): SanitizedRpcEvent | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	const normalizedType = value.type.toLowerCase();
	if (
		value.type !== "thinking_level_changed" &&
		(normalizedType.includes("thinking") || normalizedType.includes("reasoning"))
	) {
		return undefined;
	}
	if (value.type === "message_update") return sanitizeMessageUpdate(value);

	switch (value.type) {
		case "message_start":
		case "message_end":
			if (!isRecord(value.message) || value.message.role !== "assistant") return undefined;
			return { type: value.type, message: sanitizeAssistantMessage(value.message) };
		case "agent_start":
		case "agent_settled":
		case "turn_start":
		case "turn_end":
		case "summarization_retry_finished":
			return { type: value.type };
		case "agent_end":
			return {
				type: value.type,
				...(typeof value.willRetry === "boolean" ? { willRetry: value.willRetry } : {}),
			};
		case "tool_execution_start":
			return {
				type: value.type,
				...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
				...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
				args: cloneJson(value.args ?? {}),
			};
		case "tool_execution_update":
			return {
				type: value.type,
				...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
				...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
				args: cloneJson(value.args ?? {}),
				partialResult: cloneJson(value.partialResult ?? null),
			};
		case "tool_execution_end":
			return {
				type: value.type,
				...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
				...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
				result: cloneJson(value.result ?? null),
				isError: value.isError === true,
			};
		case "bash_execution_update":
			if (typeof value.delta !== "string") return undefined;
			return {
				type: value.type,
				...(typeof value.id === "string" ? { id: value.id } : {}),
				delta: value.delta,
			};
		case "queue_update":
			return {
				type: value.type,
				steeringCount: Array.isArray(value.steering) ? value.steering.length : 0,
				followUpCount: Array.isArray(value.followUp) ? value.followUp.length : 0,
			};
		case "compaction_start":
			return {
				type: value.type,
				...(typeof value.reason === "string" ? { reason: value.reason } : {}),
			};
		case "compaction_end":
			return {
				type: value.type,
				...(typeof value.reason === "string" ? { reason: value.reason } : {}),
				...(typeof value.aborted === "boolean" ? { aborted: value.aborted } : {}),
				...(typeof value.willRetry === "boolean" ? { willRetry: value.willRetry } : {}),
				...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
			};
		case "auto_retry_start":
			return {
				type: value.type,
				...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}),
				...(typeof value.maxAttempts === "number" ? { maxAttempts: value.maxAttempts } : {}),
				...(typeof value.delayMs === "number" ? { delayMs: value.delayMs } : {}),
				...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
			};
		case "auto_retry_end":
			return {
				type: value.type,
				...(typeof value.success === "boolean" ? { success: value.success } : {}),
				...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}),
				...(typeof value.finalError === "string" ? { finalError: value.finalError } : {}),
			};
		case "summarization_retry_scheduled":
			return {
				type: value.type,
				...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}),
				...(typeof value.maxAttempts === "number" ? { maxAttempts: value.maxAttempts } : {}),
				...(typeof value.delayMs === "number" ? { delayMs: value.delayMs } : {}),
				...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
			};
		case "summarization_retry_attempt_start":
			return {
				type: value.type,
				...(typeof value.source === "string" ? { source: value.source } : {}),
				...(typeof value.reason === "string" ? { reason: value.reason } : {}),
			};
		case "entry_appended":
			// Session entries can contain raw assistant/provider payloads. Pi owns
			// persistence; collaboration has no monitoring use for this event.
			return { type: value.type };
		case "session_info_changed":
			return {
				type: value.type,
				...(typeof value.name === "string" ? { name: value.name } : {}),
			};
		case "thinking_level_changed":
			return {
				type: value.type,
				...(typeof value.level === "string" ? { level: value.level } : {}),
			};
		default:
			return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T | PromiseLike<T>) => void;
	reject!: (reason?: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

export type RpcWorkerPhase = "created" | "starting" | "accepting" | "settling" | "closing" | "closed";

export type RpcCommandInput = RpcCommand extends infer TCommand
	? TCommand extends { id?: string }
		? Omit<TCommand, "id">
		: never
	: never;

export type RpcSuccessResponse = Extract<RpcResponse, { success: true }>;

export type RpcCommandState = "written" | "acknowledged" | "failed" | "drained";

export interface RpcCommandSnapshot {
	id: string;
	command: string;
	state: RpcCommandState;
	writtenAt: number;
	completedAt?: number;
	drainedAt?: number;
	error?: string;
	/** True only when a steer/follow_up acknowledgement arrived after agent_settled. */
	responseAfterSettlement?: boolean;
}

interface PendingCommand {
	snapshot: RpcCommandSnapshot;
	deferred: Deferred<RpcSuccessResponse>;
	timer?: ReturnType<typeof setTimeout>;
}

interface StartReadiness {
	promptRequestId: string;
	promptAcknowledged: boolean;
	agentStarted: boolean;
	deferred: Deferred<void>;
}

export interface RpcExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	expected: boolean;
	settled: boolean;
	forced: boolean;
	timedOut: boolean;
	stderr: string;
}

export interface RpcInterruptResult {
	settled: boolean;
	exited: boolean;
	abortAcknowledged: boolean;
}

export interface ExpectedRpcState {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	sessionFile?: string;
	isStreaming?: boolean;
}

export class RpcStateMismatchError extends Error {
	constructor(readonly mismatches: readonly string[]) {
		super(`RPC child state mismatch: ${mismatches.join("; ")}`);
		this.name = "RpcStateMismatchError";
	}
}

export function verifyRpcState(state: RpcSessionState, expected: ExpectedRpcState): void {
	const mismatches: string[] = [];
	if (state.model?.provider !== expected.provider) {
		mismatches.push(`provider expected ${expected.provider}, received ${state.model?.provider ?? "none"}`);
	}
	if (state.model?.id !== expected.modelId) {
		mismatches.push(`model expected ${expected.modelId}, received ${state.model?.id ?? "none"}`);
	}
	if (state.thinkingLevel !== expected.thinkingLevel) {
		mismatches.push(`thinking expected ${expected.thinkingLevel}, received ${state.thinkingLevel}`);
	}
	if (expected.sessionFile !== undefined && state.sessionFile !== expected.sessionFile) {
		mismatches.push(`session expected ${expected.sessionFile}, received ${state.sessionFile ?? "none"}`);
	}
	if (expected.isStreaming !== undefined && state.isStreaming !== expected.isStreaming) {
		mismatches.push(`streaming expected ${expected.isStreaming}, received ${state.isStreaming}`);
	}
	if (mismatches.length > 0) throw new RpcStateMismatchError(mismatches);
}

export class RpcAdmissionClosedError extends Error {
	constructor(
		readonly command: string,
		readonly phase: RpcWorkerPhase,
	) {
		super(`RPC command ${command} is not admitted while worker is ${phase}`);
		this.name = "RpcAdmissionClosedError";
	}
}

export class RpcCommandError extends Error {
	constructor(
		readonly command: string,
		readonly requestId: string,
		message: string,
	) {
		super(`RPC ${command} failed: ${message}`);
		this.name = "RpcCommandError";
	}
}

/**
 * The child settled before it acknowledged delivery. Callers must not report this
 * as a successful active-turn delivery; the registry can safely reroute/retry it.
 */
export class RpcDeliveryRacedSettlementError extends Error {
	constructor(
		readonly command: "steer" | "follow_up",
		readonly requestId: string,
	) {
		super(`RPC ${command} acknowledgement arrived after agent_settled`);
		this.name = "RpcDeliveryRacedSettlementError";
	}
}

export class RpcProcessExitError extends Error {
	constructor(readonly exit: RpcExitInfo) {
		super(
			`RPC child exited before settlement (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"})${
				exit.stderr ? `. Stderr: ${exit.stderr}` : ""
			}`,
		);
		this.name = "RpcProcessExitError";
	}
}

export interface RpcChildWorkerOptions {
	launch: RpcLaunchSpec;
	token: WorkerToken;
	spawn?: RpcSpawn;
	requestIdPrefix?: string;
	commandTimeoutMs?: number;
	startTimeoutMs?: number;
	drainTimeoutMs?: number;
	exitGraceMs?: number;
	abortGraceMs?: number;
	termGraceMs?: number;
	killGraceMs?: number;
	stderrMaxBytes?: number;
	stdoutMaxRecordBytes?: number;
	autoCloseOnSettled?: boolean;
	onEvent?: (event: SanitizedRpcEvent, token: WorkerToken) => void;
	onSettled?: (token: WorkerToken) => void;
	onExit?: (exit: RpcExitInfo, token: WorkerToken) => void;
	onUnexpectedExit?: (error: RpcProcessExitError, token: WorkerToken) => void;
	onProtocolError?: (error: Error, token: WorkerToken) => void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_EXIT_GRACE_MS = 2_000;
const DEFAULT_ABORT_GRACE_MS = 2_000;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;

export class RpcChildWorker {
	readonly token: Readonly<WorkerToken>;
	readonly settled: Promise<void>;
	readonly closed: Promise<RpcExitInfo>;

	private readonly options: RpcChildWorkerOptions;
	private readonly spawnProcess: RpcSpawn;
	private readonly settledDeferred = new Deferred<void>();
	private readonly closedDeferred = new Deferred<RpcExitInfo>();
	private readonly pending = new Map<string, PendingCommand>();
	private readonly commandHistory: RpcCommandSnapshot[] = [];
	private readonly drainWaiters = new Set<() => void>();
	private process?: SpawnedRpcProcess;
	private decoder?: LfJsonlDecoder;
	private requestSequence = 0;
	private readiness?: StartReadiness;
	private _phase: RpcWorkerPhase = "created";
	private settledSeen = false;
	private closedSeen = false;
	private terminationOwned = false;
	private forced = false;
	private closeTimedOut = false;
	private stderr = "";
	private readonly stderrDecoder = new StringDecoder("utf8");
	private stderrEnded = false;
	private settlementCloseTask?: Promise<void>;
	private protocolTerminationTask?: Promise<void>;
	private interruptTask: Promise<RpcInterruptResult> | undefined;

	constructor(options: RpcChildWorkerOptions) {
		this.options = options;
		this.spawnProcess = options.spawn ?? spawnRpcProcess;
		this.token = Object.freeze({ ...options.token });
		this.settled = this.settledDeferred.promise;
		this.closed = this.closedDeferred.promise;
	}

	get phase(): RpcWorkerPhase {
		return this._phase;
	}

	get pid(): number | undefined {
		return this.process?.pid;
	}

	get isSettled(): boolean {
		return this.settledSeen;
	}

	get isClosed(): boolean {
		return this.closedSeen;
	}

	matchesToken(candidate: WorkerToken): boolean {
		return workerTokensEqual(this.token, candidate);
	}

	start(): this {
		if (this._phase !== "created") throw new Error(`RPC child cannot start from phase ${this._phase}`);
		this._phase = "starting";
		try {
			const child = this.spawnProcess(this.options.launch);
			this.process = child;
			this.attachProcess(child);
			return this;
		} catch (error) {
			const message = errorMessage(error);
			this.stderr = appendBoundedUtf8(this.stderr, message, this.options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES);
			this.finalizeClose(null, null, true);
			throw error;
		}
	}

	getStderr(): string {
		return this.stderr;
	}

	getCommandTracking(): readonly RpcCommandSnapshot[] {
		return this.commandHistory.map((record) => ({ ...record }));
	}

	request(command: RpcCommandInput): Promise<RpcSuccessResponse> {
		const id = this.nextRequestId();
		return this.writeCommand(command, id);
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.request({ type: "get_state" });
		if (response.command !== "get_state" || !("data" in response)) {
			throw new Error("RPC get_state returned an invalid response shape");
		}
		return response.data;
	}

	async verifyState(expected: ExpectedRpcState): Promise<RpcSessionState> {
		const state = await this.getState();
		verifyRpcState(state, expected);
		return state;
	}

	async promptAndWaitForStart(message: string, timeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS): Promise<void> {
		if (this._phase !== "starting") {
			throw new RpcAdmissionClosedError("prompt", this._phase);
		}
		if (this.readiness) throw new Error("RPC child prompt has already been submitted");

		const promptRequestId = this.nextRequestId();
		const readiness: StartReadiness = {
			promptRequestId,
			promptAcknowledged: false,
			agentStarted: false,
			deferred: new Deferred<void>(),
		};
		this.readiness = readiness;
		const responsePromise = this.writeCommand({ type: "prompt", message }, promptRequestId);
		void responsePromise.catch((error) => readiness.deferred.reject(error));

		await withTimeout(
			readiness.deferred.promise,
			timeoutMs,
			() => new Error(`Timed out after ${timeoutMs}ms waiting for prompt acknowledgement and agent_start`),
		);
		await responsePromise;
	}

	async steer(message: string): Promise<void> {
		await this.deliverWhileActive({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.deliverWhileActive({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	/**
	 * Abort first, accept agent_settled as cancellation acknowledgement, and escalate
	 * only when neither settlement nor process exit arrives within the configured grace.
	 */
	interrupt(): Promise<RpcInterruptResult> {
		if (this.interruptTask) return this.interruptTask;
		const task = this.interruptOnce();
		this.interruptTask = task;
		void task.catch(() => {
			if (this.interruptTask === task) this.interruptTask = undefined;
		});
		return task;
	}

	private async interruptOnce(): Promise<RpcInterruptResult> {
		this.ensureStarted();
		this.terminationOwned = true;
		let abortAcknowledged = false;
		if (this._phase === "starting" || this._phase === "accepting") {
			void this.abort()
				.then(() => {
					abortAcknowledged = true;
				})
				.catch(() => {});
		}

		const initial = await this.waitForSettlementOrClose(this.options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
		if (initial !== "timeout") {
			return { settled: this.settledSeen, exited: this.closedSeen, abortAcknowledged };
		}

		this.sendSignal("SIGTERM");
		if (!(await this.waitForClosed(this.options.termGraceMs ?? DEFAULT_TERM_GRACE_MS))) {
			this.sendSignal("SIGKILL");
			if (!(await this.waitForClosed(this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS))) {
				this.closeTimedOut = true;
				const child = this.process;
				this.finalizeClose(child?.exitCode ?? null, child?.signalCode ?? "SIGKILL", true);
			}
		}
		return { settled: this.settledSeen, exited: this.closedSeen, abortAcknowledged };
	}

	/** Stop the worker for root shutdown and always resolve after bounded escalation. */
	async shutdown(): Promise<RpcExitInfo> {
		this.ensureStarted();
		this.terminationOwned = true;
		if (this.closedSeen) return this.closed;

		if (this._phase === "settling" || this.settledSeen) {
			if (this.options.autoCloseOnSettled === false) {
				await this.closeInputAndEscalate();
			}
			return this.closed;
		}

		const interrupted = await this.interrupt();
		if (!interrupted.exited && !this.settledSeen) {
			await this.closeInputAndEscalate();
		}
		return this.closed;
	}

	/** Explicitly perform the post-settlement drain/close when auto-close is disabled. */
	async closeAfterSettlement(): Promise<RpcExitInfo> {
		if (!this.settledSeen) throw new Error("Cannot close-after-settlement before agent_settled");
		await this.closeInputAndEscalate();
		return this.closed;
	}

	private attachProcess(child: SpawnedRpcProcess): void {
		this.decoder = new LfJsonlDecoder(
			(line) => this.handleLine(line),
			this.options.stdoutMaxRecordBytes ?? 8 * 1024 * 1024,
		);

		child.stdout.on("data", (chunk: string | Buffer) => {
			try {
				this.decoder?.feed(chunk);
			} catch (error) {
				this.handleFatalProtocolError(error);
			}
		});
		child.stdout.once("end", () => {
			try {
				this.decoder?.end();
			} catch (error) {
				this.handleFatalProtocolError(error);
			}
		});
		child.stderr.on("data", (chunk: string | Buffer) => this.appendStderr(chunk));
		child.stderr.once("end", () => this.finishStderr());
		child.stdin.once("error", (error: Error) => {
			if (!this.closedSeen && this._phase !== "closing") this.handleFatalProtocolError(error);
		});
		child.once("error", (error) => {
			this.stderr = appendBoundedUtf8(
				this.stderr,
				`Agent process error: ${error.message}`,
				this.options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
			);
		});
		child.once("close", (code, signal) => this.finalizeClose(code, signal, false));
	}

	private handleLine(line: string): void {
		if (line.length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.handleFatalProtocolError(new Error(`Invalid RPC JSONL record: ${errorMessage(error)}`));
			return;
		}

		if (isRecord(parsed) && parsed.type === "response") {
			this.handleResponse(parsed);
			return;
		}

		const event = sanitizeRpcEvent(parsed);
		if (!event) return;
		if (event.type === "agent_start") {
			const readiness = this.readiness;
			if (readiness) {
				readiness.agentStarted = true;
				this.resolveReadinessIfComplete(readiness);
			}
		}
		if (event.type === "agent_settled") this.beginSettlement();
		this.invokeEventCallback(event);
	}

	private handleResponse(response: Record<string, unknown>): void {
		const id = typeof response.id === "string" ? response.id : undefined;
		if (!id) {
			this.reportProtocolError(new Error("RPC response omitted its request id"));
			return;
		}
		const pending = this.pending.get(id);
		if (!pending) {
			this.reportProtocolError(new Error(`RPC response referenced unknown request id ${id}`));
			return;
		}

		const command = typeof response.command === "string" ? response.command : "unknown";
		if (command !== pending.snapshot.command) {
			const error = new RpcCommandError(
				pending.snapshot.command,
				id,
				`response command was ${command}`,
			);
			this.failPending(pending, error);
			this.reportProtocolError(error);
			return;
		}

		if (response.success === false) {
			const error = new RpcCommandError(
				command,
				id,
				typeof response.error === "string" ? response.error : "unknown RPC error",
			);
			this.failPending(pending, error);
			if (this.readiness?.promptRequestId === id) this.readiness.deferred.reject(error);
			return;
		}
		if (response.success !== true) {
			const error = new RpcCommandError(command, id, "response omitted a boolean success field");
			this.failPending(pending, error);
			this.reportProtocolError(error);
			return;
		}

		this.completePending(pending, response as RpcSuccessResponse);
		const readiness = this.readiness;
		if (readiness?.promptRequestId === id) {
			readiness.promptAcknowledged = true;
			this.resolveReadinessIfComplete(readiness);
		}
	}

	private beginSettlement(): void {
		if (this.settledSeen || this.closedSeen) return;
		this.settledSeen = true;
		this._phase = "settling";
		for (const record of this.commandHistory) {
			if (!this.pending.has(record.id) && record.state !== "drained") {
				record.state = "drained";
				record.drainedAt = Date.now();
			}
		}
		this.settledDeferred.resolve();
		try {
			this.options.onSettled?.(this.token);
		} catch (error) {
			this.reportProtocolError(new Error(`onSettled callback failed: ${errorMessage(error)}`));
		}
		if (this.options.autoCloseOnSettled !== false) {
			this.settlementCloseTask ??= this.closeInputAndEscalate();
			void this.settlementCloseTask.catch((error) => this.reportProtocolError(asError(error)));
		}
	}

	private resolveReadinessIfComplete(readiness: StartReadiness): void {
		if (!readiness.promptAcknowledged || !readiness.agentStarted) return;
		if (this._phase === "starting") this._phase = "accepting";
		readiness.deferred.resolve();
	}

	private writeCommand(command: RpcCommandInput, id: string): Promise<RpcSuccessResponse> {
		this.ensureStarted();
		if (this._phase !== "starting" && this._phase !== "accepting") {
			throw new RpcAdmissionClosedError(command.type, this._phase);
		}
		const child = this.process;
		if (!child || child.stdin.destroyed || !child.stdin.writable) {
			throw new Error(`RPC child stdin is not writable${this.stderr ? `. Stderr: ${this.stderr}` : ""}`);
		}

		const snapshot: RpcCommandSnapshot = {
			id,
			command: command.type,
			state: "written",
			writtenAt: Date.now(),
		};
		const pending: PendingCommand = { snapshot, deferred: new Deferred<RpcSuccessResponse>() };
		const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		if (timeoutMs > 0) {
			pending.timer = setTimeout(() => {
				this.failPending(
					pending,
					new RpcCommandError(command.type, id, `timed out waiting for a response after ${timeoutMs}ms`),
				);
			}, timeoutMs);
		}
		this.pending.set(id, pending);
		this.commandHistory.push(snapshot);

		const wireCommand = { ...command, id } as RpcCommand;
		try {
			child.stdin.write(`${JSON.stringify(wireCommand)}\n`, (error?: Error | null) => {
				if (error) this.failPending(pending, error);
			});
		} catch (error) {
			this.failPending(pending, asError(error));
		}
		return pending.deferred.promise;
	}

	private async deliverWhileActive(command: { type: "steer" | "follow_up"; message: string }): Promise<void> {
		const id = this.nextRequestId();
		await this.writeCommand(command, id);
		const snapshot = this.commandHistory.find((record) => record.id === id);
		if (snapshot?.responseAfterSettlement) {
			throw new RpcDeliveryRacedSettlementError(command.type, id);
		}
	}

	private completePending(pending: PendingCommand, response: RpcSuccessResponse): void {
		if (!this.pending.has(pending.snapshot.id)) return;
		if (pending.timer) clearTimeout(pending.timer);
		this.pending.delete(pending.snapshot.id);
		pending.snapshot.state = this.settledSeen ? "drained" : "acknowledged";
		if (
			this.settledSeen &&
			(pending.snapshot.command === "steer" || pending.snapshot.command === "follow_up")
		) {
			pending.snapshot.responseAfterSettlement = true;
		}
		pending.snapshot.completedAt = Date.now();
		if (this.settledSeen) pending.snapshot.drainedAt = pending.snapshot.completedAt;
		pending.deferred.resolve(response);
		this.notifyDrainWaiters();
	}

	private failPending(pending: PendingCommand, error: Error): void {
		if (!this.pending.has(pending.snapshot.id)) return;
		if (pending.timer) clearTimeout(pending.timer);
		this.pending.delete(pending.snapshot.id);
		pending.snapshot.state = this.settledSeen ? "drained" : "failed";
		pending.snapshot.completedAt = Date.now();
		pending.snapshot.error = error.message;
		if (this.settledSeen) pending.snapshot.drainedAt = pending.snapshot.completedAt;
		pending.deferred.reject(error);
		this.notifyDrainWaiters();
	}

	private nextRequestId(): string {
		const prefix = this.options.requestIdPrefix ?? `${this.token.workerGeneration}`;
		return `${prefix}-${++this.requestSequence}`;
	}

	private async closeInputAndEscalate(): Promise<void> {
		if (this.closedSeen) return;
		await this.drainPending(this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
		if (this.closedSeen) return;
		this._phase = "closing";
		const child = this.process;
		if (!child) return;
		if (!child.stdin.destroyed && child.stdin.writable) {
			try {
				child.stdin.end();
			} catch (error) {
				this.reportProtocolError(asError(error));
			}
		}

		if (await this.waitForClosed(this.options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS)) return;
		this.sendSignal("SIGTERM");
		if (await this.waitForClosed(this.options.termGraceMs ?? DEFAULT_TERM_GRACE_MS)) return;
		this.sendSignal("SIGKILL");
		if (await this.waitForClosed(this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)) return;

		this.closeTimedOut = true;
		this.finalizeClose(child.exitCode, child.signalCode ?? "SIGKILL", true);
	}

	private async drainPending(timeoutMs: number): Promise<void> {
		if (this.pending.size === 0) {
			this.markTerminalCommandsDrained();
			return;
		}
		const drained = await new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter = () => {
				if (this.pending.size !== 0) return;
				if (timer) clearTimeout(timer);
				this.drainWaiters.delete(waiter);
				resolve(true);
			};
			this.drainWaiters.add(waiter);
			timer = setTimeout(() => {
				this.drainWaiters.delete(waiter);
				resolve(false);
			}, Math.max(0, timeoutMs));
		});

		if (!drained) {
			for (const pending of [...this.pending.values()]) {
				this.failPending(
					pending,
					new RpcCommandError(
						pending.snapshot.command,
						pending.snapshot.id,
						`response did not drain within ${timeoutMs}ms after settlement`,
					),
				);
			}
		}
		this.markTerminalCommandsDrained();
	}

	private markTerminalCommandsDrained(): void {
		const now = Date.now();
		for (const record of this.commandHistory) {
			if (!this.pending.has(record.id) && record.state !== "drained") {
				record.state = "drained";
				record.drainedAt = now;
			}
		}
	}

	private notifyDrainWaiters(): void {
		if (this.pending.size !== 0) return;
		for (const waiter of [...this.drainWaiters]) waiter();
	}

	private sendSignal(signal: NodeJS.Signals): void {
		if (this.closedSeen) return;
		this.forced = true;
		try {
			this.process?.kill(signal);
		} catch (error) {
			this.reportProtocolError(asError(error));
		}
	}

	private async waitForSettlementOrClose(timeoutMs: number): Promise<"settled" | "closed" | "timeout"> {
		if (this.settledSeen) return "settled";
		if (this.closedSeen) return "closed";
		return withTimeout(
			Promise.race([
				this.settled.then(() => "settled" as const),
				this.closed.then(() => "closed" as const),
			]),
			timeoutMs,
			() => "timeout" as const,
			true,
		);
	}

	private async waitForClosed(timeoutMs: number): Promise<boolean> {
		if (this.closedSeen) return true;
		return withTimeout(
			this.closed.then(() => true),
			timeoutMs,
			() => false,
			true,
		);
	}

	private finalizeClose(code: number | null, signal: NodeJS.Signals | null, timedOut: boolean): void {
		if (this.closedSeen) return;
		this.finishStderr();
		this.closedSeen = true;
		this._phase = "closed";
		this.closeTimedOut ||= timedOut;
		try {
			this.decoder?.end();
		} catch {
			// A prior protocol failure already owns diagnostics.
		}

		const exit: RpcExitInfo = {
			code,
			signal,
			expected: this.settledSeen || this.terminationOwned,
			settled: this.settledSeen,
			forced: this.forced,
			timedOut: this.closeTimedOut,
			stderr: this.stderr,
		};
		const exitError = new RpcProcessExitError(exit);
		for (const pending of [...this.pending.values()]) this.failPending(pending, exitError);
		this.readiness?.deferred.reject(exitError);
		this.closedDeferred.resolve(exit);

		if (!exit.expected) {
			try {
				this.options.onUnexpectedExit?.(exitError, this.token);
			} catch (error) {
				this.reportProtocolError(new Error(`onUnexpectedExit callback failed: ${errorMessage(error)}`));
			}
		}
		try {
			this.options.onExit?.(exit, this.token);
		} catch (error) {
			this.reportProtocolError(new Error(`onExit callback failed: ${errorMessage(error)}`));
		}
	}

	private handleFatalProtocolError(error: unknown): void {
		const protocolError = asError(error);
		this.reportProtocolError(protocolError);
		for (const pending of [...this.pending.values()]) this.failPending(pending, protocolError);
		this.readiness?.deferred.reject(protocolError);
		this.terminationOwned = true;
		this.protocolTerminationTask ??= this.terminateAfterProtocolError();
		void this.protocolTerminationTask.catch((cleanupError) => this.reportProtocolError(asError(cleanupError)));
	}

	private async terminateAfterProtocolError(): Promise<void> {
		this.sendSignal("SIGTERM");
		if (await this.waitForClosed(this.options.termGraceMs ?? DEFAULT_TERM_GRACE_MS)) return;
		this.sendSignal("SIGKILL");
		if (await this.waitForClosed(this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)) return;
		this.closeTimedOut = true;
		const child = this.process;
		this.finalizeClose(child?.exitCode ?? null, child?.signalCode ?? "SIGKILL", true);
	}

	private appendStderr(chunk: string | Buffer): void {
		if (this.stderrEnded) return;
		const text = this.stderrDecoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		this.stderr = appendBoundedUtf8(
			this.stderr,
			text,
			this.options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
		);
	}

	private finishStderr(): void {
		if (this.stderrEnded) return;
		this.stderrEnded = true;
		this.stderr = appendBoundedUtf8(
			this.stderr,
			this.stderrDecoder.end(),
			this.options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
		);
	}

	private reportProtocolError(error: Error): void {
		try {
			this.options.onProtocolError?.(error, this.token);
		} catch {
			// Protocol diagnostics must never destabilize worker cleanup.
		}
	}

	private invokeEventCallback(event: SanitizedRpcEvent): void {
		try {
			this.options.onEvent?.(event, this.token);
		} catch (error) {
			this.reportProtocolError(new Error(`onEvent callback failed: ${errorMessage(error)}`));
		}
	}

	private ensureStarted(): void {
		if (this._phase === "created") throw new Error("RPC child has not been started");
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function appendBoundedUtf8(current: string, addition: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const combined = Buffer.from(current + addition, "utf8");
	if (combined.length <= maxBytes) return combined.toString("utf8");
	let start = combined.length - maxBytes;
	while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
	return combined.subarray(start).toString("utf8");
}

async function withTimeout<T, TFallback = never>(
	promise: Promise<T>,
	timeoutMs: number,
	makeTimeout: () => Error | TFallback,
	returnFallback = false,
): Promise<T | TFallback> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<TFallback>((resolve, reject) => {
				timer = setTimeout(() => {
					const timeout = makeTimeout();
					if (returnFallback) resolve(timeout as TFallback);
					else reject(timeout);
				}, Math.max(0, timeoutMs));
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
