import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { COLLABORATION_TOOL_NAMES, type SpawnAgentInput } from "../src/contracts.ts";
import {
	resolveChildModel,
	resolveChildTools,
	snapshotChildRuntime,
} from "../src/launch-config.ts";
import { createPiRpcLaunch } from "../src/rpc-child.ts";

type AuthSource =
	| "stored"
	| "runtime"
	| "environment"
	| "fallback"
	| "models_json_key"
	| "models_json_command";

interface AuthFixture {
	configured: boolean;
	source?: AuthSource;
}

interface ContextFixtureOptions {
	root?: Model<any>;
	available?: readonly Model<any>[];
	scoped?: readonly Model<any>[];
	auth?: Readonly<Record<string, AuthFixture>>;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	cwd?: string;
	trusted?: boolean;
}

function model(
	provider: string,
	id: string,
	options: {
		reasoning?: boolean;
		thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", unknown>>;
	} = {},
): Model<any> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: `https://${provider}.invalid`,
		reasoning: options.reasoning ?? true,
		thinkingLevelMap: options.thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} as Model<any>;
}

function context(options: ContextFixtureOptions): ExtensionContext {
	const available = [...(options.available ?? (options.root ? [options.root] : []))];
	const auth = options.auth ?? {};
	return {
		model: options.root,
		thinkingLevel: options.thinkingLevel ?? "medium",
		cwd: options.cwd ?? "/workspace",
		scopedModels: (options.scoped ?? []).map((entry) => ({ model: entry })),
		modelRegistry: {
			getAvailable: () => available,
			getProviderAuthStatus: (provider: string) =>
				auth[provider] ?? { configured: true, source: "stored" },
		},
		isProjectTrusted: () => options.trusted ?? false,
	} as unknown as ExtensionContext;
}

function spawnInput(overrides: Partial<SpawnAgentInput> = {}): SpawnAgentInput {
	return { task_name: "tests", message: "Run tests", ...overrides };
}

function tool(
	name: string,
	sourceInfo: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level" },
): ToolInfo {
	return {
		name,
		description: name,
		parameters: {} as ToolInfo["parameters"],
		sourceInfo,
	};
}

function toolApi(activeTools: readonly string[], tools: readonly ToolInfo[]): ExtensionAPI {
	return {
		getActiveTools: () => [...activeTools],
		getAllTools: () => [...tools],
	} as unknown as ExtensionAPI;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

describe("child model and thinking selection", () => {
	it("inherits the exact root provider/model/thinking selection", async () => {
		const root = model("openai-codex", "gpt-5.6-sol", {
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		await expect(
			resolveChildModel(spawnInput(), context({ root, thinkingLevel: "xhigh" })),
		).resolves.toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "xhigh",
		});
	});

	it("prefers the root provider for an explicit model and honors an explicit effort", async () => {
		const root = model("z-provider", "gpt-5.6-sol");
		const sameProvider = model("z-provider", "gpt-5.6-terra", {
			thinkingLevelMap: { max: "max" },
		});
		const alphabeticallyFirst = model("a-provider", "gpt-5.6-terra", {
			thinkingLevelMap: { max: "max" },
		});
		await expect(
			resolveChildModel(
				spawnInput({ model: "gpt-5.6-terra", reasoning_effort: "max" }),
				context({ root, available: [alphabeticallyFirst, sameProvider] }),
			),
		).resolves.toEqual({
			provider: "z-provider",
			modelId: "gpt-5.6-terra",
			thinkingLevel: "max",
		});
	});

	it("selects the first authenticated provider deterministically when the root provider lacks the model", async () => {
		const root = model("root-provider", "gpt-5.6-sol");
		const z = model("z-provider", "gpt-5.6-terra");
		const a = model("a-provider", "gpt-5.6-terra");
		const unavailable = model("00-unconfigured", "gpt-5.6-terra");
		await expect(
			resolveChildModel(
				spawnInput({ model: "gpt-5.6-terra" }),
				context({
					root,
					available: [z, unavailable, a],
					auth: {
						"00-unconfigured": { configured: false },
						"a-provider": { configured: true, source: "environment" },
						"z-provider": { configured: true, source: "stored" },
					},
				}),
			),
		).resolves.toMatchObject({ provider: "a-provider", modelId: "gpt-5.6-terra" });
	});

	it("falls back when the same-provider exact model exists but is unauthenticated", async () => {
		const root = model("root-provider", "gpt-5.6-sol");
		const unauthenticatedSameProvider = model("root-provider", "gpt-5.6-terra");
		const authenticatedAlternative = model("stored-provider", "gpt-5.6-terra");
		await expect(
			resolveChildModel(
				spawnInput({ model: "gpt-5.6-terra" }),
				context({
					root,
					available: [unauthenticatedSameProvider, authenticatedAlternative],
					auth: {
						"root-provider": { configured: false },
						"stored-provider": { configured: true, source: "stored" },
					},
				}),
			),
		).resolves.toMatchObject({ provider: "stored-provider", modelId: "gpt-5.6-terra" });
	});

	it("rejects absent models, unsupported thinking levels, and runtime-only credentials", async () => {
		const root = model("openai-codex", "gpt-5.6-sol", {
			thinkingLevelMap: { max: null },
		});
		await expect(
			resolveChildModel(spawnInput({ model: "gpt-5.6-terra" }), context({ root })),
		).rejects.toThrow(/unavailable or unauthenticated/);
		await expect(
			resolveChildModel(
				spawnInput({ reasoning_effort: "max" }),
				context({ root, auth: { "openai-codex": { configured: true, source: "stored" } } }),
			),
		).rejects.toThrow(/does not support thinking level max/);
		await expect(
			resolveChildModel(
				spawnInput(),
				context({
					root,
					auth: { "openai-codex": { configured: true, source: "runtime" } },
				}),
			),
		).rejects.toThrow(/runtime-only authentication.*cannot be reconstructed/);
	});

	it("honors scoped-model availability and rejects a missing root model", async () => {
		const root = model("openai-codex", "gpt-5.6-sol");
		const terra = model("openai-codex", "gpt-5.6-terra");
		await expect(
			resolveChildModel(
				spawnInput({ model: "gpt-5.6-terra" }),
				context({ root, available: [root, terra], scoped: [root] }),
			),
		).rejects.toThrow(/unavailable or unauthenticated/);
		await expect(resolveChildModel(spawnInput(), context({}))).rejects.toThrow(
			/root has no selected model/,
		);
	});
});

describe("active child tool inheritance", () => {
	it("filters collaboration tools, preserves active order, and forwards readable temporary top-level extensions", async () => {
		const extensionPath = fileURLToPath(import.meta.url);
		const tools = [
			tool("read", {
				path: "<builtin:read>",
				source: "builtin",
				scope: "temporary",
				origin: "top-level",
			}),
			tool("temp_one", {
				path: extensionPath,
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
			tool("temp_two", {
				path: extensionPath,
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		];
		const result = await resolveChildTools(
			toolApi(
				["read", COLLABORATION_TOOL_NAMES[0], "temp_two", COLLABORATION_TOOL_NAMES[5], "temp_one"],
				tools,
			),
		);
		expect(result).toEqual({
			activeTools: ["read", "temp_two", "temp_one"],
			extensionPaths: [extensionPath],
		});
	});

	it("relies on normal discovery for user/project/package-scoped extension tools", async () => {
		const tools = [
			tool("project_tool", {
				path: "/project/.pi/extensions/tool.ts",
				source: "local",
				scope: "project",
				origin: "top-level",
			}),
			tool("package_tool", {
				path: "/package/extensions/tool.ts",
				source: "npm:package",
				scope: "user",
				origin: "package",
			}),
		];
		await expect(resolveChildTools(toolApi(["project_tool", "package_tool"], tools))).resolves.toEqual({
			activeTools: ["project_tool", "package_tool"],
			extensionPaths: [],
		});
	});

	it("supports an empty inherited tool set", async () => {
		await expect(resolveChildTools(toolApi([], []))).resolves.toEqual({
			activeTools: [],
			extensionPaths: [],
		});
		await expect(
			resolveChildTools(toolApi([...COLLABORATION_TOOL_NAMES], [])),
		).resolves.toEqual({ activeTools: [], extensionPaths: [] });
	});

	it("rejects missing metadata, SDK closures, and unreadable synthetic extension paths", async () => {
		await expect(resolveChildTools(toolApi(["ghost"], []))).rejects.toThrow(
			/active tool ghost has no registered tool metadata/,
		);
		const sdk = tool("sdk_tool", {
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		await expect(resolveChildTools(toolApi(["sdk_tool"], [sdk]))).rejects.toThrow(
			/SDK\/in-memory tool closures cannot cross/,
		);

		const synthetic = tool("synthetic_tool", {
			path: "<generated:synthetic_tool>",
			source: "local",
			scope: "temporary",
			origin: "top-level",
		});
		await expect(resolveChildTools(toolApi(["synthetic_tool"], [synthetic]))).rejects.toThrow(
			/synthetic or not a local file/,
		);
	});

	it("forwards a readable temporary package resource that normal discovery cannot guarantee", async () => {
		const extensionPath = fileURLToPath(import.meta.url);
		const transientPackageOrigin = tool("transient_tool", {
			path: extensionPath,
			source: "local",
			scope: "temporary",
			origin: "package",
		});
		await expect(
			resolveChildTools(toolApi(["transient_tool"], [transientPackageOrigin])),
		).resolves.toEqual({ activeTools: ["transient_tool"], extensionPaths: [extensionPath] });
	});
});

describe("runtime snapshot and child launch", () => {
	it("carries selected capabilities into exact RPC flags, trust, and child-depth marker", async () => {
		const root = model("openai-codex", "gpt-5.6-sol", {
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		const extensionPath = fileURLToPath(import.meta.url);
		const active = [
			tool("read", {
				path: "<builtin:read>",
				source: "builtin",
				scope: "temporary",
				origin: "top-level",
			}),
			tool("temp_tool", {
				path: extensionPath,
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		];
		const runtime = await snapshotChildRuntime(
			toolApi(["read", "temp_tool", COLLABORATION_TOOL_NAMES[0]], active),
			spawnInput({ reasoning_effort: "xhigh" }),
			context({ root, thinkingLevel: "low", cwd: "/workspace/project", trusted: false }),
		);
		expect(runtime).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "xhigh",
			activeTools: ["read", "temp_tool"],
			extensionPaths: [extensionPath],
			cwd: "/workspace/project",
			projectTrusted: false,
		});

		const launch = createPiRpcLaunch({
			sessionFile: "/sessions/child.jsonl",
			name: "/root/tests",
			provider: runtime.provider,
			modelId: runtime.modelId,
			thinkingLevel: runtime.thinkingLevel,
			tools: runtime.activeTools,
			extensionPaths: runtime.extensionPaths,
			appendSystemPrompt: "child system prompt",
			projectTrusted: runtime.projectTrusted,
			cwd: runtime.cwd,
			env: { PARENT_MARKER: "kept" },
			invocationRuntime: {
				argv: ["/opt/pi"],
				execPath: "/opt/pi",
				pathExists: () => false,
			},
		});
		expect(launch.command).toBe("/opt/pi");
		expect(flagValue(launch.args, "--session")).toBe("/sessions/child.jsonl");
		expect(flagValue(launch.args, "--name")).toBe("/root/tests");
		expect(flagValue(launch.args, "--model")).toBe("openai-codex/gpt-5.6-sol");
		expect(flagValue(launch.args, "--thinking")).toBe("xhigh");
		expect(flagValue(launch.args, "--tools")).toBe("read,temp_tool");
		expect(flagValue(launch.args, "--extension")).toBe(extensionPath);
		expect(flagValue(launch.args, "--append-system-prompt")).toBe("child system prompt");
		expect(launch.args).toContain("--no-approve");
		expect(launch.args).not.toContain("--approve");
		expect(launch.env.PARENT_MARKER).toBe("kept");
		expect(launch.env.PI_COLLABORATION_CHILD).toBe("1");
	});

	it("uses --no-tools and --approve for a trusted empty-tool child", () => {
		const launch = createPiRpcLaunch({
			sessionFile: "/sessions/empty.jsonl",
			name: "/root/empty",
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "medium",
			tools: [],
			appendSystemPrompt: "child",
			projectTrusted: true,
			cwd: "/workspace",
			invocationRuntime: {
				argv: ["pi"],
				execPath: "/opt/pi",
				pathExists: () => false,
			},
		});
		expect(launch.args).toContain("--no-tools");
		expect(launch.args).toContain("--approve");
		expect(launch.args).not.toContain("--no-approve");
	});
});
