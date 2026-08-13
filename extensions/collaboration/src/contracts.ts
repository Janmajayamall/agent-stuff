import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const COLLABORATION_TOOL_NAMES = [
  "collaboration_spawn_agent",
  "collaboration_send_message",
  "collaboration_followup_task",
  "collaboration_interrupt_agent",
  "collaboration_list_agents",
  "collaboration_wait_agent",
] as const;

export type CollaborationToolName = (typeof COLLABORATION_TOOL_NAMES)[number];

export const SUPPORTED_CHILD_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra"] as const;
export const SUPPORTED_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type SupportedChildModel = (typeof SUPPORTED_CHILD_MODELS)[number];
export type SupportedReasoningEffort = (typeof SUPPORTED_REASONING_EFFORTS)[number];

const SupportedChildModelSchema = Type.Union([
  Type.Literal("gpt-5.6-sol"),
  Type.Literal("gpt-5.6-terra"),
]);

const SupportedReasoningEffortSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const NonBlankStringSchema = Type.String({
  minLength: 1,
  pattern: "\\S",
});

export const SpawnAgentInputSchema = Type.Object(
  {
    task_name: Type.String({ minLength: 1, pattern: "^[a-z0-9_]+$" }),
    message: NonBlankStringSchema,
    model: Type.Optional(SupportedChildModelSchema),
    reasoning_effort: Type.Optional(SupportedReasoningEffortSchema),
  },
  { additionalProperties: false },
);

export const SendMessageInputSchema = Type.Object(
  {
    target: NonBlankStringSchema,
    message: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const FollowupTaskInputSchema = Type.Object(
  {
    target: NonBlankStringSchema,
    message: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const InterruptAgentInputSchema = Type.Object(
  {
    target: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const ListAgentsInputSchema = Type.Object(
  {
    path_prefix: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: "^(?!.*\\/$).+$",
      }),
    ),
  },
  { additionalProperties: false },
);

export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export const WaitAgentInputSchema = Type.Object(
  {
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: MIN_WAIT_TIMEOUT_MS,
        maximum: MAX_WAIT_TIMEOUT_MS,
        default: DEFAULT_WAIT_TIMEOUT_MS,
      }),
    ),
  },
  { additionalProperties: false },
);

export type SpawnAgentInput = Static<typeof SpawnAgentInputSchema>;
export type SendMessageInput = Static<typeof SendMessageInputSchema>;
export type FollowupTaskInput = Static<typeof FollowupTaskInputSchema>;
export type InterruptAgentInput = Static<typeof InterruptAgentInputSchema>;
export type ListAgentsInput = Static<typeof ListAgentsInputSchema>;
export type WaitAgentInput = Static<typeof WaitAgentInputSchema>;

type RawPrimitiveKind = "number" | "string";

export class CollaborationSchemaError extends Error {
  override readonly name = "CollaborationSchemaError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function createRawArgumentsPreparer<T extends object>(
  toolName: CollaborationToolName,
  properties: Readonly<Record<string, RawPrimitiveKind>>,
): (raw: unknown) => T {
  const allowedKeys = new Set(Object.keys(properties));

  return (raw: unknown): T => {
    if (!isPlainObject(raw)) {
      throw new CollaborationSchemaError(
        `Schema error for ${toolName}: arguments must be a plain, non-array object`,
      );
    }

    if (Object.getOwnPropertySymbols(raw).length > 0) {
      throw new CollaborationSchemaError(
        `Schema error for ${toolName}: arguments contain unsupported symbol properties`,
      );
    }

    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new CollaborationSchemaError(
          `Schema error for ${toolName}: unknown property ${JSON.stringify(key)}`,
        );
      }

      const expectedType = properties[key]!;
      const actualType = typeof raw[key];
      if (actualType !== expectedType) {
        throw new CollaborationSchemaError(
          `Schema error for ${toolName}: property ${JSON.stringify(key)} must be a JSON ${expectedType}, received ${actualType}`,
        );
      }
    }

    // Pi subsequently clones this value, runs Value.Convert(), and validates it
    // against the TypeBox schema. Returning the original object here is
    // intentional: this hook only protects the original JSON primitive types.
    return raw as T;
  };
}

export const prepareSpawnAgentArguments = createRawArgumentsPreparer<SpawnAgentInput>(
  "collaboration_spawn_agent",
  {
    task_name: "string",
    message: "string",
    model: "string",
    reasoning_effort: "string",
  },
);

export const prepareSendMessageArguments = createRawArgumentsPreparer<SendMessageInput>(
  "collaboration_send_message",
  {
    target: "string",
    message: "string",
  },
);

export const prepareFollowupTaskArguments = createRawArgumentsPreparer<FollowupTaskInput>(
  "collaboration_followup_task",
  {
    target: "string",
    message: "string",
  },
);

export const prepareInterruptAgentArguments = createRawArgumentsPreparer<InterruptAgentInput>(
  "collaboration_interrupt_agent",
  {
    target: "string",
  },
);

export const prepareListAgentsArguments = createRawArgumentsPreparer<ListAgentsInput>(
  "collaboration_list_agents",
  {
    path_prefix: "string",
  },
);

export const prepareWaitAgentArguments = createRawArgumentsPreparer<WaitAgentInput>(
  "collaboration_wait_agent",
  {
    timeout_ms: "number",
  },
);

export type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };

export interface SpawnAgentResult {
  task_name: string;
}

export interface SendMessageResult {
  target: string;
  delivery: "steered" | "queued";
}

export interface FollowupTaskResult {
  target: string;
  delivery: "follow_up" | "started";
}

export interface InterruptAgentResult {
  target: string;
  previous_status: AgentStatus;
}

export interface ListAgentsResult {
  agents: Array<{
    agent_name: string;
    agent_status: AgentStatus;
  }>;
}

export interface WaitAgentResult {
  message: string;
  timed_out: boolean;
}

export type CollaborationSuccessResult =
  | SpawnAgentResult
  | SendMessageResult
  | FollowupTaskResult
  | InterruptAgentResult
  | ListAgentsResult
  | WaitAgentResult;

/** Encode the exact logical result in both Pi result representations. */
export function createSuccessResult<T extends CollaborationSuccessResult>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

export function isCompletedStatus(status: AgentStatus): status is { completed: string | null } {
  return typeof status === "object" && status !== null && "completed" in status;
}

export function isErroredStatus(status: AgentStatus): status is { errored: string } {
  return typeof status === "object" && status !== null && "errored" in status;
}

export function isActiveStatus(status: AgentStatus): status is "pending_init" | "running" {
  return status === "pending_init" || status === "running";
}

export function isInactiveLiveStatus(
  status: AgentStatus,
): status is "interrupted" | { completed: string | null } | { errored: string } {
  return status === "interrupted" || isCompletedStatus(status) || isErroredStatus(status);
}

export function waitTimeoutMs(input: WaitAgentInput): number {
  return input.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
}
