import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../src/event.js";
import { TurnEvents } from "../src/turn-events.js";

describe("TurnEvents", () => {
  it("drops a streamless turn's events once it terminates", () => {
    const events = new TurnEvents();

    events.push({ type: "turn.start", turnId: "t-1" });
    expect(events.replay("t-1")).toHaveLength(1);

    events.push({ type: "turn.done", turnId: "t-1" });
    expect(events.replay("t-1")).toHaveLength(0);
  });

  it("keeps a subscribed turn's events until the stream drops them", () => {
    const events = new TurnEvents();
    const seen: AgentEvent[] = [];
    const unsubscribe = events.subscribe("t-1", (event) => seen.push(event));

    events.push({ type: "turn.start", turnId: "t-1" });
    events.push({ type: "turn.done", turnId: "t-1" });

    expect(seen.map((event) => event.type)).toEqual(["turn.start", "turn.done"]);
    expect(events.replay("t-1")).toHaveLength(2);

    unsubscribe();
    events.drop("t-1");
    expect(events.replay("t-1")).toHaveLength(0);
  });

  it("keeps each turn to itself, and ignores events without a turn", () => {
    const events = new TurnEvents();
    const seen: AgentEvent[] = [];
    events.subscribe("t-1", (event) => seen.push(event));

    events.push({ type: "turn.start", turnId: "t-2" });
    events.push({ type: "agent.init" });
    expect(seen).toEqual([]);

    events.push({ type: "turn.done", turnId: "t-2" });
    expect(events.replay("t-2")).toHaveLength(0);
  });
});
