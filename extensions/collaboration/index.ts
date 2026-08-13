import type {
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { COLLABORATION_MAILBOX_TYPE, RootMailbox, type MailboxMessageDetails } from "./src/mailbox.ts";
import { freshHistorySeeder } from "./src/history-seeder.ts";
import { snapshotChildRuntime } from "./src/launch-config.ts";
import { BoundedMonitorBuffer } from "./src/monitor/model.ts";
import {
  installCollaborationUi,
  showAgentsCommand,
  truncateTerminalLine,
  type CollaborationUiController,
} from "./src/monitor/ui.ts";
import { CollaborationRegistry, type ChildRecord } from "./src/registry.ts";
import {
  COLLABORATION_CHILD_ENV,
  createPiRpcLaunch,
  RpcChildWorker,
} from "./src/rpc-child.ts";
import {
  allocateChildSession,
  removeFailedChildSession,
  type ChildSessionAllocation,
} from "./src/session-paths.ts";
import { registerCollaborationTools } from "./src/tools.ts";

interface ActiveRootSession {
  readonly registry: CollaborationRegistry<BoundedMonitorBuffer>;
  readonly mailbox: RootMailbox;
  readonly allocations: Map<string, ChildSessionAllocation>;
  readonly ui?: CollaborationUiController;
}

export interface CollaborationExtensionOptions {
  /** Test seam; production resolves Pi's exported getAgentDir lazily. */
  resolveAgentDirectory?: () => string | Promise<string>;
}

function statusLabel(details: MailboxMessageDetails | undefined): string {
  const status = details?.status;
  if (typeof status === "object" && status !== null) {
    return "completed" in status ? "completed" : "errored";
  }
  return status ?? "finished";
}

/** Small model-message renderer; the full envelope remains the durable content. */
export function renderMailboxMessage(
  content: string,
  details: MailboxMessageDetails | undefined,
  options: MessageRenderOptions,
  theme: Theme,
): Component {
  const sender = details?.sender ?? "child";
  const header = theme.fg("accent", `${sender} · ${statusLabel(details)}`);
  const payloadMarker = "Payload:\n";
  const payloadIndex = content.indexOf(payloadMarker);
  const payload = payloadIndex < 0 ? content : content.slice(payloadIndex + payloadMarker.length);
  const lines = options.expanded
    ? [header, ...payload.split("\n")]
    : [header, theme.fg("muted", payload.split("\n", 1)[0] ?? "")];
  return {
    render(width: number) {
      return lines.map(
        (line) => `${" ".repeat(options.outputPad)}${truncateTerminalLine(line, Math.max(0, width - options.outputPad))}`,
      );
    },
    invalidate() {},
  };
}

async function productionAgentDirectory(): Promise<string> {
  // Keep this runtime import lazy: child-marker instances return from the
  // factory before loading any collaboration runtime, and Pi owns this API.
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return getAgentDir();
}

export function createCollaborationExtension(options: CollaborationExtensionOptions = {}) {
  return function collaborationExtension(pi: ExtensionAPI): void {
    if (process.env[COLLABORATION_CHILD_ENV] === "1") return;

    let active: ActiveRootSession | undefined;
    let lifecycleGeneration = 0;

    const requireActive = (): ActiveRootSession => {
      if (!active) throw new Error("Lifecycle error: collaboration is not attached to an active root session");
      return active;
    };

    registerCollaborationTools(
      pi,
      () => requireActive().registry,
      () => requireActive().mailbox,
    );

    pi.registerMessageRenderer<MailboxMessageDetails>(
      COLLABORATION_MAILBOX_TYPE,
      (message, renderOptions, theme) => {
        const content = typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
              .map((block) => block.text)
              .join("\n");
        return renderMailboxMessage(content, message.details, renderOptions, theme);
      },
    );

    pi.registerCommand("agents", {
      description: "Inspect and interrupt direct collaboration children",
      async handler(_args, ctx) {
        await showAgentsCommand(ctx, requireActive().registry);
      },
    });

    pi.on("input", (event) => {
      if (event.streamingBehavior === "steer") {
        active?.mailbox.notifyHumanInput(event.source);
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      const generation = ++lifecycleGeneration;
      const previous = active;
      active = undefined;
      if (previous) await teardown(previous);
      if (generation !== lifecycleGeneration) return;

      const rootSessionFile = ctx.sessionManager.getSessionFile();
      const rootSessionId = ctx.sessionManager.getSessionId();
      const resolveAgentDirectory = options.resolveAgentDirectory ?? productionAgentDirectory;
      const agentDirectory = rootSessionFile === undefined
        ? await resolveAgentDirectory()
        : undefined;
      if (generation !== lifecycleGeneration) return;
      const allocations = new Map<string, ChildSessionAllocation>();

      const mailbox = new RootMailbox({
        delivery: {
          isIdle: () => ctx.isIdle(),
          sendMessage(message, sendOptions) {
            pi.sendMessage(message, sendOptions);
          },
        },
      });

      const registry = new CollaborationRegistry<BoundedMonitorBuffer>({
        async allocateSession(childId, taskName) {
          const allocation = await allocateChildSession(
            { rootSessionFile, rootSessionId, taskName, childId },
            agentDirectory === undefined
              ? {}
              : { getAgentDirectory: () => agentDirectory },
          );
          allocations.set(allocation.sessionFile, allocation);
          try {
            await freshHistorySeeder.seed({ childSessionFile: allocation.sessionFile });
          } catch (error) {
            await removeFailedChildSession(allocation).catch(() => undefined);
            allocations.delete(allocation.sessionFile);
            throw error;
          }
          return allocation;
        },
        async removeFailedSession(sessionFile) {
          const allocation = allocations.get(sessionFile);
          if (allocation) {
            await removeFailedChildSession(allocation);
          } else {
            // The registry owns only exact child JSONL paths supplied by this
            // allocator. Reconstructing the narrow allocation lets a late
            // rollback clean up after teardown dropped bookkeeping.
            await removeFailedChildSession({
              sessionFile,
              sessionDirectory: "",
              finalAnswerFile: "",
            });
          }
          allocations.delete(sessionFile);
        },
        snapshotRuntime(input) {
          return snapshotChildRuntime(pi, input, ctx);
        },
        buildLaunch(record, runtime, childSystemPrompt) {
          return createPiRpcLaunch({
            sessionFile: record.sessionFile,
            name: record.canonicalPath,
            provider: runtime.provider,
            modelId: runtime.modelId,
            thinkingLevel: runtime.thinkingLevel,
            tools: runtime.activeTools,
            extensionPaths: runtime.extensionPaths,
            appendSystemPrompt: childSystemPrompt,
            projectTrusted: runtime.projectTrusted,
            cwd: runtime.cwd,
          });
        },
        createWorker(workerOptions) {
          return new RpcChildWorker(workerOptions);
        },
        createMonitor() {
          return new BoundedMonitorBuffer();
        },
        ingestMonitor(monitor, event) {
          monitor.ingest(event);
        },
        appendFinalMonitor(monitor, status, summary, fullAnswerFile) {
          monitor.append({
            kind: "final",
            status,
            summary,
            ...(fullAnswerFile === undefined ? {} : { fullAnswerFile }),
          });
        },
        async deliverFinal(record, status) {
          const delivery = await mailbox.deliverFinal({
            sender: record.canonicalPath,
            sessionFile: record.sessionFile,
            status,
            dedupeKey: finalDedupeKey(record),
          });
          return {
            status: delivery.status,
            ...(delivery.message.details.fullAnswerFile === undefined
              ? {}
              : { fullAnswerFile: delivery.message.details.fullAnswerFile }),
          };
        },
      });

      try {
        const ui = ctx.mode === "tui" ? installCollaborationUi(ctx, registry) : undefined;
        if (generation !== lifecycleGeneration) {
          await teardown({ registry, mailbox, allocations, ...(ui === undefined ? {} : { ui }) });
          return;
        }
        active = { registry, mailbox, allocations, ...(ui === undefined ? {} : { ui }) };
      } catch (error) {
        mailbox.shutdown();
        await registry.dispose().catch(() => undefined);
        throw error;
      }
    });

    pi.on("session_shutdown", async () => {
      lifecycleGeneration += 1;
      const session = active;
      active = undefined;
      if (session) await teardown(session);
    });
  };
}

function finalDedupeKey(record: Readonly<ChildRecord<BoundedMonitorBuffer>>): string {
  return `${record.id}:${record.activeTurnId ?? "none"}:${record.workerGeneration}`;
}

async function teardown(session: ActiveRootSession): Promise<void> {
  const failures: unknown[] = [];
  try {
    session.ui?.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    session.mailbox.shutdown();
  } catch (error) {
    failures.push(error);
  }
  try {
    await session.registry.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw failures[0];
}

export default createCollaborationExtension();
