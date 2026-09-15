import type { AgentEvent } from "./event.js";
import type { AgentMessage } from "./message.js";
import type { AgentState } from "./state.js";

export interface AgentCustomEntry {
  event: AgentEvent;
  message: AgentMessage;
  state: AgentState;
}

export type AgentEntry<T extends keyof AgentCustomEntry = keyof AgentCustomEntry> = {
  [K in T]: { type: K; data: AgentCustomEntry[K]; id: string; timestamp: number; parentId?: string; turnId?: string };
}[T];

export interface CreateEntryOptions {
  id?: string;
  timestamp?: number;
  parentId?: string;
  turnId?: string;
}

export function createEntry<T extends keyof AgentCustomEntry>(type: T, data: AgentCustomEntry[T], options: CreateEntryOptions = {}): AgentEntry<T> {
  return {
    id: options.id ?? crypto.randomUUID(),
    type,
    data,
    timestamp: options.timestamp ?? Date.now(),
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
  };
}
