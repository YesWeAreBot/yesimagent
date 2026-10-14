import type { AgentEvent } from "./event.js";

/**
 * One turn's events, buffered for its stream: a stream created by `run()` reads the replay and then
 * rides the listeners live. A turn that terminates without a stream has no reader left, so its buffer
 * is dropped there — a `send`-driven agent must not keep one buffer per finished turn.
 */
export class TurnEvents {
  private readonly buffers = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  /** Buffers the event under its turn and hands it to that turn's listeners. */
  push(event: AgentEvent): void {
    if (!hasTurnId(event)) return;

    const buffered = this.buffers.get(event.turnId) ?? [];
    buffered.push(event);
    this.buffers.set(event.turnId, buffered);
    for (const listener of this.listeners.get(event.turnId) ?? []) listener(event);

    if (isTerminalEvent(event) && !this.listeners.has(event.turnId)) this.buffers.delete(event.turnId);
  }

  /** The events a stream starting now still has to see, oldest first. */
  replay(turnId: string): AgentEvent[] {
    return [...(this.buffers.get(turnId) ?? [])];
  }

  /** Adds a live listener for one turn; the returned function removes it again. */
  subscribe(turnId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.listeners.get(turnId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.listeners.set(turnId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(turnId);
    };
  }

  /** Drops a finished turn's replay; the stream that consumed it calls this on close. */
  drop(turnId: string): void {
    this.buffers.delete(turnId);
  }
}

export function hasTurnId(event: AgentEvent): event is AgentEvent & { turnId: string } {
  return "turnId" in event && typeof event.turnId === "string";
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted";
}
