import type { AgentStatus, WaitAgentResult } from "./contracts.ts";
import { writeFinalAnswerArtifact } from "./session-paths.ts";

export const COLLABORATION_MAILBOX_TYPE = "collaboration-mailbox";
/** Maximum UTF-8 size of the complete model-facing mailbox envelope. */
export const DEFAULT_MAILBOX_MAX_BYTES = 64 * 1024;
/** Error diagnostics do not get full-answer artifacts, so use a tighter bound. */
export const DEFAULT_ERROR_DIAGNOSTIC_MAX_BYTES = 16 * 1024;

export interface MailboxMessageDetails {
  readonly sender: string;
  readonly taskName: "/root";
  readonly status: AgentStatus;
  readonly truncated: boolean;
  readonly fullBytes: number;
  readonly fullAnswerFile?: string;
}

export interface MailboxCustomMessage {
  readonly customType: typeof COLLABORATION_MAILBOX_TYPE;
  readonly content: string;
  readonly display: true;
  readonly details: MailboxMessageDetails;
}

export interface MailboxSendOptions {
  readonly triggerTurn: false;
  readonly deliverAs: "steer" | "nextTurn";
}

/** Pi-facing behavior is deliberately injectable for unit tests and session replacement. */
export interface MailboxDeliveryAdapter {
  sendMessage(message: MailboxCustomMessage, options: MailboxSendOptions): void | Promise<void>;
  isIdle(): boolean;
}

export type FinalAnswerArtifactWriter = (sessionFile: string, answer: string) => Promise<string>;

export interface RootMailboxOptions {
  readonly delivery: MailboxDeliveryAdapter;
  readonly artifactWriter?: FinalAnswerArtifactWriter;
  readonly maxMailboxBytes?: number;
  readonly maxErrorBytes?: number;
  readonly now?: () => number;
}

export interface FinalMailboxInput {
  /** Canonical child path, for example /root/tests. */
  readonly sender: string;
  readonly sessionFile: string;
  readonly status: AgentStatus;
  /** Optional active-turn token used to suppress duplicate/racing finalization. */
  readonly dedupeKey?: string;
}

export interface FinalMailboxDelivery {
  readonly message: MailboxCustomMessage;
  readonly options: MailboxSendOptions;
  readonly status: AgentStatus;
  readonly wakeSequence: number;
}

export type WakeKind = "final" | "human_input";

export interface WakeEvent {
  readonly sequence: number;
  readonly timestamp: number;
  readonly kind: WakeKind;
  readonly message: string;
}

interface PendingWaiter {
  readonly resolve: (result: WaitAgentResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  active: boolean;
}

export class MailboxWaitAbortedError extends Error {
  override readonly name = "AbortError";

  constructor() {
    super("collaboration_wait_agent was aborted");
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Return a leading substring without splitting a UTF-8 code point. */
export function utf8Prefix(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

export function formatMailboxEnvelope(sender: string, payload: string): string {
  return `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${sender}\nPayload:\n${payload}`;
}

function completedStatus(status: AgentStatus): status is { completed: string | null } {
  return typeof status === "object" && status !== null && "completed" in status;
}

function erroredStatus(status: AgentStatus): status is { errored: string } {
  return typeof status === "object" && status !== null && "errored" in status;
}

function statusPayload(status: AgentStatus): string {
  if (completedStatus(status)) return status.completed ?? "Child completed without a final answer.";
  if (erroredStatus(status)) return `Child error: ${status.errored}`;
  if (status === "interrupted") return "Child turn was interrupted.";
  return `Child status: ${status}`;
}

function assertMailboxLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 512) {
    throw new Error("Mailbox max bytes must be a safe integer of at least 512");
  }
}

function truncateEnvelopePayload(
  sender: string,
  original: string,
  suffix: string,
  maxEnvelopeBytes: number,
): string {
  const empty = formatMailboxEnvelope(sender, suffix);
  const available = maxEnvelopeBytes - utf8ByteLength(empty);
  if (available < 0) {
    throw new Error(`Mailbox metadata exceeds the ${maxEnvelopeBytes}-byte limit`);
  }
  return `${utf8Prefix(original, available)}${suffix}`;
}

export interface BoundedMailboxPayload {
  readonly status: AgentStatus;
  readonly payload: string;
  readonly truncated: boolean;
  readonly fullBytes: number;
  readonly fullAnswerFile?: string;
}

/**
 * Bound a final status by the complete envelope size. Oversized successful
 * answers are atomically persisted through the injected artifact writer.
 */
export async function boundMailboxPayload(
  input: Pick<FinalMailboxInput, "sender" | "sessionFile" | "status">,
  options: {
    readonly artifactWriter?: FinalAnswerArtifactWriter;
    readonly maxMailboxBytes?: number;
    readonly maxErrorBytes?: number;
  } = {},
): Promise<BoundedMailboxPayload> {
  const maxMailboxBytes = options.maxMailboxBytes ?? DEFAULT_MAILBOX_MAX_BYTES;
  const maxErrorBytes = options.maxErrorBytes ?? DEFAULT_ERROR_DIAGNOSTIC_MAX_BYTES;
  assertMailboxLimit(maxMailboxBytes);
  assertMailboxLimit(maxErrorBytes);
  const originalPayload = statusPayload(input.status);
  const fullBytes = utf8ByteLength(originalPayload);
  const initialEnvelope = formatMailboxEnvelope(input.sender, originalPayload);

  if (utf8ByteLength(initialEnvelope) <= maxMailboxBytes && (!erroredStatus(input.status) || fullBytes <= maxErrorBytes)) {
    return {
      status: input.status,
      payload: originalPayload,
      truncated: false,
      fullBytes,
    };
  }

  if (completedStatus(input.status) && input.status.completed !== null) {
    const artifactWriter = options.artifactWriter ?? writeFinalAnswerArtifact;
    const fullAnswerFile = await artifactWriter(input.sessionFile, input.status.completed);
    const suffix = `\n\n[Answer truncated. Full sanitized answer (${fullBytes} UTF-8 bytes): ${fullAnswerFile}]`;
    const payload = truncateEnvelopePayload(input.sender, originalPayload, suffix, maxMailboxBytes);
    return {
      status: { completed: payload },
      payload,
      truncated: true,
      fullBytes,
      fullAnswerFile,
    };
  }

  const effectiveLimit = Math.min(maxMailboxBytes, maxErrorBytes + utf8ByteLength(formatMailboxEnvelope(input.sender, "")));
  const suffix = `\n\n[Diagnostic truncated from ${fullBytes} UTF-8 bytes.]`;
  const payload = truncateEnvelopePayload(input.sender, originalPayload, suffix, effectiveLimit);
  const status: AgentStatus = erroredStatus(input.status)
    ? { errored: payload.startsWith("Child error: ") ? payload.slice("Child error: ".length) : payload }
    : input.status;
  return { status, payload, truncated: true, fullBytes };
}

/**
 * Root-only custom-message delivery plus the globally-consumable wake queue.
 * Each wake goes to exactly one oldest waiter, or remains queued for one future
 * waiter; final message delivery itself is independent of wake consumption.
 */
export class RootMailbox {
  private readonly delivery: MailboxDeliveryAdapter;
  private readonly artifactWriter: FinalAnswerArtifactWriter;
  private readonly maxMailboxBytes: number;
  private readonly maxErrorBytes: number;
  private readonly now: () => number;
  private readonly wakeQueue: WakeEvent[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private readonly deliveries = new Map<string, Promise<FinalMailboxDelivery>>();
  private nextWakeSequence = 1;
  private disposed = false;

  constructor(options: RootMailboxOptions) {
    this.delivery = options.delivery;
    this.artifactWriter = options.artifactWriter ?? writeFinalAnswerArtifact;
    this.maxMailboxBytes = options.maxMailboxBytes ?? DEFAULT_MAILBOX_MAX_BYTES;
    this.maxErrorBytes = options.maxErrorBytes ?? DEFAULT_ERROR_DIAGNOSTIC_MAX_BYTES;
    this.now = options.now ?? Date.now;
    assertMailboxLimit(this.maxMailboxBytes);
    assertMailboxLimit(this.maxErrorBytes);
  }

  get pendingWakeCount(): number {
    return this.wakeQueue.length;
  }

  get pendingWaiterCount(): number {
    return this.waiters.filter((waiter) => waiter.active).length;
  }

  get latestWakeSequence(): number {
    return this.nextWakeSequence - 1;
  }

  deliverFinal(input: FinalMailboxInput): Promise<FinalMailboxDelivery> {
    if (this.disposed) return Promise.reject(new Error("Root mailbox is shut down"));
    if (input.dedupeKey !== undefined) {
      const existing = this.deliveries.get(input.dedupeKey);
      if (existing !== undefined) return existing;
    }

    const delivery = this.performDelivery(input);
    if (input.dedupeKey !== undefined) {
      this.deliveries.set(input.dedupeKey, delivery);
      const release = () => {
        if (this.deliveries.get(input.dedupeKey!) === delivery) {
          this.deliveries.delete(input.dedupeKey!);
        }
      };
      // Registry finalization is itself token-idempotent. The mailbox only
      // needs to coalesce overlapping delivery attempts, so do not retain a
      // full bounded message/promise for every historical child turn.
      void delivery.then(release, release);
    }
    return delivery;
  }

  enqueueWake(kind: WakeKind, message: string): WakeEvent {
    if (this.disposed) throw new Error("Root mailbox is shut down");
    const event: WakeEvent = Object.freeze({
      sequence: this.nextWakeSequence++,
      timestamp: this.now(),
      kind,
      message,
    });
    const waiter = this.takeNextWaiter();
    if (waiter === undefined) {
      this.wakeQueue.push(event);
    } else {
      this.finishWaiter(waiter, { message: event.message, timed_out: false });
    }
    return event;
  }

  /** Only real operator input should call this; extension-generated input is ignored. */
  notifyHumanInput(source: "interactive" | "rpc" | "extension"): WakeEvent | undefined {
    if (source === "extension") return undefined;
    return this.enqueueWake("human_input", `Human user input received from ${source}.`);
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<WaitAgentResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new Error("Wait timeout must be a non-negative safe integer"));
    }
    if (signal?.aborted) return Promise.reject(new MailboxWaitAbortedError());
    const queued = this.wakeQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ message: queued.message, timed_out: false });
    }
    if (this.disposed) {
      return Promise.resolve({ message: "Collaboration session shut down.", timed_out: false });
    }

    return new Promise<WaitAgentResult>((resolve, reject) => {
      const waiter: PendingWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        active: true,
      };
      waiter.timer = setTimeout(() => {
        if (!this.removeWaiter(waiter)) return;
        this.finishWaiter(waiter, { message: `No collaboration events within ${timeoutMs}ms.`, timed_out: true });
      }, timeoutMs);
      if (signal !== undefined) {
        waiter.abortListener = () => {
          if (!this.removeWaiter(waiter)) return;
          this.failWaiter(waiter, new MailboxWaitAbortedError());
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wakeQueue.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      if (!waiter.active) continue;
      this.finishWaiter(waiter, { message: "Collaboration session shut down.", timed_out: false });
    }
  }

  private async performDelivery(input: FinalMailboxInput): Promise<FinalMailboxDelivery> {
    const bounded = await boundMailboxPayload(input, {
      artifactWriter: this.artifactWriter,
      maxMailboxBytes: this.maxMailboxBytes,
      maxErrorBytes: this.maxErrorBytes,
    });
    if (this.disposed) throw new Error("Root mailbox is shut down");
    const details: MailboxMessageDetails = {
      sender: input.sender,
      taskName: "/root",
      status: bounded.status,
      truncated: bounded.truncated,
      fullBytes: bounded.fullBytes,
      ...(bounded.fullAnswerFile === undefined ? {} : { fullAnswerFile: bounded.fullAnswerFile }),
    };
    const message: MailboxCustomMessage = {
      customType: COLLABORATION_MAILBOX_TYPE,
      content: formatMailboxEnvelope(input.sender, bounded.payload),
      display: true,
      details,
    };
    const options: MailboxSendOptions = {
      triggerTurn: false,
      deliverAs: this.delivery.isIdle() ? "nextTurn" : "steer",
    };
    await this.delivery.sendMessage(message, options);
    if (this.disposed) throw new Error("Root mailbox was shut down during delivery");
    const wake = this.enqueueWake("final", `Agent ${input.sender} finished: ${shortStatus(bounded.status)}`);
    return { message, options, status: bounded.status, wakeSequence: wake.sequence };
  }

  private takeNextWaiter(): PendingWaiter | undefined {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter?.active) return waiter;
    }
    return undefined;
  }

  private removeWaiter(waiter: PendingWaiter): boolean {
    if (!waiter.active) return false;
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    return true;
  }

  private cleanupWaiter(waiter: PendingWaiter): void {
    if (!waiter.active) return;
    waiter.active = false;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }

  private finishWaiter(waiter: PendingWaiter, result: WaitAgentResult): void {
    this.cleanupWaiter(waiter);
    waiter.resolve(result);
  }

  private failWaiter(waiter: PendingWaiter, error: unknown): void {
    this.cleanupWaiter(waiter);
    waiter.reject(error);
  }
}

function shortStatus(status: AgentStatus): string {
  if (completedStatus(status)) return "completed";
  if (erroredStatus(status)) return "errored";
  return status;
}
