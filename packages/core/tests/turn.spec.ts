import { describe, expect, it } from "vitest";

import { createAssistantMessage, createUserMessage } from "../src/message.js";
import { AgentQueue, type TurnResult } from "../src/turn.js";

describe("AgentQueue", () => {
  it("runs one model step at a time and accumulates usage", async () => {
    const steps: number[] = [];
    const events: string[] = [];
    let result: TurnResult | undefined;
    const queue = new AgentQueue({
      maxSteps: 3,
      async runStep(_request, stepNumber) {
        steps.push(stepNumber);
        return {
          messages: [createAssistantMessage(`step-${stepNumber}`)],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          finishReason: stepNumber === 1 ? "stop" : "tool-call",
          continue: stepNumber === 0,
        };
      },
      async emit(event) {
        events.push(event.type);
      },
      onTurnFinish(value) {
        result = value;
      },
    });

    const turnId = queue.enqueue([createUserMessage("hello")]);
    await queue.wait();

    expect(steps).toEqual([0, 1]);
    expect(events).toEqual(["turn.start", "turn.step", "turn.step", "turn.done"]);
    expect(result).toMatchObject({
      turnId,
      status: "done",
      usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
    });
    expect(result?.messages).toHaveLength(3);
  });
});
