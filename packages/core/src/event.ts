import type { LanguageModelUsage } from "ai";

import type { AgentMessage } from "./message.js";

export interface AgentCustomEvent {
  agent: AgentEvent;
}

export type AgentEvent =
  | AgentInitEvent
  | AgentStopEvent
  | AgentPromptAssembleEvent
  | TurnQueuedEvent
  | TurnStartEvent
  | TurnStepEvent
  | TurnDoneEvent
  | TurnFailedEvent
  | TurnAbortedEvent
  | ToolStartEvent
  | ToolDoneEvent
  | ToolFailedEvent
  | ToolBlockedEvent
  | MessageAppendedEvent;

export interface AgentInitEvent {
  type: "agent.init";
}

export interface AgentStopEvent {
  type: "agent.stop";
}

export interface AgentPromptAssembleEvent {
  type: "agent.prompt_assemble";
}

export interface TurnQueuedEvent {
  type: "turn.queued";
  turnId: string;
}

export interface TurnStartEvent {
  type: "turn.start";
  turnId: string;
}

export interface TurnStepEvent {
  type: "turn.step";
  turnId: string;
  stepNumber: number;
  usage?: Partial<LanguageModelUsage>;
  finishReason?: string;
}

export interface TurnDoneEvent {
  type: "turn.done";
  turnId: string;
  usage?: Partial<LanguageModelUsage>;
}

export interface TurnFailedEvent {
  type: "turn.failed";
  turnId: string;
  error?: {
    name: string;
    message: string;
    cause?: string;
  };
}

export interface TurnAbortedEvent {
  type: "turn.aborted";
  turnId: string;
  reason?: string;
}

export interface ToolStartEvent {
  type: "tool.start";
  turnId: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}

export interface ToolDoneEvent {
  type: "tool.done";
  turnId: string;
  toolName: string;
  toolCallId?: string;
  result?: unknown;
}

export interface ToolFailedEvent {
  type: "tool.failed";
  turnId: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  error?: {
    name: string;
    message: string;
    cause?: string;
  };
}

export interface ToolBlockedEvent {
  type: "tool.blocked";
  turnId: string;
  toolName: string;
  toolCallId?: string;
  reason?: string;
}

export interface MessageAppendedEvent {
  type: "message.appended";
  message: AgentMessage;
}
