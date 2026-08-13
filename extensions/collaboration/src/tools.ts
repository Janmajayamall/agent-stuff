import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RootMailbox } from "./mailbox.ts";
import {
  FollowupTaskInputSchema,
  InterruptAgentInputSchema,
  ListAgentsInputSchema,
  prepareFollowupTaskArguments,
  prepareInterruptAgentArguments,
  prepareListAgentsArguments,
  prepareSendMessageArguments,
  prepareSpawnAgentArguments,
  prepareWaitAgentArguments,
  SendMessageInputSchema,
  SpawnAgentInputSchema,
  createSuccessResult,
  waitTimeoutMs,
  WaitAgentInputSchema,
} from "./contracts.ts";
import type { CollaborationRegistry } from "./registry.ts";

export function registerCollaborationTools(
  pi: ExtensionAPI,
  getRegistry: () => CollaborationRegistry<any>,
  getMailbox: () => RootMailbox,
): void {
  pi.registerTool({
    name: "collaboration_spawn_agent",
    label: "collaboration.spawn_agent",
    description:
      "Create a fresh-history direct child agent and start its initial task. At most three child turns may be active. There is no fork_turns input in Sprint 1.",
    promptSnippet: "Create a depth-one child agent for an independent task",
    promptGuidelines: [
      "Use collaboration_spawn_agent for concrete, bounded work that can proceed independently in the shared workspace.",
      "Retain the canonical task_name returned by collaboration_spawn_agent for later coordination.",
    ],
    parameters: SpawnAgentInputSchema,
    prepareArguments: prepareSpawnAgentArguments,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      return createSuccessResult(await getRegistry().spawn(params));
    },
  });

  pi.registerTool({
    name: "collaboration_send_message",
    label: "collaboration.send_message",
    description:
      "Send informational context to a child. Running children are steered; inactive live children store the message without starting a turn.",
    parameters: SendMessageInputSchema,
    prepareArguments: prepareSendMessageArguments,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      return createSuccessResult(await getRegistry().sendMessage(params.target, params.message));
    },
  });

  pi.registerTool({
    name: "collaboration_followup_task",
    label: "collaboration.followup_task",
    description:
      "Give an existing child executable follow-up work. An inactive child restarts against its persistent session; an active child queues the follow-up in its worker.",
    parameters: FollowupTaskInputSchema,
    prepareArguments: prepareFollowupTaskArguments,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      return createSuccessResult(await getRegistry().followupTask(params.target, params.message));
    },
  });

  pi.registerTool({
    name: "collaboration_interrupt_agent",
    label: "collaboration.interrupt_agent",
    description:
      "Interrupt a child's active turn while retaining its registry entry and persistent session for later follow-up work.",
    parameters: InterruptAgentInputSchema,
    prepareArguments: prepareInterruptAgentArguments,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      return createSuccessResult(await getRegistry().interruptAgent(params.target));
    },
  });

  pi.registerTool({
    name: "collaboration_list_agents",
    label: "collaboration.list_agents",
    description: "List /root and its live depth-one children with a stable point-in-time status snapshot.",
    parameters: ListAgentsInputSchema,
    prepareArguments: prepareListAgentsArguments,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      return createSuccessResult(getRegistry().listAgents(params.path_prefix));
    },
  });

  pi.registerTool({
    name: "collaboration_wait_agent",
    label: "collaboration.wait_agent",
    description:
      "Wait without polling for one new child mailbox/final-status event or new human input steered into the root turn. Full child payloads arrive separately in the root mailbox.",
    parameters: WaitAgentInputSchema,
    prepareArguments: prepareWaitAgentArguments,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      return createSuccessResult(await getMailbox().wait(waitTimeoutMs(params), signal));
    },
  });
}
