import type { AgentStatus } from "./contracts.ts";
import { extractVisibleAssistantText, sanitizeAssistantMessage } from "./monitor/model.ts";

export interface AssistantOutcomeMessage {
  role: "assistant";
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export interface SettledOutcomeInput {
  finalAssistant?: AssistantOutcomeMessage | undefined;
  interruptedByExtension: boolean;
}

export function mapSettledOutcome(input: SettledOutcomeInput): AgentStatus {
  if (input.interruptedByExtension) return "interrupted";
  if (!input.finalAssistant) return { completed: null };

  const assistant = sanitizeAssistantMessage(input.finalAssistant) as AssistantOutcomeMessage;
  const errorMessage = typeof assistant.errorMessage === "string" && assistant.errorMessage
    ? assistant.errorMessage
    : undefined;

  switch (assistant.stopReason) {
    case "error":
      return { errored: errorMessage ?? "Child provider/runtime error" };
    case "aborted":
      return { errored: errorMessage ?? "Child turn aborted unexpectedly" };
    case "length":
      return { errored: "Child response reached the output limit" };
    case "deferred":
      return { errored: "Deferred child responses are unsupported by per-turn workers" };
    case "pending":
      return { errored: "Child settled with an incomplete assistant response" };
    case "stop":
    case "toolUse":
    case undefined:
      return { completed: extractVisibleAssistantText(assistant) || null };
    default:
      return { errored: errorMessage ?? `Child settled with unsupported stop reason ${assistant.stopReason}` };
  }
}

export function formatStatusPayload(status: AgentStatus): string {
  if (typeof status === "object" && "completed" in status) {
    return status.completed ?? "Child completed without a final answer.";
  }
  if (typeof status === "object" && "errored" in status) {
    return `Child error: ${status.errored}`;
  }
  if (status === "interrupted") return "Child turn was interrupted.";
  return `Child status: ${status}`;
}
