import type { AgentCustomEvent } from "./event.js";

type AgentEventListener<T> = (event: T) => Promise<void> | void;

export class AgentChannel {
  private readonly channels = new Map<keyof AgentCustomEvent, Set<AgentEventListener<never>>>();

  async emit<K extends keyof AgentCustomEvent>(channel: K, event: AgentCustomEvent[K]): Promise<void> {
    const listeners = this.channels.get(channel);
    if (!listeners) return;

    await Promise.all(
      [...listeners].map(async (listener) => {
        try {
          await listener(event as never);
        } catch {
          // A listener must not affect other listeners or the agent loop.
        }
      }),
    );
  }

  subscribe<K extends keyof AgentCustomEvent>(channel: K, listener: AgentEventListener<AgentCustomEvent[K]>): () => void {
    let listeners = this.channels.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.channels.set(channel, listeners);
    }

    listeners.add(listener as AgentEventListener<never>);
    return () => {
      listeners?.delete(listener as AgentEventListener<never>);
      if (listeners?.size === 0) this.channels.delete(channel);
    };
  }
}
