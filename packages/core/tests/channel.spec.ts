import { describe, expect, it } from "vitest";

import { AgentChannel } from "../src/channel.js";

describe("AgentChannel", () => {
  it("delivers events and isolates listener failures", async () => {
    const channel = new AgentChannel();
    const received: string[] = [];

    channel.subscribe("agent", async (event) => {
      received.push(event.type);
    });
    channel.subscribe("agent", () => {
      throw new Error("listener failure");
    });

    await channel.emit("agent", { type: "agent.init" });

    expect(received).toEqual(["agent.init"]);
  });

  it("stops delivering events after unsubscribe", async () => {
    const channel = new AgentChannel();
    let count = 0;
    const unsubscribe = channel.subscribe("agent", () => {
      count += 1;
    });

    unsubscribe();
    await channel.emit("agent", { type: "agent.stop" });

    expect(count).toBe(0);
  });
});
