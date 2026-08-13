import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  COLLABORATION_TOOL_NAMES,
  type SpawnAgentInput,
} from "./contracts.ts";

export interface ChildModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface ChildToolSelection {
  activeTools: string[];
  extensionPaths: string[];
}

export interface ChildRuntimeSnapshot extends ChildModelSelection, ChildToolSelection {
  cwd: string;
  projectTrusted: boolean;
}

const collaborationNames = new Set<string>(COLLABORATION_TOOL_NAMES);

function modelIdentity(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function configuredModels(ctx: ExtensionContext): Model<any>[] {
  const scoped = ctx.scopedModels.map((entry) => entry.model);
  return scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
}

function supportsThinkingLevel(model: Model<any>, level: ThinkingLevel): boolean {
  if (!model.reasoning) return level === "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  if (level === "xhigh" || level === "max") return mapped !== undefined;
  return true;
}

export async function resolveChildModel(
  input: SpawnAgentInput,
  ctx: ExtensionContext,
): Promise<ChildModelSelection> {
  const root = ctx.model;
  if (!root) {
    throw new Error("Capability error: the root has no selected model");
  }

  const candidates = configuredModels(ctx).filter((model) => model.id === (input.model ?? root.id));
  let selected: Model<any> | undefined;

  if (!input.model) {
    selected = root;
  } else {
    const reconstructible = candidates.filter((model) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus(model.provider);
      return auth.configured && auth.source !== "runtime";
    });
    selected = reconstructible.find((model) => model.provider === root.provider) ??
      reconstructible.sort((a, b) => modelIdentity(a).localeCompare(modelIdentity(b)))[0];

    // Preserve the useful runtime-only diagnostic when there is no provider
    // whose authentication can be reconstructed by the subprocess.
    if (!selected) {
      const runtimeOnly = candidates.find((model) => {
        const auth = ctx.modelRegistry.getProviderAuthStatus(model.provider);
        return auth.configured && auth.source === "runtime";
      });
      if (runtimeOnly) {
        throw new Error(
          `Capability error: runtime-only authentication for ${runtimeOnly.provider} cannot be reconstructed in a child subprocess`,
        );
      }
    }
  }

  if (!selected) {
    throw new Error(
      `Capability error: model ${JSON.stringify(input.model ?? root.id)} is unavailable or unauthenticated`,
    );
  }

  const auth = ctx.modelRegistry.getProviderAuthStatus(selected.provider);
  if (!auth.configured) {
    throw new Error(`Authentication error: no configured authentication for provider ${selected.provider}`);
  }
  if (auth.source === "runtime") {
    throw new Error(
      `Capability error: runtime-only authentication for ${selected.provider} cannot be reconstructed in a child subprocess`,
    );
  }

  const thinkingLevel: ThinkingLevel = input.reasoning_effort ?? ctx.thinkingLevel ?? "medium";
  if (!supportsThinkingLevel(selected, thinkingLevel)) {
    throw new Error(
      `Capability error: ${modelIdentity(selected)} does not support thinking level ${thinkingLevel}`,
    );
  }

  return {
    provider: selected.provider,
    modelId: selected.id,
    thinkingLevel,
  };
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nonInheritableToolError(tool: ToolInfo, reason: string): Error {
  return new Error(`Capability error: active tool ${tool.name} is not inheritable: ${reason}`);
}

export async function resolveChildTools(
  pi: ExtensionAPI,
  cwd: string = process.cwd(),
): Promise<ChildToolSelection> {
  const activeTools = pi.getActiveTools().filter((name) => !collaborationNames.has(name));
  const all = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const extensionPaths = new Set<string>();

  for (const name of activeTools) {
    const tool = all.get(name);
    if (!tool) {
      throw new Error(`Capability error: active tool ${name} has no registered tool metadata`);
    }
    const source = tool.sourceInfo;
    if (source.source === "builtin") continue;
    if (source.source === "sdk") {
      throw nonInheritableToolError(tool, "SDK/in-memory tool closures cannot cross a subprocess boundary");
    }

    if (!source.path || source.path.startsWith("<")) {
      throw nonInheritableToolError(tool, `source ${JSON.stringify(source.path)} is synthetic or not a local file`);
    }

    // User/project extensions (including their configured packages) are
    // discovered normally. Temporary extension resources are not persistent,
    // so forward their resolved readable entry point explicitly.
    if (source.scope === "user" || source.scope === "project") continue;
    if (source.scope !== "temporary") {
      throw nonInheritableToolError(tool, "the extension source cannot be reconstructed by normal discovery");
    }
    const localPath = isAbsolute(source.path) ? source.path : resolve(cwd, source.path);
    if (!(await isReadableFile(localPath))) {
      throw nonInheritableToolError(tool, `source ${JSON.stringify(localPath)} is not a readable local file`);
    }
    extensionPaths.add(localPath);
  }

  return { activeTools, extensionPaths: [...extensionPaths].sort() };
}

export async function snapshotChildRuntime(
  pi: ExtensionAPI,
  input: SpawnAgentInput,
  ctx: ExtensionContext,
): Promise<ChildRuntimeSnapshot> {
  const [model, tools] = await Promise.all([resolveChildModel(input, ctx), resolveChildTools(pi, ctx.cwd)]);
  return {
    ...model,
    ...tools,
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
  };
}
