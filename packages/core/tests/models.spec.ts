import { describe, expect, it } from "vitest";

import { createEntry } from "../src/entry.js";
import { createAssistantMessage, createUserMessage } from "../src/message.js";

describe("AgentEntry and AgentMessage", () => {
  it("keeps runtime metadata on messages and persistence metadata on entries", () => {
    const message = createUserMessage("hello", { id: "message-1", timestamp: 10 });
    const entry = createEntry("message", message, {
      id: "entry-1",
      timestamp: 20,
      turnId: "turn-1",
    });

    expect(message).toMatchObject({ role: "user", content: "hello", id: "message-1", timestamp: 10 });
    expect(entry).toMatchObject({ type: "message", data: message, id: "entry-1", timestamp: 20, turnId: "turn-1" });
  });

  it("retains assistant execution metadata", () => {
    const message = createAssistantMessage("done", {
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      finishReason: "stop",
    });

    expect(message.usage?.totalTokens).toBe(5);
    expect(message.finishReason).toBe("stop");
  });
});
