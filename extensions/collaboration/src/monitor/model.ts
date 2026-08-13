import type { AgentStatus } from "../contracts.ts";

export const DEFAULT_MONITOR_MAX_EVENTS = 2_000;
export const DEFAULT_MONITOR_MAX_BYTES = 1024 * 1024;

type JsonScalar = string | number | boolean | null;
type ObservableJson = JsonScalar | ObservableJson[] | { [key: string]: ObservableJson };

export interface SanitizedTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface SanitizedToolCallBlock {
  readonly type: "toolCall";
  readonly id?: string;
  readonly name: string;
  readonly arguments: ObservableJson;
}

export interface SanitizedUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
  readonly cost?: Readonly<{
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  }>;
}

/**
 * The only assistant-message data collaboration is allowed to retain.
 *
 * In particular, provider identifiers, response IDs, deferred handles,
 * diagnostics, raw payloads, all thinking/reasoning blocks, and every provider
 * signature are omitted rather than copied and removed later.
 */
export interface SanitizedAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly (SanitizedTextBlock | SanitizedToolCallBlock)[];
  readonly stopReason?: string;
  readonly rawStopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: SanitizedUsage;
  readonly timestamp?: number;
}

interface MonitorEventBase {
  readonly sequence: number;
  readonly timestamp: number;
}

export type NormalizedMonitorEvent =
  | (MonitorEventBase & {
      readonly kind: "assistant_text";
      readonly text: string;
    })
  | (MonitorEventBase & {
      readonly kind: "assistant_message";
      readonly phase: "start" | "update" | "end";
      readonly message: SanitizedAssistantMessage;
    })
  | (MonitorEventBase & {
      readonly kind: "tool";
      readonly phase: "start" | "update" | "end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments?: ObservableJson;
      /** Updates are cumulative snapshots, matching Pi's RPC protocol. */
      readonly output?: ObservableJson;
      readonly isError?: boolean;
    })
  | (MonitorEventBase & {
      readonly kind: "error";
      readonly message: string;
    })
  | (MonitorEventBase & {
      readonly kind: "usage";
      readonly usage: SanitizedUsage;
    })
  | (MonitorEventBase & {
      readonly kind: "activity";
      readonly activity: string;
    })
  | (MonitorEventBase & {
      readonly kind: "final";
      readonly status: AgentStatus;
      readonly summary?: string;
      readonly fullAnswerFile?: string;
    })
  | (MonitorEventBase & {
      readonly kind: "notice";
      readonly originalKind: NormalizedMonitorEvent["kind"];
      readonly message: string;
      readonly terminal: boolean;
    });

type WithoutMonitorMetadata<T> = T extends MonitorEventBase
  ? Omit<T, "sequence" | "timestamp"> & { timestamp?: number }
  : never;

export type MonitorEventInput = WithoutMonitorMetadata<NormalizedMonitorEvent>;

export interface MonitorCursorPage {
  /** Events strictly newer than the supplied cursor, in sequence order. */
  readonly events: readonly NormalizedMonitorEvent[];
  /** Cursor callers should use for their next request, even after eviction. */
  readonly nextCursor: number;
  /** Highest sequence that has been evicted or omitted before this page. */
  readonly droppedThrough: number;
}

export interface BoundedMonitorBufferOptions {
  maxEvents?: number;
  maxBytes?: number;
  now?: () => number;
}

export type MonitorListener = (
  event: NormalizedMonitorEvent,
  buffer: BoundedMonitorBuffer,
) => void;

interface StoredMonitorEvent {
  readonly event: NormalizedMonitorEvent;
  readonly bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cloneObservableJson(value: unknown, seen = new WeakSet<object>()): ObservableJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((child) => cloneObservableJson(child, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, ObservableJson> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = cloneObservableJson(child, seen);
  }
  seen.delete(value);
  return result;
}

function sanitizeUsage(value: unknown): SanitizedUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  } = {};

  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite1h",
    "reasoning",
    "totalTokens",
  ] as const) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) usage[key] = number;
  }

  if (isRecord(value.cost)) {
    const cost: NonNullable<typeof usage.cost> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      const number = finiteNumber(value.cost[key]);
      if (number !== undefined) cost[key] = number;
    }
    if (Object.keys(cost).length > 0) usage.cost = cost;
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isHiddenAssistantBlock(block: Record<string, unknown>): boolean {
  if (typeof block.type !== "string") return true;
  const type = block.type.toLowerCase();
  return type.includes("thinking") || type.includes("reasoning");
}

/** Deep-clone an assistant message into an explicit visible-data allowlist. */
export function sanitizeAssistantMessage(value: unknown): SanitizedAssistantMessage {
  const source = isRecord(value) ? value : {};
  const content: Array<SanitizedTextBlock | SanitizedToolCallBlock> = [];
  const sourceContent = Array.isArray(source.content)
    ? source.content
    : typeof source.content === "string"
      ? [{ type: "text", text: source.content }]
      : [];

  for (const candidate of sourceContent) {
    if (!isRecord(candidate) || isHiddenAssistantBlock(candidate)) continue;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      // Constructing a fresh two-field object deliberately drops textSignature
      // and any provider-specific metadata beside the visible text.
      content.push({ type: "text", text: candidate.text });
      continue;
    }
    if (candidate.type === "toolCall" && typeof candidate.name === "string") {
      const id = typeof candidate.id === "string" ? candidate.id : undefined;
      content.push({
        type: "toolCall",
        ...(id === undefined ? {} : { id }),
        name: candidate.name,
        arguments: cloneObservableJson(candidate.arguments ?? {}),
      });
    }
  }

  const stopReason = typeof source.stopReason === "string" ? source.stopReason : undefined;
  const rawStopReason = typeof source.rawStopReason === "string" ? source.rawStopReason : undefined;
  const errorMessage = typeof source.errorMessage === "string" ? source.errorMessage : undefined;
  const usage = sanitizeUsage(source.usage);
  const timestamp = finiteNumber(source.timestamp);

  return {
    role: "assistant",
    content,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(rawStopReason === undefined ? {} : { rawStopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(usage === undefined ? {} : { usage }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/** Extract exact visible text without retaining the source message. */
export function extractVisibleAssistantText(value: unknown): string {
  return sanitizeAssistantMessage(value).content
    .filter((block): block is SanitizedTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function sanitizeAgentStatus(status: AgentStatus): AgentStatus {
  if (typeof status === "string") return status;
  if ("completed" in status) {
    return { completed: typeof status.completed === "string" ? status.completed : null };
  }
  return { errored: String(status.errored) };
}

function sanitizeMonitorEventInput(input: MonitorEventInput): MonitorEventInput {
  const timestamp = finiteNumber(input.timestamp);
  switch (input.kind) {
    case "assistant_text":
      return { kind: input.kind, text: String(input.text), ...(timestamp === undefined ? {} : { timestamp }) };
    case "assistant_message":
      return {
        kind: input.kind,
        phase: input.phase,
        message: sanitizeAssistantMessage(input.message),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
    case "tool":
      return {
        kind: input.kind,
        phase: input.phase,
        toolCallId: String(input.toolCallId),
        toolName: String(input.toolName),
        ...(input.arguments === undefined ? {} : { arguments: cloneObservableJson(input.arguments) }),
        ...(input.output === undefined ? {} : { output: cloneObservableJson(input.output) }),
        ...(input.isError === undefined ? {} : { isError: Boolean(input.isError) }),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
    case "error":
      return { kind: input.kind, message: String(input.message), ...(timestamp === undefined ? {} : { timestamp }) };
    case "usage": {
      const usage = sanitizeUsage(input.usage) ?? {};
      return { kind: input.kind, usage, ...(timestamp === undefined ? {} : { timestamp }) };
    }
    case "activity":
      return {
        kind: input.kind,
        activity: String(input.activity),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
    case "final":
      return {
        kind: input.kind,
        status: sanitizeAgentStatus(input.status),
        ...(input.summary === undefined ? {} : { summary: String(input.summary) }),
        ...(input.fullAnswerFile === undefined ? {} : { fullAnswerFile: String(input.fullAnswerFile) }),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
    case "notice":
      return {
        kind: input.kind,
        originalKind: input.originalKind,
        message: String(input.message),
        terminal: Boolean(input.terminal),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
  }
}

function assistantEventMessage(event: Record<string, unknown>): unknown {
  if (event.type === "error") return event.error;
  return event.message;
}

function stringField(value: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof value[key] === "string" ? value[key] : fallback;
}

/**
 * Convert one already-parsed RPC event into zero or more observable events.
 * Thinking deltas are rejected before any source object is retained.
 */
export function normalizeRpcMonitorEvent(value: unknown): readonly MonitorEventInput[] {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  if (
    value.type === "thinking_start" ||
    value.type === "thinking_delta" ||
    value.type === "thinking_end"
  ) {
    return [];
  }

  switch (value.type) {
    case "agent_start":
      return [{ kind: "activity", activity: "agent started" }];
    case "agent_settled":
      return [{ kind: "activity", activity: "agent settled" }];
    case "message_start":
    case "message_end": {
      if (!isRecord(value.message) || value.message.role !== "assistant") return [];
      const message = sanitizeAssistantMessage(value.message);
      const normalized: MonitorEventInput[] = [
        {
          kind: "assistant_message",
          phase: value.type === "message_start" ? "start" : "end",
          message,
        },
      ];
      if (value.type === "message_end" && message.usage !== undefined) {
        normalized.push({ kind: "usage", usage: message.usage });
      }
      if (value.type === "message_end" && message.errorMessage !== undefined) {
        normalized.push({ kind: "error", message: message.errorMessage });
      }
      return normalized;
    }
    case "message_update": {
      const assistantEvent = value.assistantMessageEvent;
      if (!isRecord(assistantEvent) || typeof assistantEvent.type !== "string") return [];
      if (
        assistantEvent.type === "thinking_start" ||
        assistantEvent.type === "thinking_delta" ||
        assistantEvent.type === "thinking_end"
      ) {
        return [];
      }
      if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
        return [{ kind: "assistant_text", text: assistantEvent.delta }];
      }
      if (assistantEvent.type === "done" || assistantEvent.type === "error") {
        return [
          {
            kind: "assistant_message",
            phase: "update",
            message: sanitizeAssistantMessage(assistantEventMessage(assistantEvent)),
          },
        ];
      }
      if (assistantEvent.type === "toolcall_end" && isRecord(assistantEvent.toolCall)) {
        const toolCall = sanitizeAssistantMessage({
          role: "assistant",
          content: [assistantEvent.toolCall],
        }).content[0];
        if (toolCall?.type !== "toolCall") return [];
        return [
          {
            kind: "tool",
            phase: "start",
            toolCallId: toolCall.id ?? "",
            toolName: toolCall.name,
            arguments: toolCall.arguments,
          },
        ];
      }
      return [];
    }
    case "tool_execution_start":
      return [
        {
          kind: "tool",
          phase: "start",
          toolCallId: stringField(value, "toolCallId"),
          toolName: stringField(value, "toolName", "tool"),
          arguments: cloneObservableJson(value.args ?? {}),
        },
      ];
    case "tool_execution_update":
      return [
        {
          kind: "tool",
          phase: "update",
          toolCallId: stringField(value, "toolCallId"),
          toolName: stringField(value, "toolName", "tool"),
          arguments: cloneObservableJson(value.args ?? {}),
          output: cloneObservableJson(value.partialResult ?? null),
        },
      ];
    case "tool_execution_end":
      return [
        {
          kind: "tool",
          phase: "end",
          toolCallId: stringField(value, "toolCallId"),
          toolName: stringField(value, "toolName", "tool"),
          output: cloneObservableJson(value.result ?? null),
          isError: value.isError === true,
        },
      ];
    case "bash_execution_update":
      return typeof value.delta === "string"
        ? [
            {
              kind: "tool",
              phase: "update",
              toolCallId: stringField(value, "id", "bash"),
              toolName: "bash",
              output: value.delta,
            },
          ]
        : [];
    case "auto_retry_start":
      return [
        {
          kind: "activity",
          activity: `retry ${String(value.attempt ?? "?")}/${String(value.maxAttempts ?? "?")}`,
        },
      ];
    case "compaction_start":
      return [{ kind: "activity", activity: `compacting (${stringField(value, "reason", "unknown")})` }];
    case "compaction_end":
      return value.errorMessage === undefined
        ? [{ kind: "activity", activity: "compaction finished" }]
        : [{ kind: "error", message: String(value.errorMessage) }];
    default:
      return [];
  }
}

function eventByteLength(event: NormalizedMonitorEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export class BoundedMonitorBuffer {
  readonly maxEvents: number;
  readonly maxBytes: number;

  private readonly now: () => number;
  private readonly stored: StoredMonitorEvent[] = [];
  private readonly listeners = new Set<MonitorListener>();
  private nextSequence = 1;
  private totalBytes = 0;
  private droppedThrough = 0;
  private pinnedTerminalSequence: number | undefined;
  private currentActivityValue: string | undefined;

  constructor(options: BoundedMonitorBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MONITOR_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MONITOR_MAX_BYTES;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("Monitor maxEvents must be a positive integer");
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error("Monitor maxBytes must be a positive integer");
    }
  }

  get length(): number {
    return this.stored.length;
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  get latestSequence(): number {
    return this.nextSequence - 1;
  }

  get currentActivity(): string | undefined {
    return this.currentActivityValue;
  }

  /** Unpin a previous turn's terminal marker before a follow-up starts. */
  beginTurn(): void {
    this.pinnedTerminalSequence = undefined;
  }

  append(input: MonitorEventInput): NormalizedMonitorEvent | undefined {
    const sanitized = sanitizeMonitorEventInput(input);
    const sequence = this.nextSequence++;
    const timestamp = sanitized.timestamp ?? this.now();
    const { timestamp: _inputTimestamp, ...payload } = sanitized;
    let event = deepFreeze({ sequence, timestamp, ...payload } as NormalizedMonitorEvent);
    let bytes = eventByteLength(event);

    if (bytes > this.maxBytes) {
      const terminal = input.kind === "final" || (input.kind === "notice" && input.terminal);
      const base = {
        sequence,
        timestamp,
        kind: "notice" as const,
        originalKind: input.kind,
        terminal,
      };
      const sourceBytes = bytes;
      const prefix = `${input.kind} event omitted (${sourceBytes} UTF-8 bytes): `;
      const sourceSummary = input.kind === "final"
        ? input.summary ?? JSON.stringify(input.status)
        : input.kind === "error"
          ? input.message
          : input.kind === "assistant_text"
            ? input.text
            : "payload exceeded the monitor byte limit";
      let message = `${prefix}${sourceSummary}`;
      let notice = { ...base, message };
      bytes = eventByteLength(notice);
      if (bytes > this.maxBytes) {
        const overhead = eventByteLength({ ...base, message: prefix });
        message = `${prefix}${utf8Prefix(sourceSummary, Math.max(0, this.maxBytes - overhead))}`;
        notice = { ...base, message };
        bytes = eventByteLength(notice);
      }
      if (bytes > this.maxBytes) {
        this.droppedThrough = sequence;
        return undefined;
      }
      event = deepFreeze(notice);
    }

    this.stored.push({ event, bytes });
    this.totalBytes += bytes;
    if (event.kind === "final" || (event.kind === "notice" && event.terminal)) {
      this.pinnedTerminalSequence = event.sequence;
    }
    this.updateActivity(event);
    this.evictToLimits();
    for (const listener of [...this.listeners]) {
      try {
        listener(event, this);
      } catch {
        // A TUI observer must not break RPC ingestion or child lifecycle state.
      }
    }
    return event;
  }

  /** Sanitize, normalize, clone, and append one parsed RPC event. */
  ingest(value: unknown): readonly NormalizedMonitorEvent[] {
    if (isRecord(value) && value.type === "agent_start") this.beginTurn();
    const appended: NormalizedMonitorEvent[] = [];
    for (const input of normalizeRpcMonitorEvent(value)) {
      const event = this.append(input);
      if (event !== undefined) appended.push(event);
    }
    return appended;
  }

  getSince(cursor = 0): MonitorCursorPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("Monitor cursor must be a non-negative safe integer");
    }
    return {
      events: this.stored.filter(({ event }) => event.sequence > cursor).map(({ event }) => event),
      nextCursor: this.latestSequence,
      droppedThrough: this.droppedThrough,
    };
  }

  subscribe(listener: MonitorListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.stored.length = 0;
    this.totalBytes = 0;
    this.pinnedTerminalSequence = undefined;
    this.currentActivityValue = undefined;
  }

  private updateActivity(event: NormalizedMonitorEvent): void {
    switch (event.kind) {
      case "activity":
        this.currentActivityValue = event.activity;
        break;
      case "assistant_text":
      case "assistant_message":
        this.currentActivityValue = "responding";
        break;
      case "tool":
        this.currentActivityValue = `${event.phase === "end" ? "finished" : "running"} ${event.toolName}`;
        break;
      case "error":
        this.currentActivityValue = `error: ${event.message}`;
        break;
      case "final":
        this.currentActivityValue = event.summary ?? "finished";
        break;
      case "notice":
        if (event.terminal) this.currentActivityValue = "finished";
        break;
      case "usage":
        break;
    }
  }

  private evictToLimits(): void {
    while (this.stored.length > this.maxEvents || this.totalBytes > this.maxBytes) {
      let index = this.stored.findIndex(
        ({ event }) => event.sequence !== this.pinnedTerminalSequence,
      );
      if (index === -1) index = 0;
      const [removed] = this.stored.splice(index, 1);
      if (removed === undefined) break;
      this.totalBytes -= removed.bytes;
      this.droppedThrough = Math.max(this.droppedThrough, removed.event.sequence);
      if (removed.event.sequence === this.pinnedTerminalSequence) {
        this.pinnedTerminalSequence = undefined;
      }
    }
  }
}
