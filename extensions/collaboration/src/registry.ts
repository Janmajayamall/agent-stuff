import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentStatus,
  FollowupTaskResult,
  InterruptAgentResult,
  ListAgentsResult,
  SendMessageResult,
  SpawnAgentInput,
  SpawnAgentResult,
} from "./contracts.ts";
import {
  isActiveStatus,
  isInactiveLiveStatus,
} from "./contracts.ts";
import {
  composeInactiveTaskPrompt,
  createParentEnvelope,
  createQueuedParentMessage,
  type MessageIdFactory,
  type QueuedParentMessage,
} from "./envelopes.ts";
import type { ChildRuntimeSnapshot } from "./launch-config.ts";
import { formatStatusPayload, mapSettledOutcome, type AssistantOutcomeMessage } from "./outcome.ts";
import type {
  ExpectedRpcState,
  RpcChildWorker,
  RpcExitInfo,
  RpcLaunchSpec,
  SanitizedRpcEvent,
  WorkerToken,
} from "./rpc-child.ts";
import { RpcAdmissionClosedError, RpcDeliveryRacedSettlementError } from "./rpc-child.ts";
import { ActiveTurnSlots, AsyncSerialQueue } from "./synchronization.ts";

export type WorkerPhase = "idle" | "starting" | "accepting" | "settling" | "closing";

export interface ChildRecord<TMonitor = unknown> {
  id: string;
  taskName: string;
  canonicalPath: string;
  parentPath: "/root";
  sessionFile: string;
  status: AgentStatus;
  worker?: RpcChildWorker | undefined;
  workerPhase: WorkerPhase;
  workerGeneration: number;
  activeTurnId?: string | undefined;
  createdAt: number;
  turnStartedAt?: number | undefined;
  settledAt?: number | undefined;
  queuedMessages: QueuedParentMessage[];
  monitor: TMonitor;
  lastActivity?: string | undefined;
  finalAnswerFile?: string | undefined;
  runtime?: ChildRuntimeSnapshot | undefined;

  readonly lifecycle: AsyncSerialQueue;
  readonly finalizedTurnIds: Set<string>;
  interruptTurnId?: string | undefined;
  finalAssistant?: AssistantOutcomeMessage | undefined;
  pendingTerminal?: { turnId: string; status: AgentStatus } | undefined;
  /** The current turn has passed state verification, prompt ack, and agent_start. */
  readyTurnId?: string | undefined;
  /** Root shutdown preserves allocations already known to the registry. */
  preserveSessionOnRollback?: boolean | undefined;
  /** Coalesces repeated abort requests while spawn owns the lifecycle queue. */
  interruptOperation?: { turnId: string; promise: Promise<void> } | undefined;
  /** Prior terminal turn that may be restored if an inactive restart fails. */
  restorableTurnId?: string | undefined;
  /** Delivery that completed while its terminal turn was temporarily superseded. */
  deferredDelivery?: TerminalDelivery | undefined;
}

type TerminalDelivery =
  | {
      turnId: string;
      kind: "success";
      status?: AgentStatus | undefined;
      fullAnswerFile?: string | undefined;
    }
  | {
      turnId: string;
      kind: "error";
      message: string;
    };

export interface SessionAllocation {
  sessionFile: string;
}

export interface WorkerFactoryOptions {
  token: WorkerToken;
  launch: RpcLaunchSpec;
  onEvent: (event: SanitizedRpcEvent, token: WorkerToken) => void;
  onSettled: (token: WorkerToken) => void;
  onExit: (exit: RpcExitInfo, token: WorkerToken) => void;
  onUnexpectedExit: (error: Error, token: WorkerToken) => void;
  onProtocolError: (error: Error, token: WorkerToken) => void;
}

export interface RegistryDependencies<TMonitor = unknown> {
  allocateSession(childId: string, taskName: string): Promise<SessionAllocation>;
  removeFailedSession(sessionFile: string): Promise<void>;
  snapshotRuntime(input: SpawnAgentInput): Promise<ChildRuntimeSnapshot>;
  buildLaunch(
    record: ChildRecord<TMonitor>,
    runtime: ChildRuntimeSnapshot,
    childSystemPrompt: string,
  ): RpcLaunchSpec;
  createWorker(options: WorkerFactoryOptions): RpcChildWorker;
  createMonitor(): TMonitor;
  ingestMonitor(monitor: TMonitor, event: SanitizedRpcEvent): void;
  appendFinalMonitor?: (
    monitor: TMonitor,
    status: AgentStatus,
    summary: string,
    fullAnswerFile?: string,
  ) => void;
  deliverFinal(
    record: Readonly<ChildRecord<TMonitor>>,
    status: AgentStatus,
    payload: string,
  ): Promise<{ status?: AgentStatus; fullAnswerFile?: string }>;
  now?: () => number;
  createId?: () => string;
  createMessageId?: MessageIdFactory;
  onChanged?: (record: Readonly<ChildRecord<TMonitor>>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function semanticNonblank(value: string, field: string): void {
  if (!value.trim()) throw new Error(`Schema error: ${field} must contain a non-whitespace character`);
}

function childInstruction(record: Pick<ChildRecord, "canonicalPath">): string {
  return [
    `You are ${record.canonicalPath}, a direct child agent of /root.`,
    "You share /root's current working directory and filesystem; edits are immediately visible to every agent.",
    "You do not have collaboration tools and cannot create descendants.",
    "Work only on the assigned messages and finish the active task with a useful final response to /root.",
  ].join(" ");
}

function recordActivity(event: SanitizedRpcEvent): string | undefined {
  if (event.type === "tool_execution_start") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const args = isRecord(event.args) ? event.args : undefined;
    const detail = toolName === "bash" && typeof args?.command === "string"
      ? args.command
      : args
        ? JSON.stringify(args)
        : "";
    const preview = detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
    return `running ${toolName}${preview ? `: ${preview}` : ""}`;
  }
  if (event.type === "message_update") return "responding";
  if (event.type === "compaction_start") return "compacting context";
  if (event.type === "auto_retry_start") return "retrying provider request";
  return undefined;
}

function assistantFromEvent(event: SanitizedRpcEvent): AssistantOutcomeMessage | undefined {
  if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") {
    return undefined;
  }
  return event.message as AssistantOutcomeMessage;
}

export class CollaborationRegistry<TMonitor = unknown> {
  private readonly byId = new Map<string, ChildRecord<TMonitor>>();
  private readonly byName = new Map<string, ChildRecord<TMonitor>>();
  private readonly byPath = new Map<string, ChildRecord<TMonitor>>();
  private readonly slots = new ActiveTurnSlots(3);
  private readonly listeners = new Set<(record: Readonly<ChildRecord<TMonitor>>) => void>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createMessageId: MessageIdFactory;
  private disposed = false;

  constructor(private readonly deps: RegistryDependencies<TMonitor>) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? randomUUID;
    this.createMessageId = deps.createMessageId ?? randomUUID;
  }

  get activeTurnCount(): number {
    return this.slots.active;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  subscribe(listener: (record: Readonly<ChildRecord<TMonitor>>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  children(): readonly Readonly<ChildRecord<TMonitor>>[] {
    return [...this.byPath.values()].sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  }

  async spawn(input: SpawnAgentInput): Promise<SpawnAgentResult> {
    this.assertOpen();
    semanticNonblank(input.message, "message");
    if (!/^[a-z0-9_]+$/.test(input.task_name)) throw new Error("Name error: invalid task_name");
    if (this.byName.has(input.task_name)) {
      throw new Error(`Name error: task_name ${JSON.stringify(input.task_name)} is already reserved`);
    }

    const childId = this.createId();
    const activeTurnId = this.createId();
    this.slots.reserve(activeTurnId);

    const record: ChildRecord<TMonitor> = {
      id: childId,
      taskName: input.task_name,
      canonicalPath: `/root/${input.task_name}`,
      parentPath: "/root",
      sessionFile: "",
      status: "pending_init",
      workerPhase: "starting",
      workerGeneration: 0,
      activeTurnId,
      createdAt: this.now(),
      queuedMessages: [],
      monitor: this.deps.createMonitor(),
      lifecycle: new AsyncSerialQueue(),
      finalizedTurnIds: new Set(),
      lastActivity: "initializing",
    };
    this.addRecord(record);
    this.changed(record);

    return record.lifecycle.run(async () => {
      try {
        const runtime = await this.deps.snapshotRuntime(input);
        const allocation = await this.deps.allocateSession(record.id, record.taskName);
        // Record the exact artifact first so a late allocation that finishes
        // after shutdown can still be cleaned up by rollback.
        record.sessionFile = allocation.sessionFile;
        this.assertRecordCurrent(record);
        record.runtime = runtime;
        const prompt = createParentEnvelope(
          "TASK",
          record.canonicalPath,
          input.message,
          this.createMessageId(),
        );
        await this.startTurn(record, activeTurnId, runtime, prompt);
        return { task_name: record.canonicalPath };
      } catch (error) {
        await this.awaitInterruptOperation(record, activeTurnId);
        // An extension-owned interrupt can deliberately prevent prompt
        // readiness. The exclusively-created session is nevertheless a
        // durable, reopenable logical child and must remain follow-up capable.
        if (this.retainInterruptedStart(record, activeTurnId)) throw error;
        await this.rollbackSpawn(record);
        throw error;
      }
    });
  }

  async sendMessage(target: string, message: string): Promise<SendMessageResult> {
    semanticNonblank(target, "target");
    semanticNonblank(message, "message");
    const record = this.resolveTarget(target);
    return record.lifecycle.run(async () => {
      this.assertTargetLive(record);
      const queued = createQueuedParentMessage(message, this.createMessageId);
      if (!isActiveStatus(record.status) || !record.worker) {
        record.queuedMessages.push(queued);
        this.changed(record);
        return { target: record.canonicalPath, delivery: "queued" };
      }

      const worker = record.worker;
      const envelope = createParentEnvelope("MESSAGE", record.canonicalPath, message, queued.id);
      try {
        await worker.steer(envelope);
        return { target: record.canonicalPath, delivery: "steered" };
      } catch (error) {
        if (!this.isSettlementRace(error, worker)) throw error;
        await worker.closed;
        this.assertTargetLive(record);
        record.queuedMessages.push(queued);
        this.changed(record);
        return { target: record.canonicalPath, delivery: "queued" };
      }
    });
  }

  async followupTask(target: string, message: string): Promise<FollowupTaskResult> {
    semanticNonblank(target, "target");
    semanticNonblank(message, "message");
    const record = this.resolveTarget(target);
    return record.lifecycle.run(async () => {
      this.assertTargetLive(record);
      if (isActiveStatus(record.status) && record.worker) {
        const worker = record.worker;
        const envelope = createParentEnvelope(
          "FOLLOW_UP",
          record.canonicalPath,
          message,
          this.createMessageId(),
        );
        try {
          await worker.followUp(envelope);
          return { target: record.canonicalPath, delivery: "follow_up" };
        } catch (error) {
          if (!this.isSettlementRace(error, worker)) throw error;
          await worker.closed;
        }
      }

      await this.startInactiveFollowup(record, message);
      return { target: record.canonicalPath, delivery: "started" };
    });
  }

  async interruptAgent(target: string): Promise<InterruptAgentResult> {
    semanticNonblank(target, "target");
    const record = this.resolveTarget(target);

    // Spawn owns the lifecycle queue until readiness. An interrupt must still
    // reach an already-created initializing worker instead of waiting behind
    // the prompt it is intended to cancel.
    if (record.status === "pending_init" && record.worker && record.activeTurnId) {
      const previousStatus = record.status;
      const turnId = record.activeTurnId;
      const existing = record.interruptOperation;
      if (existing?.turnId === turnId) {
        await existing.promise;
        return { target: record.canonicalPath, previous_status: previousStatus };
      }
      const generation = record.workerGeneration;
      const worker = record.worker;
      record.interruptTurnId = turnId;
      record.lastActivity = "interrupting";
      this.changed(record);
      const operation = worker.interrupt().then(() => {
        if (
          !this.disposed &&
          this.byId.get(record.id) === record &&
          record.activeTurnId === turnId &&
          record.workerGeneration === generation &&
          !record.finalizedTurnIds.has(turnId)
        ) {
          this.stageOrFinalizeTurn(record, turnId, "interrupted");
        }
      });
      record.interruptOperation = { turnId, promise: operation };
      try {
        await operation;
      } catch (error) {
        if (
          !this.disposed &&
          this.byId.get(record.id) === record &&
          record.activeTurnId === turnId &&
          record.workerGeneration === generation &&
          !record.finalizedTurnIds.has(turnId)
        ) {
          record.interruptTurnId = undefined;
          record.lastActivity = record.readyTurnId === turnId ? "running" : "initializing";
          this.changed(record);
        }
        throw error;
      } finally {
        if (record.interruptOperation?.promise === operation) {
          record.interruptOperation = undefined;
        }
      }
      return { target: record.canonicalPath, previous_status: previousStatus };
    }

    return record.lifecycle.run(async () => {
      this.assertTargetLive(record);
      const previousStatus = record.status;
      if (isActiveStatus(record.status) && record.worker && record.activeTurnId) {
        const turnId = record.activeTurnId;
        const generation = record.workerGeneration;
        const worker = record.worker;
        record.interruptTurnId = turnId;
        record.lastActivity = "interrupting";
        this.changed(record);
        try {
          await worker.interrupt();
        } catch (error) {
          if (
            !this.disposed &&
            this.byId.get(record.id) === record &&
            record.activeTurnId === turnId &&
            record.workerGeneration === generation &&
            record.worker === worker &&
            !record.finalizedTurnIds.has(turnId)
          ) {
            record.interruptTurnId = undefined;
            record.lastActivity = "running";
            this.changed(record);
          }
          throw error;
        }
        if (
          !this.disposed &&
          this.byId.get(record.id) === record &&
          record.activeTurnId === turnId &&
          record.workerGeneration === generation &&
          record.worker === worker &&
          !record.finalizedTurnIds.has(turnId)
        ) {
          this.finalizeTurn(record, turnId, "interrupted");
        }
      }
      return { target: record.canonicalPath, previous_status: previousStatus };
    });
  }

  listAgents(pathPrefix?: string): ListAgentsResult {
    this.assertOpen();
    if (pathPrefix !== undefined) {
      semanticNonblank(pathPrefix, "path_prefix");
      if (pathPrefix.endsWith("/")) throw new Error("Schema error: path_prefix must not end in '/'");
    }
    const agents: ListAgentsResult["agents"] = [
      { agent_name: "/root", agent_status: "running" },
      ...this.children().map((record) => ({
        agent_name: record.canonicalPath,
        agent_status: record.status,
      })),
    ];
    return {
      agents: agents
        .filter((agent) => pathPrefix === undefined || agent.agent_name.startsWith(pathPrefix))
        .sort((a, b) => a.agent_name.localeCompare(b.agent_name)),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const stops: Promise<unknown>[] = [];
    for (const record of this.byId.values()) {
      if (record.activeTurnId) this.slots.release(record.activeTurnId);
      record.preserveSessionOnRollback = record.sessionFile.length > 0;
      record.interruptOperation = undefined;
      record.restorableTurnId = undefined;
      record.deferredDelivery = undefined;
      record.status = "shutdown";
      record.workerPhase = record.worker ? "closing" : "idle";
      if (record.worker) stops.push(record.worker.shutdown().catch(() => undefined));
      this.changed(record);
    }
    await Promise.allSettled(stops);
    this.slots.clear();
    this.listeners.clear();
    this.byId.clear();
    this.byName.clear();
    this.byPath.clear();
  }

  private async startInactiveFollowup(record: ChildRecord<TMonitor>, message: string): Promise<void> {
    if (!isInactiveLiveStatus(record.status)) {
      throw new Error(`Lifecycle error: ${record.canonicalPath} cannot accept a follow-up while ${JSON.stringify(record.status)}`);
    }
    const previousTurnId = record.activeTurnId;
    const previousGeneration = record.workerGeneration;
    const previousWorker = record.worker;
    if (previousWorker) await previousWorker.closed;
    this.assertRecordCurrent(record);
    if (
      record.activeTurnId !== previousTurnId ||
      record.workerGeneration !== previousGeneration ||
      !isInactiveLiveStatus(record.status)
    ) {
      throw new Error(
        `Lifecycle error: ${record.canonicalPath} changed while waiting for its prior worker to close`,
      );
    }

    // Snapshot only after the old worker closes. Its terminal mailbox may have
    // legitimately bounded the prior status or attached an artifact meanwhile.
    const previousStatus = record.status;
    const previousFinalAnswerFile = record.finalAnswerFile;
    const previousFinalAssistant = record.finalAssistant;
    const previousInterruptTurnId = record.interruptTurnId;
    const previousReadyTurnId = record.readyTurnId;
    const previousTurnStartedAt = record.turnStartedAt;
    const previousSettledAt = record.settledAt;

    const turnId = this.createId();
    this.slots.reserve(turnId);
    // Full callback tokens make every older generation stale once this turn
    // starts, so historical finalized IDs need not accumulate indefinitely.
    record.finalizedTurnIds.clear();
    const queued = [...record.queuedMessages];
    const prompt = composeInactiveTaskPrompt(
      record.canonicalPath,
      queued,
      message,
      this.createMessageId,
    );
    record.status = "pending_init";
    record.activeTurnId = turnId;
    record.workerPhase = "starting";
    record.turnStartedAt = this.now();
    record.settledAt = undefined;
    record.lastActivity = "restarting";
    record.finalAssistant = undefined;
    record.finalAnswerFile = undefined;
    record.interruptTurnId = undefined;
    record.pendingTerminal = undefined;
    record.readyTurnId = undefined;
    record.restorableTurnId = previousTurnId;
    record.deferredDelivery = undefined;
    this.changed(record);

    try {
      // A logical child retains the model, thinking, tool, and trust snapshot
      // selected when it was spawned. Its durable session supplies history.
      const runtime = record.runtime;
      if (!runtime) throw new Error("Lifecycle error: child runtime snapshot is missing");
      await this.startTurn(record, turnId, runtime, prompt);
      record.queuedMessages.splice(0, queued.length);
      record.restorableTurnId = undefined;
      record.deferredDelivery = undefined;
    } catch (error) {
      await this.awaitInterruptOperation(record, turnId);
      if (this.retainInterruptedStart(record, turnId)) {
        // The interrupted restart is now the child's terminal logical turn;
        // an older turn's late mailbox must never overwrite it.
        record.restorableTurnId = undefined;
        record.deferredDelivery = undefined;
        throw error;
      }
      const failedWorker = record.worker;
      // Invalidate the current token before shutdown. Expected shutdown exit
      // callbacks must not turn a failed restart into a false terminal result.
      this.slots.release(turnId);
      const stillCurrent = !this.disposed && this.byId.get(record.id) === record;
      if (stillCurrent && record.activeTurnId === turnId) {
        record.status = previousStatus;
        record.activeTurnId = previousTurnId;
        record.workerPhase = "idle";
        record.worker = undefined;
        record.pendingTerminal = undefined;
        record.readyTurnId = previousReadyTurnId;
        record.turnStartedAt = previousTurnStartedAt;
        record.settledAt = previousSettledAt;
        record.interruptTurnId = previousInterruptTurnId;
        record.finalAssistant = previousFinalAssistant;
        record.finalAnswerFile = previousFinalAnswerFile;
        record.lastActivity = "follow-up start failed";
        const deferredDelivery = this.takeDeferredDelivery(record);
        record.restorableTurnId = undefined;
        if (deferredDelivery !== undefined && deferredDelivery.turnId === previousTurnId) {
          this.applyTerminalDelivery(record, deferredDelivery);
        }
        this.changed(record);
      }
      if (!this.disposed && failedWorker && !failedWorker.isClosed) {
        await failedWorker.shutdown().catch(() => undefined);
      }
      throw error;
    }
  }

  private async startTurn(
    record: ChildRecord<TMonitor>,
    turnId: string,
    runtime: ChildRuntimeSnapshot,
    prompt: string,
  ): Promise<void> {
    const generation = record.workerGeneration + 1;
    record.workerGeneration = generation;
    const token: WorkerToken = { childId: record.id, activeTurnId: turnId, workerGeneration: generation };
    const launch = this.deps.buildLaunch(record, runtime, childInstruction(record));
    const worker = this.deps.createWorker({
      token,
      launch,
      onEvent: (event, callbackToken) => this.onWorkerEvent(event, callbackToken),
      onSettled: (callbackToken) => this.onWorkerSettled(callbackToken),
      onExit: (exit, callbackToken) => this.onWorkerExit(exit, callbackToken),
      onUnexpectedExit: (error, callbackToken) => this.onUnexpectedExit(error, callbackToken),
      onProtocolError: (error, callbackToken) => this.onProtocolError(error, callbackToken),
    });
    record.worker = worker;
    record.workerPhase = "starting";
    this.changed(record);

    worker.start();
    const expected: ExpectedRpcState = {
      provider: runtime.provider,
      modelId: runtime.modelId,
      thinkingLevel: runtime.thinkingLevel as ThinkingLevel,
      sessionFile: record.sessionFile,
      isStreaming: false,
    };
    await worker.verifyState(expected);
    await worker.promptAndWaitForStart(prompt);

    this.assertRecordCurrent(record);
    if (!this.matches(record, token)) {
      throw new Error("Lifecycle error: child start was superseded by another turn");
    }
    record.readyTurnId = turnId;
    // A very short child may settle before this method observes readiness. In
    // that case readiness still proves the turn started; never overwrite its
    // terminal status with running.
    if (record.pendingTerminal?.turnId === turnId) {
      const terminal = record.pendingTerminal.status;
      record.pendingTerminal = undefined;
      this.finalizeTurn(record, turnId, terminal);
    } else if (record.status === "pending_init") {
      record.status = "running";
      record.workerPhase = "accepting";
      record.turnStartedAt = this.now();
      record.lastActivity = "running";
      this.changed(record);
    }
  }

  private onWorkerEvent(event: SanitizedRpcEvent, token: WorkerToken): void {
    if (this.disposed) return;
    const record = this.byId.get(token.childId);
    if (!record || !this.matches(record, token)) return;
    this.deps.ingestMonitor(record.monitor, event);
    const assistant = assistantFromEvent(event);
    if (assistant) record.finalAssistant = assistant;
    const activity = recordActivity(event);
    if (activity) record.lastActivity = activity;
    this.changed(record);
  }

  private onWorkerSettled(token: WorkerToken): void {
    if (this.disposed) return;
    const record = this.byId.get(token.childId);
    if (!record || !this.matches(record, token)) return;
    record.workerPhase = "settling";
    const status = mapSettledOutcome({
      finalAssistant: record.finalAssistant,
      interruptedByExtension: record.interruptTurnId === token.activeTurnId,
    });
    this.stageOrFinalizeTurn(record, token.activeTurnId, status);
  }

  private onUnexpectedExit(error: Error, token: WorkerToken): void {
    if (this.disposed) return;
    const record = this.byId.get(token.childId);
    if (!record || !this.matches(record, token) || record.finalizedTurnIds.has(token.activeTurnId)) return;
    const diagnostic = error.message || "Child RPC process exited unexpectedly";
    this.stageOrFinalizeTurn(
      record,
      token.activeTurnId,
      record.interruptTurnId === token.activeTurnId ? "interrupted" : { errored: diagnostic },
    );
  }

  private onWorkerExit(exit: RpcExitInfo, token: WorkerToken): void {
    if (this.disposed) return;
    const record = this.byId.get(token.childId);
    if (!record || !this.matches(record, token)) return;
    if (!record.finalizedTurnIds.has(token.activeTurnId) && !exit.settled) {
      const diagnostic = exit.stderr || `Child process exited (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"})`;
      this.stageOrFinalizeTurn(
        record,
        token.activeTurnId,
        record.interruptTurnId === token.activeTurnId ? "interrupted" : { errored: diagnostic },
      );
    }
    record.workerPhase = "idle";
    record.worker = undefined;
    this.changed(record);
  }

  private onProtocolError(error: Error, token: WorkerToken): void {
    if (this.disposed) return;
    const record = this.byId.get(token.childId);
    if (!record || !this.matches(record, token)) return;
    record.lastActivity = `RPC warning: ${error.message}`;
    this.changed(record);
  }

  private finalizeTurn(record: ChildRecord<TMonitor>, turnId: string, status: AgentStatus): void {
    if (record.finalizedTurnIds.has(turnId)) return;
    record.finalizedTurnIds.add(turnId);
    this.slots.release(turnId);
    if (record.activeTurnId === turnId) {
      record.status = status;
      record.settledAt = this.now();
      record.workerPhase = record.worker === undefined || record.worker.isClosed ? "idle" : "settling";
      record.lastActivity = typeof status === "object" && "errored" in status ? "errored" : String(status === "interrupted" ? "interrupted" : "completed");
      this.changed(record);
    }

    const payload = formatStatusPayload(status);
    this.deps.appendFinalMonitor?.(record.monitor, status, payload);
    void this.deps.deliverFinal(record, status, payload).then(
      (delivered) => {
        this.receiveTerminalDelivery(record, {
          turnId,
          kind: "success",
          ...(delivered.status === undefined ? {} : { status: delivered.status }),
          ...(delivered.fullAnswerFile === undefined
            ? {}
            : { fullAnswerFile: delivered.fullAnswerFile }),
        });
      },
      (error) => {
        this.receiveTerminalDelivery(record, {
          turnId,
          kind: "error",
          message: errorText(error),
        });
      },
    );
  }

  private receiveTerminalDelivery(
    record: ChildRecord<TMonitor>,
    delivery: TerminalDelivery,
  ): void {
    if (this.disposed || this.byId.get(record.id) !== record) return;
    if (record.activeTurnId === delivery.turnId) {
      this.applyTerminalDelivery(record, delivery);
      this.changed(record);
      return;
    }
    if (record.restorableTurnId === delivery.turnId) {
      // A restart attempt temporarily supersedes the old terminal token. Keep
      // its delivery internal until that attempt either commits or rolls back.
      record.deferredDelivery = delivery;
    }
  }

  private applyTerminalDelivery(
    record: ChildRecord<TMonitor>,
    delivery: TerminalDelivery,
  ): void {
    if (delivery.kind === "error") {
      record.lastActivity = `mailbox delivery failed: ${delivery.message}`;
      return;
    }
    // Absence is meaningful: a short latest answer must clear an older
    // truncated-answer artifact association.
    record.finalAnswerFile = delivery.fullAnswerFile;
    if (delivery.status !== undefined) record.status = delivery.status;
  }

  private takeDeferredDelivery(record: ChildRecord<TMonitor>): TerminalDelivery | undefined {
    const delivery: TerminalDelivery | undefined = record.deferredDelivery;
    record.deferredDelivery = undefined;
    return delivery;
  }

  private async awaitInterruptOperation(
    record: ChildRecord<TMonitor>,
    turnId: string,
  ): Promise<void> {
    const operation = record.interruptOperation;
    if (operation?.turnId !== turnId) return;
    await operation.promise.catch(() => undefined);
  }

  private stageOrFinalizeTurn(record: ChildRecord<TMonitor>, turnId: string, status: AgentStatus): void {
    if (record.readyTurnId === turnId) {
      this.finalizeTurn(record, turnId, status);
      return;
    }
    this.slots.release(turnId);
    record.status = status;
    record.settledAt = this.now();
    record.pendingTerminal = { turnId, status };
    record.lastActivity = typeof status === "object" && "errored" in status ? "errored" : status === "interrupted" ? "interrupted" : "completed";
    this.changed(record);
  }

  private isSettlementRace(error: unknown, worker: RpcChildWorker): boolean {
    return error instanceof RpcDeliveryRacedSettlementError ||
      error instanceof RpcAdmissionClosedError ||
      worker.isSettled || worker.isClosed;
  }

  private matches(record: ChildRecord<TMonitor>, token: WorkerToken): boolean {
    return record.id === token.childId &&
      record.activeTurnId === token.activeTurnId &&
      record.workerGeneration === token.workerGeneration;
  }

  private addRecord(record: ChildRecord<TMonitor>): void {
    this.byId.set(record.id, record);
    this.byName.set(record.taskName, record);
    this.byPath.set(record.canonicalPath, record);
  }

  private removeRecord(record: ChildRecord<TMonitor>): void {
    if (this.byId.get(record.id) === record) this.byId.delete(record.id);
    if (this.byName.get(record.taskName) === record) this.byName.delete(record.taskName);
    if (this.byPath.get(record.canonicalPath) === record) this.byPath.delete(record.canonicalPath);
  }

  private async rollbackSpawn(record: ChildRecord<TMonitor>): Promise<void> {
    const turnId = record.activeTurnId;
    const becameUsable = turnId !== undefined && record.readyTurnId === turnId;
    if (turnId) this.slots.release(turnId);
    const worker = record.worker;
    // Remove all lookup routes before shutdown so expected exit callbacks from
    // this failed pre-start attempt are stale by construction.
    this.removeRecord(record);
    record.activeTurnId = undefined;
    record.worker = undefined;
    if (worker && !worker.isClosed) await worker.shutdown().catch(() => undefined);
    if (record.sessionFile && !becameUsable && !record.preserveSessionOnRollback) {
      await this.deps.removeFailedSession(record.sessionFile).catch(() => undefined);
    }
  }

  private retainInterruptedStart(record: ChildRecord<TMonitor>, turnId: string): boolean {
    if (
      this.disposed ||
      this.byId.get(record.id) !== record ||
      record.activeTurnId !== turnId ||
      record.interruptTurnId !== turnId ||
      record.sessionFile.length === 0
    ) return false;
    const pendingInterrupted = record.pendingTerminal?.turnId === turnId &&
      record.pendingTerminal.status === "interrupted";
    if (record.status !== "interrupted" && !pendingInterrupted) return false;
    record.pendingTerminal = undefined;
    this.finalizeTurn(record, turnId, "interrupted");
    return true;
  }

  private resolveTarget(target: string): ChildRecord<TMonitor> {
    this.assertOpen();
    if (target === "/root" || target === "root") throw new Error("Target error: /root cannot target itself");
    const matches = new Set<ChildRecord<TMonitor>>();
    const byId = this.byId.get(target);
    const byName = this.byName.get(target);
    const byPath = this.byPath.get(target);
    if (byId) matches.add(byId);
    if (byName) matches.add(byName);
    if (byPath) matches.add(byPath);
    if (matches.size === 0) throw new Error(`Target error: unknown agent ${JSON.stringify(target)}`);
    if (matches.size > 1) throw new Error(`Target error: ambiguous agent target ${JSON.stringify(target)}`);
    return [...matches][0]!;
  }

  private assertTargetLive(record: ChildRecord<TMonitor>): void {
    this.assertRecordCurrent(record);
    if (record.status === "shutdown" || record.status === "not_found") {
      throw new Error(`Target error: ${record.canonicalPath} is unavailable`);
    }
  }

  private assertRecordCurrent(record: ChildRecord<TMonitor>): void {
    this.assertOpen();
    if (this.byId.get(record.id) !== record) throw new Error("Lifecycle error: child registry entry is stale");
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Lifecycle error: collaboration registry is shut down");
  }

  private changed(record: ChildRecord<TMonitor>): void {
    this.deps.onChanged?.(record);
    for (const listener of this.listeners) listener(record);
  }
}
