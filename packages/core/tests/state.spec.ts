import { describe, expect, it } from "vitest";

import { AgentStateManager } from "../src/state.js";

describe("AgentStateManager", () => {
  it("publishes memory only after persistence succeeds", async () => {
    const persisted: number[] = [];
    const state = new AgentStateManager({
      initialState: { version: 1 },
      onChange: async (next) => {
        if (next.version === 2) throw new Error("write failed");
        persisted.push(next.version);
      },
    });

    await expect(state.set({ version: 2 })).rejects.toThrow("write failed");
    expect(state.get().version).toBe(1);

    await state.set({ version: 3 });
    expect(state.get().version).toBe(3);
    expect(persisted).toEqual([3]);
  });

  it("serializes concurrent updates against the latest committed state", async () => {
    const state = new AgentStateManager({ initialState: { version: 1 } });

    await Promise.all([state.update({ version: 2 }), state.update({ version: 3 })]);

    expect(state.get().version).toBe(3);
  });

  it("clones restored snapshots", () => {
    const state = new AgentStateManager({ initialState: { version: 1 } });
    const snapshot = { version: 2 };

    state.restore(snapshot);
    snapshot.version = 9;

    expect(state.get().version).toBe(2);
  });
});
