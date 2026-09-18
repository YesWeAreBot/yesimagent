import { describe, expect, it } from "vitest";

import { createAssistantMessage, createUserMessage } from "../src/message.js";
import { AgentQueue, type TurnResult } from "../src/turn.js";

describe("AgentQueue", () => {
  it("runs one model step at a time and reports the last step's usage", async () => {
    const steps: number[] = [];
    const events: string[] = [];
    let result: TurnResult | undefined;
    const queue = new AgentQueue({
      maxSteps: 3,
      async runStep(_request, stepNumber) {
        steps.push(stepNumber);
        return {
          messages: [createAssistantMessage(`step-${stepNumber}`)],
          usage: stepNumber === 0 ? { inputTokens: 1, outputTokens: 2, totalTokens: 3 } : { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
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
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    });
    expect(result?.messages).toHaveLength(3);
  });

  it("persists a joined message at the step boundary, not during the step", async () => {
    const log: string[] = [];
    const queue = new AgentQueue({
      maxSteps: 2,
      async runStep(request, stepNumber) {
        log.push(`step:${stepNumber}`);
        if (stepNumber === 0) {
          request.addJoined([createUserMessage("late")], async () => {
            log.push("persist");
          });
          log.push("in-step");
        }
        return { messages: [], continue: stepNumber === 0 };
      },
      async emit() {},
    });

    queue.enqueue([createUserMessage("first")]);
    await queue.wait();

    expect(log).toEqual(["step:0", "in-step", "persist", "step:1"]);
  });

  it("persists a message joined during the final step", async () => {
    const log: string[] = [];
    const queue = new AgentQueue({
      maxSteps: 1,
      async runStep(request) {
        request.addJoined([createUserMessage("late")], async () => {
          log.push("persist");
        });
        return { messages: [], continue: false };
      },
      async emit() {},
    });

    queue.enqueue([createUserMessage("first")]);
    await queue.wait();

    expect(log).toEqual(["persist"]);
  });

  it("calls onStepFinish once per step, after the boundary drain", async () => {
    const log: string[] = [];
    const queue = new AgentQueue({
      maxSteps: 3,
      async runStep(request, stepNumber) {
        log.push(`step:${stepNumber}`);
        return { messages: [], continue: true };
      },
      async emit() {},
      onStepFinish() {
        log.push("finish");
        return undefined;
      },
    });

    queue.enqueue([createUserMessage("go")]);
    await queue.wait();

    expect(log).toEqual(["step:0", "finish", "step:1", "finish", "step:2", "finish"]);
  });

  it("lets onStepFinish end the turn", async () => {
    let steps = 0;
    const queue = new AgentQueue({
      maxSteps: 3,
      async runStep() {
        steps += 1;
        return { messages: [], continue: true };
      },
      async emit() {},
      onStepFinish() {
        return { continue: false };
      },
    });

    queue.enqueue([createUserMessage("go")]);
    await queue.wait();

    expect(steps).toBe(1);
  });

  it("still calls onStepFinish on a final step that does not continue", async () => {
    const log: string[] = [];
    const queue = new AgentQueue({
      maxSteps: 3,
      async runStep(_request, stepNumber) {
        log.push(`step:${stepNumber}`);
        return { messages: [], continue: false };
      },
      async emit() {},
      onStepFinish() {
        log.push("finish");
        return undefined;
      },
    });

    queue.enqueue([createUserMessage("go")]);
    await queue.wait();

    expect(log).toEqual(["step:0", "finish"]);
  });
});
