import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const TOOL_NAME = "sagent";
const WAIT_TOOL_NAME = "sagent_wait";
const STATUS_TOOL_NAME = "sagent_status";
const WIDGET_KEY = "pi-sagent";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SAGENT_TOOL_NAMES = new Set([TOOL_NAME, WAIT_TOOL_NAME, STATUS_TOOL_NAME]);

const OPTIONAL = Symbol("optional-schema-property");
type Schema = Record<string, unknown> & { [OPTIONAL]?: boolean };

const Type = {
	Object(properties: Record<string, Schema>, options: Record<string, unknown> = {}): Schema {
		const required = Object.entries(properties)
			.filter(([, schema]) => !schema[OPTIONAL])
			.map(([key]) => key);
		const cleanProperties: Record<string, Schema> = {};
		for (const [key, schema] of Object.entries(properties)) {
			const { [OPTIONAL]: _optional, ...clean } = schema;
			cleanProperties[key] = clean as Schema;
		}
		return {
			type: "object",
			properties: cleanProperties,
			required,
			additionalProperties: false,
			...options,
		};
	},
	Optional(schema: Schema): Schema {
		return { ...schema, [OPTIONAL]: true };
	},
	Array(items: Schema, options: Record<string, unknown> = {}): Schema {
		return { type: "array", items, ...options };
	},
	String(options: Record<string, unknown> = {}): Schema {
		return { type: "string", ...options };
	},
	Number(options: Record<string, unknown> = {}): Schema {
		return { type: "number", ...options };
	},
	Integer(options: Record<string, unknown> = {}): Schema {
		return { type: "integer", ...options };
	},
	Union(anyOf: Schema[], options: Record<string, unknown> = {}): Schema {
		return { anyOf, ...options };
	},
	Literal(value: string | number | boolean): Schema {
		return { const: value };
	},
};

function StringEnum(values: readonly string[], options: Record<string, unknown> = {}): Schema {
	return { type: "string", enum: [...values], ...options };
}

type SystemPromptMode = "append" | "replace";
type TaskStateName = "queued" | "running" | "timeout" | "completed" | "failed" | "aborted";
type RunStateName = "running" | "completed" | "failed" | "aborted";
type WaitOutcomeKind = "completed" | "failed" | "soft-timeout" | "aborted" | "queued-blocked-by-concurrency";

type OnUpdateCallback = ((partial: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void) | undefined;

type SagentParams = {
	maxDepth?: number;
	concurrency?: number;
	tasks?: Array<SagentInputTask>;
	name?: string;
	description?: string;
	prompt?: string;
	systemPrompt?: string;
	systemPromptMode?: SystemPromptMode;
	tools?: string[];
	model?: string;
	cwd?: string;
	timeoutMs?: number;
};

type SagentInputTask = {
	name?: string;
	description?: string;
	prompt: string;
	systemPrompt?: string;
	systemPromptMode?: SystemPromptMode;
	tools?: string[];
	model?: string;
	cwd?: string;
	timeoutMs?: number;
};

type SagentWaitParams = {
	id: string;
	task?: number | string;
	timeoutMs?: number;
};

type SagentStatusParams = {
	id?: string;
};

type SagentTaskState = {
	index: number;
	name: string;
	safeName: string;
	description?: string;
	state: TaskStateName;
	cwd: string;
	model?: string;
	systemPrompt?: string;
	systemPromptMode?: SystemPromptMode;
	tools: string[];
	timeoutMs?: number;
	maxDepth: number;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	exitCode?: number;
	error?: string;
	resultText?: string;
	taskDir: string;
	tmuxSession?: string;
	attachCommand?: string;
	promptPath: string;
	wrapperPath: string;
	commandPath: string;
	stderrPath: string;
	donePath: string;
	softTimedOutAt?: string;
	lastSoftTimeoutMs?: number;
	lastWaitStartedAt?: string;
	lastWaitFinishedAt?: string;
	logPath: string;
	wrapperLogPath: string;
	jsonlPath: string;
	resultPath: string;
};

type SagentRunState = {
	id: string;
	state: RunStateName;
	createdAt: string;
	updatedAt: string;
	cwd: string;
	rootDir: string;
	statusPath: string;
	concurrency: number;
	maxDepth: number;
	tasks: SagentTaskState[];
};

type WaitOutcome = {
	kind: WaitOutcomeKind;
	task: SagentTaskState;
	timeoutMs?: number;
	liveCount?: number;
};

type WaitForTaskOptions = {
	timeoutMs?: number;
	deadlineAt?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	ctx?: any;
	pi?: ExtensionAPI;
	launchIfQueued?: boolean;
	setWaitStarted?: boolean;
};

type WaitForRunOptions = {
	timeoutMs?: number;
	useTaskTimeouts?: boolean;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	ctx?: any;
	pi?: ExtensionAPI;
};

const runsById = new Map<string, SagentRunState>();
const runLocks = new Map<string, Promise<void>>();

async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
	const previous = runLocks.get(runId) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const next = previous.catch(() => undefined).then(() => current);
	runLocks.set(runId, next);
	await previous.catch(() => undefined);
	try {
		return await fn();
	} finally {
		release();
		if (runLocks.get(runId) === next) runLocks.delete(runId);
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	if (!isFiniteNumber(value)) return undefined;
	const n = Math.floor(value);
	return n > 0 ? n : undefined;
}

function getPollIntervalMs(): number {
	return positiveIntegerOrUndefined(Number(process.env.PI_SAGENT_POLL_INTERVAL_MS)) ?? DEFAULT_POLL_INTERVAL_MS;
}

function getTmuxBin(): string {
	return process.env.PI_SAGENT_TMUX_BIN || "tmux";
}

function getPiBin(): string {
	return process.env.PI_SAGENT_PI_BIN || "pi";
}

function getRunsRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-sagent", "runs");
}

function sanitizeName(input: string | undefined, fallback = "task"): string {
	const base = (input || fallback).trim() || fallback;
	const safe = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return (safe || fallback).slice(0, 60);
}

function makeRunId(): string {
	return `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function makeTmuxSessionName(runId: string, task: Pick<SagentTaskState, "index" | "safeName">): string {
	const runPart = runId.replace(/^run-/, "").replace(/[^A-Za-z0-9_.-]+/g, "-");
	const raw = `pi-sagent-${runPart}-${task.index}-${task.safeName}`;
	return raw.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 200);
}

function shellQuote(value: string): string {
	if (value === "") return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function attachCommandFor(session: string): string {
	return `tmux attach-session -t ${shellQuote(session)}`;
}

function resolveCwd(defaultCwd: string, cwd?: string): string {
	return path.resolve(defaultCwd, cwd || ".");
}

function normalizeMaxDepth(value: unknown): number {
	if (isFiniteNumber(value)) return Math.max(0, Math.floor(value));
	const fromEnv = Number(process.env.PI_SAGENT_MAX_DEPTH);
	if (Number.isFinite(fromEnv)) return Math.max(0, Math.floor(fromEnv));
	return DEFAULT_MAX_DEPTH;
}

function normalizeToolList(rawTools: string[] | undefined, pi: ExtensionAPI | undefined, remainingDepth: number): string[] {
	let tools: string[];
	if (Array.isArray(rawTools)) {
		tools = rawTools;
	} else {
		try {
			tools = pi?.getActiveTools?.() ?? DEFAULT_BUILTIN_TOOLS;
		} catch {
			tools = DEFAULT_BUILTIN_TOOLS;
		}
	}

	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const tool of tools) {
		if (typeof tool !== "string") continue;
		const trimmed = tool.trim();
		if (!trimmed) continue;
		if (remainingDepth <= 0 && SAGENT_TOOL_NAMES.has(trimmed)) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function terminalState(state: TaskStateName): boolean {
	return state === "completed" || state === "failed" || state === "aborted";
}

function computeRunState(run: SagentRunState): RunStateName {
	if (run.tasks.some((task) => !terminalState(task.state))) return "running";
	if (run.tasks.some((task) => task.state === "aborted")) return "aborted";
	if (run.tasks.some((task) => task.state === "failed")) return "failed";
	return "completed";
}

function touchRun(run: SagentRunState): void {
	run.updatedAt = nowIso();
	run.state = computeRunState(run);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readJsonFile<T>(filePath: string): Promise<T> {
	return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await fsp.rename(tmp, filePath);
}

async function persistRun(run: SagentRunState): Promise<void> {
	touchRun(run);
	await writeJsonAtomic(run.statusPath, run);
	runsById.set(run.id, run);
}

function isSafeRunId(id: string): boolean {
	return /^run-[A-Za-z0-9][A-Za-z0-9-]*$/.test(id);
}

async function loadRun(id: string): Promise<SagentRunState> {
	if (typeof id !== "string") throw new Error("Invalid pi-sagent run id: expected a string");
	const cleanId = id.trim();
	if (!isSafeRunId(cleanId)) throw new Error(`Invalid pi-sagent run id: ${cleanId}`);
	const inMemory = runsById.get(cleanId);
	if (inMemory) return inMemory;
	const statusPath = path.join(getRunsRoot(), cleanId, "status.json");
	if (!(await pathExists(statusPath))) throw new Error(`Unknown pi-sagent run: ${cleanId}`);
	const run = await readJsonFile<SagentRunState>(statusPath);
	// Keep compatibility with early status files that lacked statusPath/rootDir.
	run.rootDir ||= path.dirname(statusPath);
	run.statusPath ||= statusPath;
	for (const task of run.tasks) {
		task.wrapperLogPath ||= path.join(task.taskDir, "wrapper.log");
		task.logPath ||= task.stderrPath || task.wrapperLogPath;
		task.stderrPath ||= path.join(task.taskDir, "child.stderr.log");
		task.jsonlPath ||= path.join(task.taskDir, "child.jsonl");
		task.resultPath ||= path.join(task.taskDir, "result.md");
		task.donePath ||= path.join(task.taskDir, "done.json");
		task.promptPath ||= path.join(task.taskDir, "prompt.md");
		task.wrapperPath ||= path.join(task.taskDir, "run.sh");
		task.commandPath ||= path.join(task.taskDir, "command.txt");
		if ((task.state === "running" || task.state === "timeout") && task.tmuxSession && !task.attachCommand) task.attachCommand = attachCommandFor(task.tmuxSession);
		if (terminalState(task.state)) task.attachCommand = undefined;
	}
	runsById.set(cleanId, run);
	return run;
}

async function listRuns(): Promise<SagentRunState[]> {
	const root = getRunsRoot();
	if (!(await pathExists(root))) return [];
	const entries = await fsp.readdir(root, { withFileTypes: true });
	const runs: SagentRunState[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const statusPath = path.join(root, entry.name, "status.json");
		if (!(await pathExists(statusPath))) continue;
		try {
			runs.push(await loadRun(entry.name));
		} catch {
			// Ignore unreadable historical runs in list mode.
		}
	}
	return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function execTmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
	const bin = getTmuxBin();
	try {
		const result = await execFileAsync(bin, args, { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (error: any) {
		const message = error?.stderr || error?.message || String(error);
		const wrapped = new Error(`tmux ${args.join(" ")} failed: ${message}`);
		(wrapped as any).code = error?.code;
		(wrapped as any).stdout = error?.stdout;
		(wrapped as any).stderr = error?.stderr;
		throw wrapped;
	}
}

async function assertTmuxAvailable(): Promise<void> {
	try {
		await execTmux(["-V"]);
	} catch (error: any) {
		throw new Error(`pi-sagent requires tmux. Set PI_SAGENT_TMUX_BIN to a tmux-compatible binary. ${error?.message || error}`);
	}
}

async function tmuxSessionExists(session: string | undefined): Promise<boolean> {
	if (!session) return false;
	try {
		await execTmux(["has-session", "-t", session]);
		return true;
	} catch {
		return false;
	}
}

async function newTmuxSession(session: string, cwd: string, wrapperPath: string): Promise<void> {
	const command = `bash ${shellQuote(wrapperPath)}`;
	await execTmux(["new-session", "-d", "-s", session, "-c", cwd, command]);
}

async function killTmuxSession(session: string | undefined): Promise<void> {
	if (!session) return;
	try {
		await execTmux(["kill-session", "-t", session]);
	} catch {
		// Best-effort kill. Reconciliation will record missing tmux if needed.
	}
}

function buildPiArgs(task: SagentTaskState): string[] {
	const args = ["-p", "--mode", "json", "--no-session", "--approve"];
	if (task.model) args.push("--model", task.model);
	if (task.systemPrompt) {
		if (task.systemPromptMode === "replace") args.push("--system-prompt", task.systemPrompt);
		else args.push("--append-system-prompt", task.systemPrompt);
	}
	args.push("--tools", task.tools.join(","));
	args.push(`@${task.promptPath}`);
	return args;
}

async function writeWrapperFiles(task: SagentTaskState, prompt: string): Promise<void> {
	await fsp.mkdir(task.taskDir, { recursive: true, mode: 0o700 });
	await fsp.writeFile(task.promptPath, prompt, { encoding: "utf8", mode: 0o600 });

	const piBin = getPiBin();
	const piArgs = buildPiArgs(task);
	const commandDisplay = [piBin, ...piArgs].map(shellQuote).join(" ");
	await fsp.writeFile(task.commandPath, `${commandDisplay}\n`, { encoding: "utf8", mode: 0o600 });

	const script = `#!/usr/bin/env bash
set -u
JSONL_PATH=${shellQuote(task.jsonlPath)}
STDERR_PATH=${shellQuote(task.stderrPath)}
WRAPPER_LOG=${shellQuote(task.wrapperLogPath)}
DONE_PATH=${shellQuote(task.donePath)}
RESULT_PATH=${shellQuote(task.resultPath)}
export PI_SAGENT_MAX_DEPTH=${shellQuote(String(task.maxDepth))}
export PI_SAGENT_TMUX_BIN=${shellQuote(getTmuxBin())}
export PI_SAGENT_PI_BIN=${shellQuote(getPiBin())}
started_at="$(node -e 'console.log(new Date().toISOString())')"
printf '[%s] starting child pi\n' "$started_at" >> "$WRAPPER_LOG"
printf '[%s] command: %s\n' "$started_at" ${shellQuote(commandDisplay)} >> "$WRAPPER_LOG"
set +e
${commandDisplay} > "$JSONL_PATH" 2> "$STDERR_PATH"
exit_code=$?
set -e
finished_at="$(node -e 'console.log(new Date().toISOString())')"
state="completed"
if [ "$exit_code" -ne 0 ]; then
  state="failed"
fi
printf '[%s] child exited with code %s\n' "$finished_at" "$exit_code" >> "$WRAPPER_LOG"
tmp_done="$DONE_PATH.tmp.$$"
node - "$tmp_done" "$DONE_PATH" "$state" "$exit_code" "$started_at" "$finished_at" "$RESULT_PATH" "$JSONL_PATH" "$STDERR_PATH" <<'NODE'
const fs = require('node:fs');
const [tmp, done, state, exitCode, startedAt, finishedAt, resultPath, jsonlPath, stderrPath] = process.argv.slice(2);
const payload = { state, exitCode: Number(exitCode), startedAt, finishedAt, resultPath, jsonlPath, stderrPath };
fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\\n", { encoding: 'utf8', mode: 0o600 });
fs.renameSync(tmp, done);
NODE
exit "$exit_code"
`;
	await fsp.writeFile(task.wrapperPath, script, { encoding: "utf8", mode: 0o700 });
	await fsp.chmod(task.wrapperPath, 0o700);
}

function getTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
			parts.push((part as any).text);
		}
	}
	return parts.join("");
}

function getAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as any;
	if (msg.role && msg.role !== "assistant") return "";
	return getTextFromContent(msg.content).trim();
}

function extractDeltaText(event: any): string {
	if (typeof event?.delta === "string") return event.delta;
	if (typeof event?.text === "string") return event.text;
	if (typeof event?.content === "string") return event.content;
	const ame = event?.assistantMessageEvent;
	if (typeof ame?.text === "string") return ame.text;
	if (typeof ame?.delta === "string") return ame.delta;
	if (typeof ame?.delta?.text === "string") return ame.delta.text;
	if (typeof ame?.content === "string") return ame.content;
	const fromMessage = getAssistantText(event?.message);
	return fromMessage;
}

async function extractResultFromJsonl(jsonlPath: string): Promise<string> {
	const text = await fsp.readFile(jsonlPath, "utf8");
	let latestAgentEndText = "";
	let latestMessageEndText = "";
	let accumulatedDeltas = "";
	let latestMessageUpdateText = "";

	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "agent_end") {
			const messages = Array.isArray(event.messages) ? event.messages : event.message ? [event.message] : [];
			for (const message of messages) {
				const assistantText = getAssistantText(message);
				if (assistantText) latestAgentEndText = assistantText;
			}
		}
		if (event.type === "message_end") {
			const assistantText = getAssistantText(event.message);
			if (assistantText) latestMessageEndText = assistantText;
		}
		if (event.type === "message_update") {
			const delta = extractDeltaText(event);
			if (delta) {
				if (getAssistantText(event.message)) latestMessageUpdateText = getAssistantText(event.message);
				else accumulatedDeltas += delta;
			}
		}
	}

	return (latestAgentEndText || latestMessageEndText || latestMessageUpdateText || accumulatedDeltas).trim();
}

function failureDiagnostic(run: SagentRunState, task: SagentTaskState, reason: string): string {
	const exit = task.exitCode === undefined ? "unknown" : String(task.exitCode);
	return [
		`# pi-sagent failed: ${task.name}`,
		"",
		`Run: ${run.id}`,
		`Task selector: ${task.index}`,
		"Status: failed",
		`Exit code: ${exit}`,
		`Error: ${reason}`,
		`Artifacts: ${task.taskDir}`,
		`Result file: ${task.resultPath}`,
		`JSONL log: ${task.jsonlPath}`,
		`Stderr log: ${task.stderrPath}`,
		"",
		"<status>",
		"The subagent failed. Full child JSONL and stderr are preserved on disk at the paths above.",
		"</status>",
	].join("\n");
}

function abortedDiagnostic(run: SagentRunState, task: SagentTaskState): string {
	return [
		`# pi-sagent aborted: ${task.name}`,
		"",
		`Run: ${run.id}`,
		`Task selector: ${task.index}`,
		"Status: aborted",
		`Artifacts: ${task.taskDir}`,
		`Result file: ${task.resultPath}`,
		`JSONL log: ${task.jsonlPath}`,
		`Stderr log: ${task.stderrPath}`,
		"",
		"<status>",
		"The subagent was aborted by the parent tool call. Any tmux session in this abort scope was killed best-effort.",
		"</status>",
	].join("\n");
}

async function ensureResultFile(task: SagentTaskState, text: string): Promise<void> {
	await fsp.mkdir(path.dirname(task.resultPath), { recursive: true });
	await fsp.writeFile(task.resultPath, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
}

async function markMissingTmuxFailure(run: SagentRunState, task: SagentTaskState): Promise<SagentTaskState> {
	task.state = "failed";
	task.attachCommand = undefined;
	task.finishedAt ||= nowIso();
	task.error = "tmux session ended without done.json";
	task.resultText = failureDiagnostic(run, task, task.error);
	await ensureResultFile(task, task.resultText);
	return task;
}

async function refreshTaskFromArtifacts(run: SagentRunState, task: SagentTaskState): Promise<SagentTaskState> {
	if (terminalState(task.state) && task.state !== "failed") {
		task.attachCommand = undefined;
		return task;
	}

	if (await pathExists(task.donePath)) {
		let done: any;
		try {
			done = await readJsonFile<any>(task.donePath);
		} catch (error: any) {
			task.state = "failed";
			task.attachCommand = undefined;
			task.finishedAt ||= nowIso();
			task.error = `could not parse done.json: ${error?.message || error}`;
			task.resultText = failureDiagnostic(run, task, task.error);
			await ensureResultFile(task, task.resultText);
			return task;
		}

		task.exitCode = Number.isFinite(Number(done.exitCode)) ? Number(done.exitCode) : undefined;
		task.startedAt ||= done.startedAt;
		task.finishedAt ||= done.finishedAt || nowIso();
		if (done.resultPath) task.resultPath = done.resultPath;
		if (done.jsonlPath) task.jsonlPath = done.jsonlPath;
		if (done.stderrPath) {
			task.stderrPath = done.stderrPath;
			task.logPath = task.stderrPath;
		}

		let extracted = "";
		let parseError = "";
		try {
			extracted = await extractResultFromJsonl(task.jsonlPath);
		} catch (error: any) {
			parseError = error?.message || String(error);
		}

		if (task.exitCode === 0 && extracted) {
			task.state = "completed";
			task.error = undefined;
			task.resultText = extracted;
			await ensureResultFile(task, extracted);
		} else {
			task.state = "failed";
			const reason = task.exitCode !== 0 ? `child pi exited with code ${task.exitCode ?? "unknown"}` : parseError ? `no final assistant result extracted (${parseError})` : "no final assistant result extracted";
			task.error = reason;
			task.resultText = failureDiagnostic(run, task, reason);
			await ensureResultFile(task, task.resultText);
		}
		task.attachCommand = undefined;
		task.lastWaitFinishedAt ||= task.finishedAt;
		return task;
	}

	if (task.tmuxSession) {
		const exists = await tmuxSessionExists(task.tmuxSession);
		if (exists) {
			if (task.state !== "timeout") task.state = "running";
			task.attachCommand = attachCommandFor(task.tmuxSession);
			return task;
		}
	}

	if (task.state === "running" || task.state === "timeout") {
		await markMissingTmuxFailure(run, task);
	}
	return task;
}

async function refreshRunFromArtifacts(run: SagentRunState): Promise<SagentRunState> {
	for (const task of run.tasks) await refreshTaskFromArtifacts(run, task);
	touchRun(run);
	return run;
}

async function liveTaskCount(run: SagentRunState): Promise<number> {
	let count = 0;
	for (const task of run.tasks) {
		if (!task.tmuxSession) continue;
		if (await pathExists(task.donePath)) continue;
		if (await tmuxSessionExists(task.tmuxSession)) count++;
	}
	return count;
}

function runDetails(run: SagentRunState, selectedTask?: SagentTaskState): unknown {
	return {
		id: run.id,
		state: run.state,
		concurrency: run.concurrency,
		runDir: run.rootDir,
		statusPath: run.statusPath,
		selectedTask: selectedTask?.index,
		tasks: run.tasks.map((task) => ({
			index: task.index,
			name: task.name,
			state: task.state,
			tmuxSession: task.tmuxSession,
			attachCommand: task.state === "running" || task.state === "timeout" ? task.attachCommand : undefined,
			taskDir: task.taskDir,
			promptPath: task.promptPath,
			wrapperPath: task.wrapperPath,
			commandPath: task.commandPath,
			jsonlPath: task.jsonlPath,
			stderrPath: task.stderrPath,
			resultPath: task.resultPath,
			donePath: task.donePath,
			error: task.error,
			softTimedOutAt: task.softTimedOutAt,
			lastSoftTimeoutMs: task.lastSoftTimeoutMs,
			lastWaitStartedAt: task.lastWaitStartedAt,
			lastWaitFinishedAt: task.lastWaitFinishedAt,
		})),
	};
}

async function widgetLines(run: SagentRunState): Promise<string[]> {
	const live = await liveTaskCount(run);
	const completed = run.tasks.filter((task) => task.state === "completed").length;
	const lines = [`${run.id}: ${run.state} ${completed}/${run.tasks.length} live ${live}/${run.concurrency}`];
	for (const task of run.tasks) {
		if (task.state === "running") lines.push(`  ● ${task.name}: running ${task.tmuxSession ?? ""}`.trimEnd());
		else if (task.state === "timeout") lines.push(`  ◌ ${task.name}: timeout ${task.tmuxSession ?? ""}`.trimEnd());
		else if (task.state === "queued") lines.push(`  ○ ${task.name}: queued (waiting for live slot)`);
		else if (task.state === "completed") lines.push(`  ✓ ${task.name}: completed`);
		else if (task.state === "failed") lines.push(`  ✗ ${task.name}: failed`);
		else if (task.state === "aborted") lines.push(`  ⊘ ${task.name}: aborted`);
	}
	return ["pi-sagent", ...lines];
}

async function updateWidget(ctx: any, run: SagentRunState): Promise<void> {
	try {
		ctx?.ui?.setWidget?.(WIDGET_KEY, await widgetLines(run));
	} catch {
		// Widget updates are best-effort and never affect tool semantics.
	}
}

async function emitUpdate(run: SagentRunState, onUpdate: OnUpdateCallback, ctx: any, message?: string): Promise<void> {
	await updateWidget(ctx, run);
	if (!onUpdate) return;
	const text = message || formatStatusText(run, { compact: true });
	onUpdate({ content: [{ type: "text", text }], details: runDetails(run) });
}

async function launchTask(run: SagentRunState, task: SagentTaskState, onUpdate?: OnUpdateCallback, ctx?: any): Promise<SagentTaskState> {
	if (task.state !== "queued") return task;
	const session = makeTmuxSessionName(run.id, task);
	try {
		await newTmuxSession(session, task.cwd, task.wrapperPath);
	} catch (error: any) {
		task.tmuxSession = undefined;
		task.attachCommand = undefined;
		task.startedAt ||= nowIso();
		task.state = "failed";
		task.finishedAt = nowIso();
		task.error = `tmux launch failed: ${error?.message || error}`;
		task.resultText = failureDiagnostic(run, task, task.error);
		await ensureResultFile(task, task.resultText);
		await persistRun(run);
		return task;
	}
	task.tmuxSession = session;
	task.attachCommand = attachCommandFor(session);
	task.startedAt = nowIso();
	task.state = "running";
	await persistRun(run);
	await emitUpdate(
		run,
		onUpdate,
		ctx,
		[
			`pi-sagent ${run.id}: launched ${task.name}`,
			`Tmux session: ${session}`,
			`Attach: ${task.attachCommand}`,
			`Artifacts: ${task.taskDir}`,
		].join("\n"),
	);
	return task;
}

async function advanceRunQueue(
	run: SagentRunState,
	options: { onUpdate?: OnUpdateCallback; ctx?: any; onlyTaskIndex?: number } = {},
): Promise<SagentTaskState[]> {
	return withRunLock(run.id, async () => {
		await refreshRunFromArtifacts(run);
		const launched: SagentTaskState[] = [];
		const hasLaunchCandidate = run.tasks.some((candidate) =>
			options.onlyTaskIndex !== undefined
				? candidate.index === options.onlyTaskIndex && candidate.state === "queued"
				: candidate.state === "queued",
		);
		const hasAnyLaunchAttempt = run.tasks.some((candidate) => candidate.tmuxSession || candidate.state !== "queued");
		if (hasLaunchCandidate && !hasAnyLaunchAttempt) await assertTmuxAvailable();

		while ((await liveTaskCount(run)) < run.concurrency) {
			const task =
				options.onlyTaskIndex !== undefined
					? run.tasks.find((candidate) => candidate.index === options.onlyTaskIndex && candidate.state === "queued")
					: run.tasks.find((candidate) => candidate.state === "queued");
			if (!task) break;
			await launchTask(run, task, options.onUpdate, options.ctx);
			launched.push(task);
			if (options.onlyTaskIndex !== undefined) break;
		}
		await persistRun(run);
		return launched;
	});
}

function abortError(): Error {
	const error = new Error("pi-sagent tool call aborted");
	(error as any).name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function markTaskSoftTimeout(
	run: SagentRunState,
	task: SagentTaskState,
	timeoutMs: number | undefined,
): Promise<void> {
	const tmuxAlive = await tmuxSessionExists(task.tmuxSession);
	if (!tmuxAlive) {
		await refreshTaskFromArtifacts(run, task);
		return;
	}
	task.state = "timeout";
	task.softTimedOutAt = nowIso();
	task.lastSoftTimeoutMs = timeoutMs;
	task.lastWaitFinishedAt = task.softTimedOutAt;
	if (task.tmuxSession) task.attachCommand = attachCommandFor(task.tmuxSession);
	if (!(await pathExists(task.resultPath))) await ensureResultFile(task, formatTimeoutText(run, task, timeoutMs));
	await persistRun(run);
}

async function waitForTask(run: SagentRunState, task: SagentTaskState, options: WaitForTaskOptions = {}): Promise<WaitOutcome> {
	throwIfAborted(options.signal);
	await refreshTaskFromArtifacts(run, task);
	if (terminalState(task.state)) return { kind: task.state === "completed" ? "completed" : task.state === "aborted" ? "aborted" : "failed", task };

	if (task.state === "queued") {
		const live = await liveTaskCount(run);
		if (live >= run.concurrency) return { kind: "queued-blocked-by-concurrency", task, liveCount: live };
		if (options.launchIfQueued === false) return { kind: "queued-blocked-by-concurrency", task, liveCount: live };
		await advanceRunQueue(run, { onUpdate: options.onUpdate, ctx: options.ctx, onlyTaskIndex: task.index });
		await refreshTaskFromArtifacts(run, task);
	}

	if (options.setWaitStarted !== false && (task.state === "running" || task.state === "timeout")) {
		task.lastWaitStartedAt = nowIso();
		await persistRun(run);
		await emitUpdate(run, options.onUpdate, options.ctx);
	}

	const deadlineAt = options.deadlineAt ?? (positiveIntegerOrUndefined(options.timeoutMs) ? Date.now() + positiveIntegerOrUndefined(options.timeoutMs)! : undefined);
	while (true) {
		throwIfAborted(options.signal);
		await refreshTaskFromArtifacts(run, task);
		if (terminalState(task.state)) {
			task.lastWaitFinishedAt = nowIso();
			await persistRun(run);
			return { kind: task.state === "completed" ? "completed" : task.state === "aborted" ? "aborted" : "failed", task };
		}

		if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
			await markTaskSoftTimeout(run, task, options.timeoutMs);
			if (task.state === "timeout") return { kind: "soft-timeout", task, timeoutMs: options.timeoutMs };
			if (terminalState(task.state)) return { kind: task.state === "completed" ? "completed" : task.state === "aborted" ? "aborted" : "failed", task };
		}

		const pollIntervalMs = getPollIntervalMs();
		const delay = deadlineAt === undefined ? pollIntervalMs : Math.max(1, Math.min(pollIntervalMs, deadlineAt - Date.now()));
		await sleep(delay, options.signal);
	}
}

async function waitForRun(run: SagentRunState, options: WaitForRunOptions = {}): Promise<{ run: SagentRunState; outcomes: WaitOutcome[] }> {
	const outcomes = new Map<number, WaitOutcome>();
	const runDeadlineAt = positiveIntegerOrUndefined(options.timeoutMs) ? Date.now() + positiveIntegerOrUndefined(options.timeoutMs)! : undefined;
	const taskDeadlineByIndex = new Map<number, number>();
	const waitStartedThisCall = new Set<number>();

	const setWaitStartedForLive = async () => {
		for (const task of run.tasks) {
			if (task.state === "running" || task.state === "timeout") {
				if (!waitStartedThisCall.has(task.index)) {
					task.lastWaitStartedAt = nowIso();
					waitStartedThisCall.add(task.index);
				}
				if (options.useTaskTimeouts && positiveIntegerOrUndefined(task.timeoutMs) && !taskDeadlineByIndex.has(task.index)) {
					taskDeadlineByIndex.set(task.index, Date.now() + positiveIntegerOrUndefined(task.timeoutMs)!);
				}
			}
		}
		await persistRun(run);
	};

	await refreshRunFromArtifacts(run);
	await advanceRunQueue(run, { onUpdate: options.onUpdate, ctx: options.ctx });
	await setWaitStartedForLive();
	await emitUpdate(run, options.onUpdate, options.ctx);

	while (true) {
		throwIfAborted(options.signal);
		await refreshRunFromArtifacts(run);

		for (const task of run.tasks) {
			if (terminalState(task.state) && !outcomes.has(task.index)) {
				if (waitStartedThisCall.has(task.index)) task.lastWaitFinishedAt = nowIso();
				outcomes.set(task.index, { kind: task.state === "completed" ? "completed" : task.state === "aborted" ? "aborted" : "failed", task });
			}
		}

		await advanceRunQueue(run, { onUpdate: options.onUpdate, ctx: options.ctx });
		await setWaitStartedForLive();

		if (run.tasks.every((task) => terminalState(task.state))) {
			await persistRun(run);
			return { run, outcomes: [...outcomes.values()] };
		}

		const liveTasks = [] as SagentTaskState[];
		for (const task of run.tasks) {
			if ((task.state === "running" || task.state === "timeout") && (await tmuxSessionExists(task.tmuxSession)) && !(await pathExists(task.donePath))) {
				liveTasks.push(task);
			}
		}

		if (runDeadlineAt !== undefined && Date.now() >= runDeadlineAt) {
			for (const task of liveTasks) {
				await markTaskSoftTimeout(run, task, options.timeoutMs);
				outcomes.set(task.index, { kind: "soft-timeout", task, timeoutMs: options.timeoutMs });
			}
			for (const task of run.tasks.filter((candidate) => candidate.state === "queued")) {
				outcomes.set(task.index, { kind: "queued-blocked-by-concurrency", task, liveCount: await liveTaskCount(run) });
			}
			await persistRun(run);
			return { run, outcomes: [...outcomes.values()] };
		}

		if (options.useTaskTimeouts) {
			for (const task of liveTasks) {
				const deadline = taskDeadlineByIndex.get(task.index);
				if (deadline !== undefined && Date.now() >= deadline && task.state !== "timeout") {
					await markTaskSoftTimeout(run, task, task.timeoutMs);
					outcomes.set(task.index, { kind: "soft-timeout", task, timeoutMs: task.timeoutMs });
				}
			}

			const refreshedLiveTasks = [] as SagentTaskState[];
			for (const task of run.tasks) {
				if ((task.state === "running" || task.state === "timeout") && (await tmuxSessionExists(task.tmuxSession)) && !(await pathExists(task.donePath))) {
					refreshedLiveTasks.push(task);
				}
			}
			const activelyWaiting = refreshedLiveTasks.filter((task) => task.state !== "timeout");
			if (activelyWaiting.length === 0 && refreshedLiveTasks.length > 0) {
				for (const task of run.tasks.filter((candidate) => candidate.state === "queued")) {
					outcomes.set(task.index, { kind: "queued-blocked-by-concurrency", task, liveCount: await liveTaskCount(run) });
				}
				await persistRun(run);
				return { run, outcomes: [...outcomes.values()] };
			}
		}

		await sleep(getPollIntervalMs(), options.signal);
	}
}

async function abortTasks(run: SagentRunState, tasks: SagentTaskState[], reason = "aborted by parent"): Promise<void> {
	for (const task of tasks) await refreshTaskFromArtifacts(run, task);
	for (const task of tasks) {
		if (terminalState(task.state)) continue;
		if (await tmuxSessionExists(task.tmuxSession)) await killTmuxSession(task.tmuxSession);
		task.state = "aborted";
		task.attachCommand = undefined;
		task.finishedAt = nowIso();
		task.lastWaitFinishedAt = task.finishedAt;
		task.error = reason;
		task.resultText = abortedDiagnostic(run, task);
		await ensureResultFile(task, task.resultText);
	}
	await persistRun(run);
}

function formatRunningText(run: SagentRunState, task: SagentTaskState): string {
	return [
		`# pi-sagent status: ${task.name}`,
		"",
		`Run: ${run.id}`,
		`Task selector: ${task.index}`,
		"Status: running",
		`Tmux session: ${task.tmuxSession ?? "(unknown)"}`,
		`Attach: ${task.attachCommand ?? (task.tmuxSession ? attachCommandFor(task.tmuxSession) : "(unknown)")}`,
		`Artifacts: ${task.taskDir}`,
		`Result file when ready: ${task.resultPath}`,
		`JSONL log: ${task.jsonlPath}`,
		`Stderr log: ${task.stderrPath}`,
		`Check later: sagent_status({ id: "${run.id}" })`,
		`Wait: sagent_wait({ id: "${run.id}", task: ${task.index}, timeoutMs: <new-timeout-ms> })`,
		"",
		"<status>",
		"The subagent is still running in tmux.",
		"</status>",
	].join("\n");
}

function formatTimeoutText(run: SagentRunState, task: SagentTaskState, timeoutMs: number | undefined): string {
	const timeoutText = timeoutMs === undefined ? "unknown" : String(timeoutMs);
	return [
		`# pi-sagent status: ${task.name}`,
		"",
		`Run: ${run.id}`,
		`Task selector: ${task.index}`,
		"Status: still running after soft timeout",
		`Timeout: ${timeoutText} ms`,
		`Tmux session: ${task.tmuxSession ?? "(unknown)"}`,
		`Attach: ${task.attachCommand ?? (task.tmuxSession ? attachCommandFor(task.tmuxSession) : "(unknown)")}`,
		`Artifacts: ${task.taskDir}`,
		`Result file when ready: ${task.resultPath}`,
		`JSONL log: ${task.jsonlPath}`,
		`Stderr log: ${task.stderrPath}`,
		`Check later: sagent_status({ id: "${run.id}" })`,
		`Wait again: sagent_wait({ id: "${run.id}", task: ${task.index}, timeoutMs: <new-timeout-ms> })`,
		"",
		"<status>",
		"The subagent is still running in tmux. The soft wait timeout expired, so this tool call is returning control to the parent without killing the child.",
		"</status>",
	].join("\n");
}

async function formatQueuedText(run: SagentRunState, task: SagentTaskState): Promise<string> {
	const live = await liveTaskCount(run);
	return [
		`# pi-sagent status: ${task.name}`,
		"",
		`Run: ${run.id}`,
		`Task selector: ${task.index}`,
		"Status: queued; not launched",
		`Concurrency: ${live}/${run.concurrency} live tmux sessions`,
		`Artifacts: ${task.taskDir}`,
		`Check later: sagent_status({ id: "${run.id}" })`,
		`Resume scheduler: sagent_wait({ id: "${run.id}", timeoutMs: <new-timeout-ms> })`,
		"",
		"<status>",
		"This task has not started because live tmux children still occupy the run's concurrency slots. No tmux session exists for this task yet.",
		"</status>",
	].join("\n");
}

async function formatSingleResultText(run: SagentRunState, task: SagentTaskState): Promise<string> {
	if (task.state === "completed") {
		if (task.resultText) return task.resultText;
		if (await pathExists(task.resultPath)) return (await fsp.readFile(task.resultPath, "utf8")).trimEnd();
		return "(no output)";
	}
	if (task.state === "failed") return task.resultText || failureDiagnostic(run, task, task.error || "failed");
	if (task.state === "running") return formatRunningText(run, task);
	if (task.state === "timeout") return formatTimeoutText(run, task, task.lastSoftTimeoutMs ?? task.timeoutMs);
	if (task.state === "queued") return formatQueuedText(run, task);
	if (task.state === "aborted") return task.resultText || abortedDiagnostic(run, task);
	return formatTimeoutText(run, task, task.timeoutMs);
}

function taskDetails(task: SagentTaskState): Record<string, unknown> {
	return {
		index: task.index,
		name: task.name,
		state: task.state,
		tmuxSession: task.tmuxSession,
		attachCommand: task.state === "running" || task.state === "timeout" ? task.attachCommand : undefined,
		taskDir: task.taskDir,
		promptPath: task.promptPath,
		wrapperPath: task.wrapperPath,
		commandPath: task.commandPath,
		jsonlPath: task.jsonlPath,
		stderrPath: task.stderrPath,
		resultPath: task.resultPath,
		donePath: task.donePath,
		error: task.error,
		softTimedOutAt: task.softTimedOutAt,
		lastSoftTimeoutMs: task.lastSoftTimeoutMs,
	};
}

async function buildToolResult(run: SagentRunState, tasks = run.tasks): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
	const content: Array<{ type: "text"; text: string }> = [];
	for (const task of tasks) content.push({ type: "text", text: await formatSingleResultText(run, task) });
	return {
		content,
		details: {
			id: run.id,
			state: run.state,
			concurrency: run.concurrency,
			runDir: run.rootDir,
			statusPath: run.statusPath,
			selectedTask: tasks.length === 1 ? tasks[0].index : undefined,
			tasks: tasks.map(taskDetails),
		},
	};
}

function formatStatusText(run: SagentRunState, options: { compact?: boolean } = {}): string {
	const lines = [
		options.compact ? `pi-sagent ${run.id}: ${run.state}` : "# pi-sagent status",
		...(options.compact ? [] : [""]),
		`Run: ${run.id}`,
		`State: ${run.state}`,
		`Concurrency: ${run.concurrency}`,
		`Artifacts: ${run.rootDir}`,
		`Status file: ${run.statusPath}`,
		"",
		"Tasks:",
	];
	for (const task of run.tasks) {
		lines.push(`- [${task.index}] ${task.name}: ${task.state}`);
		if (task.tmuxSession) lines.push(`  Tmux session: ${task.tmuxSession}`);
		if ((task.state === "running" || task.state === "timeout") && task.attachCommand) lines.push(`  Attach: ${task.attachCommand}`);
		lines.push(`  Artifacts: ${task.taskDir}`);
		lines.push(`  Result: ${task.resultPath}`);
		lines.push(`  JSONL: ${task.jsonlPath}`);
		lines.push(`  Stderr: ${task.stderrPath}`);
		if (task.error) lines.push(`  Error: ${task.error}`);
		if (!terminalState(task.state)) lines.push(`  Wait: sagent_wait({ id: "${run.id}", task: ${task.index}, timeoutMs: <new-timeout-ms> })`);
	}
	if (run.tasks.some((task) => task.state === "queued")) {
		lines.push("");
		lines.push(`Run-level wait can resume scheduling: sagent_wait({ id: "${run.id}", timeoutMs: <new-timeout-ms> })`);
	}
	return lines.join("\n");
}

function normalizeInputTasks(params: SagentParams): SagentInputTask[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks.map((task, index) => ({
			name: task.name,
			description: task.description,
			prompt: task.prompt,
			systemPrompt: task.systemPrompt ?? params.systemPrompt,
			systemPromptMode: task.systemPromptMode ?? params.systemPromptMode,
			tools: task.tools ?? params.tools,
			model: task.model ?? params.model,
			cwd: task.cwd ?? params.cwd,
			timeoutMs: task.timeoutMs ?? params.timeoutMs,
		}));
	}
	if (typeof params.prompt === "string" && params.prompt.trim()) {
		return [
			{
				name: params.name,
				description: params.description,
				prompt: params.prompt,
				systemPrompt: params.systemPrompt,
				systemPromptMode: params.systemPromptMode,
				tools: params.tools,
				model: params.model,
				cwd: params.cwd,
				timeoutMs: params.timeoutMs,
			},
		];
	}
	throw new Error("Invalid sagent parameters: provide either tasks[] or prompt.");
}

async function createRun(params: SagentParams, ctx: any, pi: ExtensionAPI): Promise<SagentRunState> {
	const inputTasks = normalizeInputTasks(params);
	const id = makeRunId();
	const rootDir = path.join(getRunsRoot(), id);
	const statusPath = path.join(rootDir, "status.json");
	const createdAt = nowIso();
	const maxDepth = normalizeMaxDepth(params.maxDepth);
	const childMaxDepth = Math.max(0, maxDepth - 1);
	const rawConcurrency = isFiniteNumber(params.concurrency) && params.concurrency > 0 ? Math.floor(params.concurrency) : inputTasks.length;
	const concurrency = Math.max(1, Math.min(inputTasks.length, rawConcurrency));
	const defaultCwd = ctx?.cwd || process.cwd();

	await fsp.mkdir(rootDir, { recursive: true, mode: 0o700 });
	const run: SagentRunState = {
		id,
		state: "running",
		createdAt,
		updatedAt: createdAt,
		cwd: path.resolve(defaultCwd),
		rootDir,
		statusPath,
		concurrency,
		maxDepth,
		tasks: [],
	};

	for (let index = 0; index < inputTasks.length; index++) {
		const input = inputTasks[index];
		if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error(`Invalid sagent task ${index}: prompt is required.`);
		const name = input.name?.trim() || `task-${index}`;
		const safeName = sanitizeName(name, `task-${index}`);
		const taskDir = path.join(rootDir, `${index}-${safeName}`);
		const task: SagentTaskState = {
			index,
			name,
			safeName,
			description: input.description,
			state: "queued",
			cwd: resolveCwd(defaultCwd, input.cwd),
			model: input.model,
			systemPrompt: input.systemPrompt,
			systemPromptMode: input.systemPromptMode ?? "append",
			tools: normalizeToolList(input.tools, pi, childMaxDepth),
			timeoutMs: positiveIntegerOrUndefined(input.timeoutMs),
			maxDepth: childMaxDepth,
			createdAt,
			taskDir,
			promptPath: path.join(taskDir, "prompt.md"),
			wrapperPath: path.join(taskDir, "run.sh"),
			commandPath: path.join(taskDir, "command.txt"),
			jsonlPath: path.join(taskDir, "child.jsonl"),
			stderrPath: path.join(taskDir, "child.stderr.log"),
			wrapperLogPath: path.join(taskDir, "wrapper.log"),
			logPath: path.join(taskDir, "child.stderr.log"),
			resultPath: path.join(taskDir, "result.md"),
			donePath: path.join(taskDir, "done.json"),
		};
		await writeWrapperFiles(task, input.prompt);
		run.tasks.push(task);
	}
	await persistRun(run);
	return run;
}

function resolveTaskSelector(run: SagentRunState, selector: number | string): SagentTaskState {
	if (typeof selector === "number") {
		const byIndex = run.tasks.find((task) => task.index === selector);
		if (byIndex) return byIndex;
		throw new Error(`Unknown task index ${selector}. Valid task indexes: ${run.tasks.map((task) => task.index).join(", ")}.`);
	}
	const text = String(selector).trim();
	if (/^\d+$/.test(text)) {
		const byIndex = run.tasks.find((task) => task.index === Number(text));
		if (byIndex) return byIndex;
	}
	const exact = run.tasks.find((task) => task.name === text);
	if (exact) return exact;
	const prefixMatches = run.tasks.filter((task) => task.name.startsWith(text));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const choices = run.tasks.map((task) => `${task.index}:${task.name}`).join(", ");
	if (prefixMatches.length > 1) throw new Error(`Ambiguous task selector "${text}". Matching tasks: ${prefixMatches.map((task) => `${task.index}:${task.name}`).join(", ")}.`);
	throw new Error(`Unknown task selector "${text}". Valid tasks: ${choices}.`);
}

async function sagentExecute(pi: ExtensionAPI, params: SagentParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback, ctx: any) {
	throwIfAborted(signal);
	const run = await createRun(params, ctx, pi);
	try {
		await advanceRunQueue(run, { onUpdate, ctx });
		await waitForRun(run, { useTaskTimeouts: true, signal, onUpdate, ctx, pi });
		await refreshRunFromArtifacts(run);
		await persistRun(run);
		await updateWidget(ctx, run);
		return await buildToolResult(run);
	} catch (error: any) {
		if (error?.name === "AbortError" || signal?.aborted) {
			await abortTasks(run, run.tasks, "aborted by parent");
			await updateWidget(ctx, run);
		}
		throw error;
	}
}

async function sagentWaitExecute(pi: ExtensionAPI, params: SagentWaitParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback, ctx: any) {
	throwIfAborted(signal);
	const run = await loadRun(params.id);
	try {
		await refreshRunFromArtifacts(run);
		if (params.task === undefined) {
			await advanceRunQueue(run, { onUpdate, ctx });
			for (const task of run.tasks) {
				if (task.state === "running" || task.state === "timeout") task.lastWaitStartedAt = nowIso();
			}
			await persistRun(run);
			await emitUpdate(run, onUpdate, ctx);
			await waitForRun(run, { timeoutMs: params.timeoutMs, signal, onUpdate, ctx, pi });
			await refreshRunFromArtifacts(run);
			await persistRun(run);
			await updateWidget(ctx, run);
			return await buildToolResult(run);
		}

		const task = resolveTaskSelector(run, params.task);
		if (terminalState(task.state)) {
			await persistRun(run);
			return await buildToolResult(run, [task]);
		}
		if (task.state === "queued") {
			const live = await liveTaskCount(run);
			if (live >= run.concurrency) {
				await persistRun(run);
				await updateWidget(ctx, run);
				return await buildToolResult(run, [task]);
			}
			await advanceRunQueue(run, { onUpdate, ctx, onlyTaskIndex: task.index });
			await refreshTaskFromArtifacts(run, task);
			if (terminalState(task.state)) {
				await persistRun(run);
				await updateWidget(ctx, run);
				return await buildToolResult(run, [task]);
			}
			if (task.state === "queued") {
				await persistRun(run);
				await updateWidget(ctx, run);
				return await buildToolResult(run, [task]);
			}
		}
		task.lastWaitStartedAt = nowIso();
		await persistRun(run);
		await emitUpdate(run, onUpdate, ctx, `pi-sagent ${run.id}: waiting for ${task.name}\n${task.tmuxSession ? `Tmux session: ${task.tmuxSession}\nAttach: ${task.attachCommand}` : ""}`.trim());
		await waitForTask(run, task, { timeoutMs: params.timeoutMs, signal, onUpdate, ctx, pi, launchIfQueued: false, setWaitStarted: false });
		await refreshTaskFromArtifacts(run, task);
		await persistRun(run);
		await updateWidget(ctx, run);
		return await buildToolResult(run, [task]);
	} catch (error: any) {
		if (error?.name === "AbortError" || signal?.aborted) {
			if (params.task === undefined) {
				await abortTasks(run, run.tasks, "aborted by parent");
			} else {
				try {
					const task = resolveTaskSelector(run, params.task);
					await abortTasks(run, [task], "aborted by parent");
				} catch {
					// If selector failed during abort, do not broaden abort scope.
				}
			}
			await updateWidget(ctx, run);
		}
		throw error;
	}
}

async function sagentStatusExecute(_pi: ExtensionAPI, params: SagentStatusParams, _signal: AbortSignal | undefined, _onUpdate: OnUpdateCallback, ctx: any) {
	if (!params.id) {
		const runs = await listRuns();
		const lines = ["# pi-sagent runs", ""];
		if (runs.length === 0) lines.push("No pi-sagent runs found.");
		for (const run of runs.slice(0, 20)) {
			await refreshRunFromArtifacts(run);
			await persistRun(run);
			lines.push(`- ${run.id}: ${run.state} (${run.tasks.length} task${run.tasks.length === 1 ? "" : "s"})`);
			lines.push(`  Status: ${run.statusPath}`);
			if (run.tasks.some((task) => !terminalState(task.state))) lines.push(`  Wait: sagent_wait({ id: "${run.id}", timeoutMs: <new-timeout-ms> })`);
		}
		return { content: [{ type: "text", text: lines.join("\n") }], details: { runs: runs.map((run) => ({ id: run.id, state: run.state, statusPath: run.statusPath })) } };
	}
	const run = await loadRun(params.id);
	await refreshRunFromArtifacts(run);
	await persistRun(run);
	await updateWidget(ctx, run);
	return { content: [{ type: "text", text: formatStatusText(run) }], details: runDetails(run) };
}

const SystemPromptModeSchema = StringEnum(["append", "replace"] as const, {
	description: 'How systemPrompt is applied. "append" uses --append-system-prompt; "replace" uses --system-prompt.',
});

const TaskSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Optional task display name" })),
	description: Type.Optional(Type.String({ description: "Optional short task description" })),
	prompt: Type.String({ description: "Task prompt for the child Pi agent" }),
	systemPrompt: Type.Optional(Type.String({ description: "Optional child system prompt text" })),
	systemPromptMode: Type.Optional(SystemPromptModeSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Pi tool allowlist for the child" })),
	model: Type.Optional(Type.String({ description: "Optional child model id" })),
	cwd: Type.Optional(Type.String({ description: "Optional child working directory" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Soft wait timeout in milliseconds; on timeout the tmux child remains alive and can be inspected, checked later with sagent_status, or waited on again with sagent_wait." })),
});

const SagentParamsSchema = Type.Object({
	maxDepth: Type.Optional(Type.Number({ description: "Maximum nested sagent depth. Defaults to 2." })),
	concurrency: Type.Optional(Type.Number({ description: "Maximum number of live child tmux sessions at the same time. Defaults to the number of tasks." })),
	tasks: Type.Optional(Type.Array(TaskSchema, { description: "Parallel child agent tasks" })),
	name: Type.Optional(Type.String({ description: "Child agent label" })),
	description: Type.Optional(Type.String({ description: "Short UI description" })),
	prompt: Type.Optional(Type.String({ description: "Task prompt for the child Pi agent" })),
	systemPrompt: Type.Optional(Type.String({ description: "Optional child system prompt text" })),
	systemPromptMode: Type.Optional(SystemPromptModeSchema),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Pi tool allowlist for the child" })),
	model: Type.Optional(Type.String({ description: "Optional child model id" })),
	cwd: Type.Optional(Type.String({ description: "Optional child working directory" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Soft wait timeout in milliseconds; on timeout the tmux child remains alive and can be inspected, checked later with sagent_status, or waited on again with sagent_wait." })),
});

const SagentWaitParamsSchema = Type.Object({
	id: Type.String({ description: 'pi-sagent run id, e.g. "run-abc123"' }),
	task: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Optional task selector: index number, exact task name, or unique task name prefix" })),
	timeoutMs: Type.Optional(Type.Number({ description: "New soft wait timeout in milliseconds. If omitted, wait without a soft timeout." })),
});

const SagentStatusParamsSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional pi-sagent run id. Omit to list recent runs." })),
});

export default function registerPiSagent(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Sagent",
		description: "Run one or more Pi subagents in detached tmux sessions. Soft timeouts leave children alive for inspection and later sagent_wait.",
		promptSnippet: "Run one or more Pi subagents in tmux; use sagent_wait to resume soft-timed-out work.",
		parameters: SagentParamsSchema as any,
		async execute(_toolCallId: string, params: SagentParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback, ctx: any) {
			return sagentExecute(pi, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: WAIT_TOOL_NAME,
		label: "Sagent Wait",
		description: "Resume waiting for an existing pi-sagent tmux child or run scheduler. Applies a new soft wait timeout and never sends input to the child.",
		promptSnippet: "Resume waiting for a pi-sagent run or task by id without launching duplicates.",
		parameters: SagentWaitParamsSchema as any,
		async execute(_toolCallId: string, params: SagentWaitParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback, ctx: any) {
			return sagentWaitExecute(pi, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: STATUS_TOOL_NAME,
		label: "Sagent Status",
		description: "Show pi-sagent run status, tmux attach commands, and artifact paths without launching queued tasks.",
		promptSnippet: "Inspect pi-sagent run status and artifact paths.",
		parameters: SagentStatusParamsSchema as any,
		async execute(_toolCallId: string, params: SagentStatusParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback, ctx: any) {
			return sagentStatusExecute(pi, params, signal, onUpdate, ctx);
		},
	});
}

export const __test = {
	Type,
	getRunsRoot,
	sanitizeName,
	makeTmuxSessionName,
	shellQuote,
	buildPiArgs,
	extractResultFromJsonl,
	refreshTaskFromArtifacts,
	liveTaskCount,
	advanceRunQueue,
	waitForTask,
	waitForRun,
	formatTimeoutText,
	formatQueuedText,
	loadRun,
	createRun,
	execTmux,
	tmuxSessionExists,
	killTmuxSession,
};
