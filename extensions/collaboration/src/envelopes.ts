import { randomUUID } from "node:crypto";

export type ParentMessageType = "TASK" | "MESSAGE" | "FOLLOW_UP";

export interface QueuedParentMessage {
  id: string;
  message: string;
}

export type MessageIdFactory = () => string;

export function createParentEnvelope(
  type: ParentMessageType,
  recipient: string,
  payload: string,
  messageId: string = randomUUID(),
): string {
  return [
    `Message Type: ${type}`,
    "Sender: /root",
    `Recipient: ${recipient}`,
    `Message-ID: ${messageId}`,
    "Payload:",
    payload,
  ].join("\n");
}

export function createQueuedParentMessage(
  message: string,
  createId: MessageIdFactory = randomUUID,
): QueuedParentMessage {
  return { id: createId(), message };
}

export function composeInactiveTaskPrompt(
  recipient: string,
  queued: readonly QueuedParentMessage[],
  task: string,
  createId: MessageIdFactory = randomUUID,
): string {
  return [
    ...queued.map((entry) => createParentEnvelope("MESSAGE", recipient, entry.message, entry.id)),
    createParentEnvelope("TASK", recipient, task, createId()),
  ].join("\n\n");
}
