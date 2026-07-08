import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import registerPiSagent from "../index.ts";

const fakeTmuxScript = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_TMUX_STATE;
const logPath = process.env.FAKE_TMUX_LOG;
if (!statePath || !logPath) {
  console.error('FAKE_TMUX_STATE and FAKE_TMUX_LOG are required');
  process.exit(2);
}

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function load() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { sessions: {} }; }
}
function save(state) { ensureDir(statePath); fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function log(event) { ensureDir(logPath); fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), args, ...event }) + '\n'); }
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
function target() {
  const i = args.indexOf('-t');
  return i >= 0 ? args[i + 1] : undefined;
}

if (args[0] === '-V') {
  log({ op: 'version' });
  console.log('tmux fake 1.0');
  process.exit(0);
}

const op = args[0];
const state = load();

if (op === 'new-session') {
  const s = args[args.indexOf('-s') + 1];
  const cwd = args[args.indexOf('-c') + 1];
  const command = args[args.length - 1];
  if (!s || !cwd || !command) {
    console.error('bad new-session args');
    process.exit(2);
  }
  if (state.sessions[s] && alive(state.sessions[s].pid)) {
    console.error('duplicate session');
    process.exit(1);
  }
  if (process.env.FAKE_TMUX_FAIL_NEW_SESSION === '1') {
    log({ op: 'new-session', session: s, cwd, command, failed: true, reason: 'forced' });
    console.error('forced fake tmux new-session failure');
    process.exit(1);
  }
  if (!fs.existsSync(cwd)) {
    log({ op: 'new-session', session: s, cwd, command, failed: true, reason: 'cwd-missing' });
    console.error('cwd does not exist: ' + cwd);
    process.exit(1);
  }
  const delayMs = Number(process.env.FAKE_TMUX_NEW_SESSION_DELAY_MS || '0') || 0;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const child = spawn(command, { cwd, shell: true, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  state.sessions[s] = { pid: child.pid, cwd, command, createdAt: Date.now() };
  save(state);
  log({ op: 'new-session', session: s, pid: child.pid, cwd, command });
  process.exit(0);
}

if (op === 'has-session') {
  const s = target();
  const session = s && state.sessions[s];
  if (session && alive(session.pid)) {
    log({ op: 'has-session', session: s, alive: true });
    process.exit(0);
  }
  if (s) delete state.sessions[s];
  save(state);
  log({ op: 'has-session', session: s, alive: false });
  process.exit(1);
}

if (op === 'kill-session') {
  const s = target();
  const session = s && state.sessions[s];
  if (session) {
    try { process.kill(-session.pid, 'SIGTERM'); } catch {}
    try { process.kill(session.pid, 'SIGTERM'); } catch {}
    delete state.sessions[s];
    save(state);
  }
  log({ op: 'kill-session', session: s, pid: session?.pid });
  process.exit(0);
}

if (op === 'attach-session') {
  log({ op: 'attach-session', session: target() });
  process.exit(0);
}

console.error('unsupported fake tmux op ' + op);
process.exit(2);
`;

const fakePiScript = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_PI_LOG;
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
}
const promptArg = args.find((arg) => arg.startsWith('@'));
const promptPath = promptArg ? promptArg.slice(1) : '';
const prompt = promptPath ? fs.readFileSync(promptPath, 'utf8') : '';
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), args, promptPath, prompt }) + '\n');

function directive(name, fallback = '') {
  const match = prompt.match(new RegExp('^' + name + '=(.*)$', 'm'));
  return match ? match[1] : fallback;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const waitForFile = directive('WAIT_FOR_FILE');
if (waitForFile) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(waitForFile) && Date.now() < deadline) await sleep(10);
}
const sleepMs = Number(directive('SLEEP_MS', '0')) || 0;
if (sleepMs > 0) await sleep(sleepMs);
const stderrText = directive('STDERR');
if (stderrText) console.error(stderrText);
const output = directive('OUTPUT', 'fake pi ok');
const exitCode = Number(directive('EXIT_CODE', '0')) || 0;
if (prompt.includes('NO_RESULT=1')) {
  // Emit no assistant result.
} else if (prompt.includes('USE_MESSAGE_UPDATE=1')) {
  console.log(JSON.stringify({ type: 'message_update', delta: output }));
} else {
  console.log(JSON.stringify({
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: output }] }]
  }));
}
process.exit(exitCode);
`;

type ToolMap = Map<string, any>;

type Harness = {
	tmp: string;
	home: string;
	cwd: string;
	tools: ToolMap;
	ctx: any;
	updates: any[];
	execute: (name: string, params: any, signal?: AbortSignal) => Promise<any>;
	readStatus: (id: string) => Promise<any>;
	readTmuxLog: () => Promise<any[]>;
	readPiLog: () => Promise<any[]>;
};

async function readJsonLines(filePath: string): Promise<any[]> {
	try {
		const text = await fsp.readFile(filePath, "utf8");
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("timed out waiting for condition");
}

async function setup(t: any): Promise<Harness> {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-sagent-test-"));
	const home = path.join(tmp, "home");
	const cwd = path.join(tmp, "cwd");
	const bin = path.join(tmp, "bin");
	await fsp.mkdir(home, { recursive: true });
	await fsp.mkdir(cwd, { recursive: true });
	await fsp.mkdir(bin, { recursive: true });
	const fakeTmux = path.join(bin, "fake-tmux.mjs");
	const fakePi = path.join(bin, "fake-pi.mjs");
	await fsp.writeFile(fakeTmux, fakeTmuxScript, { mode: 0o755 });
	await fsp.writeFile(fakePi, fakePiScript, { mode: 0o755 });
	await fsp.chmod(fakeTmux, 0o755);
	await fsp.chmod(fakePi, 0o755);

	const oldEnv: Record<string, string | undefined> = {};
	for (const key of ["HOME", "PI_SAGENT_TMUX_BIN", "PI_SAGENT_PI_BIN", "PI_SAGENT_POLL_INTERVAL_MS", "FAKE_TMUX_STATE", "FAKE_TMUX_LOG", "FAKE_PI_LOG", "FAKE_TMUX_FAIL_NEW_SESSION", "FAKE_TMUX_NEW_SESSION_DELAY_MS"]) {
		oldEnv[key] = process.env[key];
	}
	const tmuxState = path.join(tmp, "tmux-state.json");
	const tmuxLog = path.join(tmp, "tmux.log");
	const piLog = path.join(tmp, "pi.log");
	process.env.HOME = home;
	process.env.PI_SAGENT_TMUX_BIN = fakeTmux;
	process.env.PI_SAGENT_PI_BIN = fakePi;
	process.env.PI_SAGENT_POLL_INTERVAL_MS = "25";
	process.env.FAKE_TMUX_STATE = tmuxState;
	process.env.FAKE_TMUX_LOG = tmuxLog;
	process.env.FAKE_PI_LOG = piLog;

	const tools: ToolMap = new Map();
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		getActiveTools() {
			return ["read", "bash", "edit", "write", "sagent", "sagent_wait", "sagent_status"];
		},
	};
	registerPiSagent(pi as any);

	const updates: any[] = [];
	const widgets: any[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		ui: {
			setWidget(key: string, lines: string[]) {
				widgets.push({ key, lines });
			},
		},
		widgets,
	};

	t.after(async () => {
		try {
			const state = JSON.parse(await fsp.readFile(tmuxState, "utf8"));
			for (const session of Object.values<any>(state.sessions || {})) {
				try {
					process.kill(-session.pid, "SIGTERM");
				} catch {}
				try {
					process.kill(session.pid, "SIGTERM");
				} catch {}
			}
		} catch {}
		for (const [key, value] of Object.entries(oldEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	return {
		tmp,
		home,
		cwd,
		tools,
		ctx,
		updates,
		execute(name: string, params: any, signal?: AbortSignal) {
			const tool = tools.get(name);
			assert.ok(tool, `tool ${name} registered`);
			return tool.execute(`${name}-call`, params, signal, (partial: any) => updates.push(partial), ctx);
		},
		readStatus(id: string) {
			return fsp.readFile(path.join(home, ".pi", "agent", "pi-sagent", "runs", id, "status.json"), "utf8").then(JSON.parse);
		},
		readTmuxLog() {
			return readJsonLines(tmuxLog);
		},
		readPiLog() {
			return readJsonLines(piLog);
		},
	};
}

function newSessionCount(log: any[]): number {
	return log.filter((entry) => entry.op === "new-session").length;
}

function killCount(log: any[]): number {
	return log.filter((entry) => entry.op === "kill-session").length;
}

test("schemas and wrapper command include sagent_wait, --no-session, --approve, and @prompt.md", async (t) => {
	const h = await setup(t);
	assert.ok(h.tools.has("sagent_wait"));
	const schema = h.tools.get("sagent")!.parameters;
	assert.equal(schema.properties.backend, undefined);
	assert.match(schema.properties.timeoutMs.description, /tmux child remains alive/);

	const result = await h.execute("sagent", {
		name: "cmd-check",
		prompt: "OUTPUT=command ok\nSLEEP_MS=0",
		tools: ["read", "bash"],
		timeoutMs: 1000,
	});
	assert.equal(result.content[0].text, "command ok");
	const id = result.details.id;
	const status = await h.readStatus(id);
	assert.equal(status.concurrency, 1);
	const task = status.tasks[0];
	for (const key of ["taskDir", "promptPath", "wrapperPath", "commandPath", "jsonlPath", "stderrPath", "resultPath", "donePath"]) {
		assert.equal(path.isAbsolute(task[key]), true, `${key} is absolute`);
	}
	const command = await fsp.readFile(task.commandPath, "utf8");
	assert.match(command, /--no-session/);
	assert.match(command, /--approve/);
	assert.match(command, /@.*prompt\.md/);
	assert.doesNotMatch(command, /OUTPUT=command ok/);
});

test("successful run produces and reads result.md", async (t) => {
	const h = await setup(t);
	const result = await h.execute("sagent", { name: "success", prompt: "OUTPUT=final answer" });
	assert.equal(result.content[0].text, "final answer");
	assert.equal(result.details.tasks[0].attachCommand, undefined);
	const status = await h.readStatus(result.details.id);
	assert.equal(status.tasks[0].state, "completed");
	assert.equal(status.tasks[0].attachCommand, undefined);
	assert.equal((await fsp.readFile(status.tasks[0].resultPath, "utf8")).trim(), "final answer");
});

test("soft timeout returns compact status and does not kill tmux", async (t) => {
	const h = await setup(t);
	const result = await h.execute("sagent", {
		name: "slow",
		prompt: "SLEEP_MS=400\nOUTPUT=late answer",
		timeoutMs: 30,
	});
	assert.match(result.content[0].text, /Status: still running after soft timeout/);
	assert.match(result.content[0].text, /Attach:/);
	assert.match(result.content[0].text, /sagent_wait/);
	const status = await h.readStatus(result.details.id);
	assert.equal(status.tasks[0].state, "timeout");
	assert.ok(status.tasks[0].tmuxSession);
	const log = await h.readTmuxLog();
	assert.equal(killCount(log), 0);
});

test("soft timeout does not free concurrency and queued tasks are not launched", async (t) => {
	const h = await setup(t);
	const result = await h.execute("sagent", {
		concurrency: 1,
		tasks: [
			{ name: "first", prompt: "SLEEP_MS=400\nOUTPUT=first done", timeoutMs: 30 },
			{ name: "second", prompt: "OUTPUT=second done" },
		],
	});
	assert.match(result.content[0].text, /still running after soft timeout/);
	assert.match(result.content[1].text, /Status: queued; not launched/);
	const status = await h.readStatus(result.details.id);
	assert.equal(status.tasks[0].state, "timeout");
	assert.equal(status.tasks[1].state, "queued");
	assert.equal(status.tasks[1].tmuxSession, undefined);
	assert.equal(newSessionCount(await h.readTmuxLog()), 1);
});

test("run-level sagent_wait launches queued task after timed-out task completes", async (t) => {
	const h = await setup(t);
	const first = await h.execute("sagent", {
		concurrency: 1,
		tasks: [
			{ name: "first", prompt: "SLEEP_MS=100\nOUTPUT=first done", timeoutMs: 30 },
			{ name: "second", prompt: "OUTPUT=second done" },
		],
	});
	const id = first.details.id;
	await new Promise((resolve) => setTimeout(resolve, 180));
	const waited = await h.execute("sagent_wait", { id, timeoutMs: 1000 });
	assert.equal(waited.content[0].text, "first done");
	assert.equal(waited.content[1].text, "second done");
	const status = await h.readStatus(id);
	assert.equal(status.state, "completed");
	assert.equal(newSessionCount(await h.readTmuxLog()), 2);
});

test("already-aborted sagent does not launch tmux", async (t) => {
	const h = await setup(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => h.execute("sagent", { name: "pre-abort", prompt: "SLEEP_MS=1000\nOUTPUT=no" }, controller.signal), /aborted/);
	assert.equal(newSessionCount(await h.readTmuxLog()), 0);
});

test("abort of active sagent kills launched tmux sessions and marks run aborted", async (t) => {
	const h = await setup(t);
	const controller = new AbortController();
	const promise = h.execute("sagent", {
		name: "abort-me",
		prompt: "SLEEP_MS=2000\nOUTPUT=should not finish",
	}, controller.signal);
	await waitFor(() => h.updates.some((u) => /launched abort-me/.test(u.content?.[0]?.text || "")));
	const id = h.updates.find((u) => /launched abort-me/.test(u.content?.[0]?.text || ""))!.details.id;
	controller.abort();
	await assert.rejects(promise, /aborted/);
	const status = await h.readStatus(id);
	assert.equal(status.state, "aborted");
	assert.equal(status.tasks[0].state, "aborted");
	assert.equal(killCount(await h.readTmuxLog()), 1);
});

test("sagent_status reconciles timeout to completed and does not launch queued tasks", async (t) => {
	const h = await setup(t);
	const first = await h.execute("sagent", {
		concurrency: 1,
		tasks: [
			{ name: "first", prompt: "SLEEP_MS=300\nOUTPUT=first done", timeoutMs: 30 },
			{ name: "second", prompt: "OUTPUT=second done" },
		],
	});
	const id = first.details.id;
	await new Promise((resolve) => setTimeout(resolve, 420));
	const statusResult = await h.execute("sagent_status", { id });
	assert.match(statusResult.content[0].text, /first: completed/);
	assert.match(statusResult.content[0].text, /second: queued/);
	const status = await h.readStatus(id);
	assert.equal(status.tasks[0].state, "completed");
	assert.equal(status.tasks[1].state, "queued");
	assert.equal(newSessionCount(await h.readTmuxLog()), 1);
});

test("task-level sagent_wait waits on previous timeout and returns completed without duplicate launch", async (t) => {
	const h = await setup(t);
	const first = await h.execute("sagent", {
		name: "wait-target",
		prompt: "SLEEP_MS=90\nOUTPUT=eventual result",
		timeoutMs: 30,
	});
	const id = first.details.id;
	await new Promise((resolve) => setTimeout(resolve, 150));
	const waited = await h.execute("sagent_wait", { id, task: 0, timeoutMs: 1000 });
	assert.equal(waited.content[0].text, "eventual result");
	assert.equal(newSessionCount(await h.readTmuxLog()), 1);
});

test("sagent_wait can soft-timeout again without killing tmux", async (t) => {
	const h = await setup(t);
	const first = await h.execute("sagent", {
		name: "still-slow",
		prompt: "SLEEP_MS=500\nOUTPUT=later",
		timeoutMs: 30,
	});
	const id = first.details.id;
	const waited = await h.execute("sagent_wait", { id, task: 0, timeoutMs: 30 });
	assert.match(waited.content[0].text, /still running after soft timeout/);
	assert.equal(killCount(await h.readTmuxLog()), 0);
	assert.equal(newSessionCount(await h.readTmuxLog()), 1);
});

test("run-level sagent_wait resumes queued scheduling only up to persisted concurrency", async (t) => {
	const h = await setup(t);
	const releaseOne = path.join(h.tmp, "release-one");
	const releaseTwo = path.join(h.tmp, "release-two");
	const first = await h.execute("sagent", {
		concurrency: 2,
		tasks: [
			{ name: "one", prompt: `WAIT_FOR_FILE=${releaseOne}\nOUTPUT=one`, timeoutMs: 30 },
			{ name: "two", prompt: `WAIT_FOR_FILE=${releaseTwo}\nOUTPUT=two`, timeoutMs: 30 },
			{ name: "three", prompt: "OUTPUT=three" },
		],
	});
	const id = first.details.id;
	assert.equal(newSessionCount(await h.readTmuxLog()), 2);
	await fsp.writeFile(releaseOne, "go");
	const waited = await h.execute("sagent_wait", { id, timeoutMs: 300 });
	assert.equal(waited.content.length, 3);
	const status = await h.readStatus(id);
	assert.equal(status.concurrency, 2);
	assert.equal(newSessionCount(await h.readTmuxLog()), 3);
	assert.equal(status.tasks[0].state, "completed");
	assert.equal(status.tasks[1].state, "timeout");
	assert.equal(status.tasks[2].state, "completed");
});

test("concurrent run-level sagent_wait calls do not exceed persisted concurrency", async (t) => {
	const h = await setup(t);
	const releaseOne = path.join(h.tmp, "release-concurrent-one");
	const first = await h.execute("sagent", {
		concurrency: 1,
		tasks: [
			{ name: "one", prompt: `WAIT_FOR_FILE=${releaseOne}\nOUTPUT=one`, timeoutMs: 30 },
			{ name: "two", prompt: "OUTPUT=two" },
		],
	});
	const id = first.details.id;
	assert.equal(newSessionCount(await h.readTmuxLog()), 1);
	await fsp.writeFile(releaseOne, "go");
	await waitFor(async () => {
		const status = await h.execute("sagent_status", { id });
		return /one: completed/.test(status.content[0].text);
	}, 2000);
	process.env.FAKE_TMUX_NEW_SESSION_DELAY_MS = "100";
	const [a, b] = await Promise.all([
		h.execute("sagent_wait", { id, timeoutMs: 1000 }),
		h.execute("sagent_wait", { id, timeoutMs: 1000 }),
	]);
	assert.equal(a.details.concurrency, 1);
	assert.equal(b.details.concurrency, 1);
	assert.equal(newSessionCount(await h.readTmuxLog()), 2);
	const status = await h.readStatus(id);
	assert.equal(status.tasks[1].state, "completed");
});

test("task-level sagent_wait for queued task returns queued-blocked when live slot is occupied", async (t) => {
	const h = await setup(t);
	const first = await h.execute("sagent", {
		concurrency: 1,
		tasks: [
			{ name: "busy", prompt: "SLEEP_MS=500\nOUTPUT=busy done", timeoutMs: 30 },
			{ name: "queued", prompt: "OUTPUT=queued done" },
		],
	});
	const id = first.details.id;
	const waited = await h.execute("sagent_wait", { id, task: "queued", timeoutMs: 30 });
	assert.match(waited.content[0].text, /Status: queued; not launched/);
	assert.equal(newSessionCount(await h.readTmuxLog()), 1);
});

test("abort of active task-level sagent_wait kills only selected tmux session", async (t) => {
	const h = await setup(t);
	const first = await h.execute("sagent", {
		concurrency: 2,
		tasks: [
			{ name: "left", prompt: "SLEEP_MS=2000\nOUTPUT=left", timeoutMs: 30 },
			{ name: "right", prompt: "SLEEP_MS=2000\nOUTPUT=right", timeoutMs: 30 },
		],
	});
	const id = first.details.id;
	const before = await h.readStatus(id);
	const rightSession = before.tasks[1].tmuxSession;
	const controller = new AbortController();
	const promise = h.execute("sagent_wait", { id, task: 0 }, controller.signal);
	await waitFor(() => h.updates.some((u) => /waiting for left/.test(u.content?.[0]?.text || "")));
	controller.abort();
	await assert.rejects(promise, /aborted/);
	const status = await h.readStatus(id);
	assert.equal(status.tasks[0].state, "aborted");
	assert.equal(status.tasks[1].state, "timeout");
	assert.equal(status.tasks[1].tmuxSession, rightSession);
	const kills = (await h.readTmuxLog()).filter((entry) => entry.op === "kill-session");
	assert.equal(kills.length, 1);
	assert.notEqual(kills[0].session, rightSession);
});

test("tmux launch failure from invalid cwd returns compact task failure and sibling result", async (t) => {
	const h = await setup(t);
	const result = await h.execute("sagent", {
		concurrency: 2,
		tasks: [
			{ name: "bad-cwd", cwd: path.join(h.tmp, "missing-cwd"), prompt: "OUTPUT=should not run" },
			{ name: "good", prompt: "OUTPUT=good result" },
		],
	});
	assert.match(result.content[0].text, /Status: failed/);
	assert.match(result.content[0].text, /tmux launch failed/);
	assert.equal(result.content[1].text, "good result");
	const status = await h.readStatus(result.details.id);
	assert.equal(status.tasks[0].state, "failed");
	assert.equal(status.tasks[0].tmuxSession, undefined);
	assert.equal(status.tasks[1].state, "completed");
});

test("fake tmux new-session failure is a compact task failure, not a tool error", async (t) => {
	const h = await setup(t);
	process.env.FAKE_TMUX_FAIL_NEW_SESSION = "1";
	const result = await h.execute("sagent", { name: "tmux-fails", prompt: "OUTPUT=should not run" });
	assert.match(result.content[0].text, /Status: failed/);
	assert.match(result.content[0].text, /tmux launch failed/);
	const status = await h.readStatus(result.details.id);
	assert.equal(status.state, "failed");
	assert.equal(status.tasks[0].state, "failed");
	assert.equal((await h.readPiLog()).length, 0);
});

test("unsafe run ids are rejected before path lookup", async (t) => {
	const h = await setup(t);
	await assert.rejects(() => h.execute("sagent_status", { id: "../evil" }), /Invalid pi-sagent run id/);
	await assert.rejects(() => h.execute("sagent_wait", { id: "run-../evil" }), /Invalid pi-sagent run id/);
});

test("failure output is compact and includes paths, not raw stderr", async (t) => {
	const h = await setup(t);
	const result = await h.execute("sagent", {
		name: "fails",
		prompt: "EXIT_CODE=7\nSTDERR=SECRET_STDERR_LOG\nOUTPUT=bad",
	});
	const text = result.content[0].text;
	assert.match(text, /Status: failed/);
	assert.match(text, /JSONL log:/);
	assert.match(text, /Stderr log:/);
	assert.doesNotMatch(text, /SECRET_STDERR_LOG/);
	const status = await h.readStatus(result.details.id);
	assert.equal(status.tasks[0].state, "failed");
});
