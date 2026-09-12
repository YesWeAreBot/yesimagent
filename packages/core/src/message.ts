import type { AssistantModelMessage, SystemModelMessage, ToolModelMessage, UserModelMessage } from "@ai-sdk/provider-utils";
import type { AssistantContent, LanguageModelUsage, ToolContent, UserContent } from "ai";

export interface AgentMessageBase {
  id: string;
  timestamp: number;
}

export interface CustomMessage<T extends string = string, D = unknown> extends AgentMessageBase {
  role: "custom";
  type: T;
  data: D;
}

export interface AgentCustomMessage {
  custom: CustomMessage<"custom", unknown>;
}

export interface AgentUserMessage extends AgentMessageBase, UserModelMessage {}

export interface AgentSystemMessage extends AgentMessageBase, SystemModelMessage {}

export interface AgentAssistantMessage extends AgentMessageBase, AssistantModelMessage {
  usage?: Partial<LanguageModelUsage>;
  finishReason?: string;
}

export interface AgentToolMessage extends AgentMessageBase, ToolModelMessage {}

export type AgentMessage = AgentUserMessage | AgentSystemMessage | AgentAssistantMessage | AgentToolMessage | AgentCustomMessage[keyof AgentCustomMessage];

export interface CreateMessageOptions {
  id?: string;
  timestamp?: number;
}

export function createUserMessage(content: UserContent, options: CreateMessageOptions = {}): AgentUserMessage {
  return { ...createMessageBase(options), role: "user", content };
}

export function createSystemMessage(content: string, options: CreateMessageOptions = {}): AgentSystemMessage {
  return { ...createMessageBase(options), role: "system", content };
}

export function createAssistantMessage(
  content: AssistantContent,
  options: Omit<Partial<AgentAssistantMessage>, "role" | "content"> = {},
): AgentAssistantMessage {
  const { id, timestamp, ...metadata } = options;
  return { ...createMessageBase({ id, timestamp }), role: "assistant", content, ...metadata };
}

export function createToolMessage(content: ToolContent, options: Omit<Partial<AgentToolMessage>, "role" | "content"> = {}): AgentToolMessage {
  const { id, timestamp, ...metadata } = options;
  return { ...createMessageBase({ id, timestamp }), role: "tool", content, ...metadata };
}

export function createCustomMessage<T extends Extract<keyof AgentCustomMessage, string>>(
  type: T,
  data: AgentCustomMessage[T] extends CustomMessage<infer U, infer V> ? V : never,
  options: CreateMessageOptions = {},
): AgentCustomMessage[T] {
  return { ...createMessageBase(options), role: "custom", type, data } as AgentCustomMessage[T];
}

function createMessageBase(options: CreateMessageOptions): AgentMessageBase {
  return {
    id: options.id ?? crypto.randomUUID(),
    timestamp: options.timestamp ?? Date.now(),
  };
}
