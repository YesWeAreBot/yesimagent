import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { FunctionTool } from "@ai-sdk/provider-utils";
import { jsonSchema, simulateReadableStream, type ToolExecuteFunction, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createAgent,
  createAssistantMessage,
  createEntry,
  createUserMessage,
  type Agent,
  type AgentEntry,
  type AgentEvent,
  type AgentMessage,
  type AgentPlugin,
} from "../src/index.js";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

function toolStep(toolName: string, input: unknown, toolCallId = "call-1"): LanguageModelV4StreamPart[] {
  const encoded = JSON.stringify(input);
  return [
    { type: "tool-input-start", id: toolCallId, toolName },
    { type: "tool-input-delta", id: toolCallId, delta: encoded },
    { type: "tool-input-end", id: toolCallId },
    { type: "tool-call", toolCallId, toolName, input: encoded },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function scriptedModel(steps: LanguageModelV4StreamPart[][]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

interface SendInput {
  body: string;
}

type SendOutput = { ok: true; id: string; body: string } | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };

const bodySchema = jsonSchema<SendInput>({
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
});

function sendTool(execute: ToolExecuteFunction<SendInput, SendOutput, unknown>): ToolSet {
  return { send: { description: "Send a message.", inputSchema: bodySchema, execute } };
}

/** Ends the turn only on a successful send, the policy a chat host wants. */
const stopAfterSend: AgentPlugin = {
  name: "stop-after-send",
  afterToolCall(result) {
    if (result.toolName !== "send" || result.isError) return result;
    const output = result.result as { ok?: boolean };
    return { ...result, endTurn: output.ok === true };
  },
};

async function runTurn(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(createUserMessage("hello"))) events.push(event);
  return events;
}

async function toolOutputs(agent: Agent): Promise<unknown[]> {
  const entries = await agent.storage.read();
  const messages: AgentMessage[] = entries.filter((entry): entry is AgentEntry<"message"> => entry.type === "message").map((entry) => entry.data);
  return messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content.flatMap((part) => (part.type === "tool-result" ? [part.output] : [])));
}

function toolResultsOf(prompt: LanguageModelV4CallOptions["prompt"]) {
  return prompt.flatMap((message) => (message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : []));
}

describe("agent tool loop", () => {
  it("ends the turn on an endTurn result and records it as JSON", async () => {
    const model = scriptedModel([toolStep("send", { body: "hi" }), textStep("should not run")]);
    const agent = createAgent({ model, tools: sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })), plugins: [stopAfterSend] });

    await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(await toolOutputs(agent)).toEqual([{ type: "json", value: { ok: true, id: "m-1", body: "hi" } }]);
  });

  it("keeps the turn going when a failed tool leaves endTurn false", async () => {
    const model = scriptedModel([toolStep("send", { body: "" }), textStep("retried")]);
    const agent = createAgent({
      model,
      tools: sendTool(async () => ({ ok: false, error: { name: "InvalidInput", message: "messages is empty" }, sent: [], failedAt: 0 })),
      plugins: [stopAfterSend],
    });

    await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(await toolOutputs(agent)).toEqual([
      { type: "json", value: { ok: false, error: { name: "InvalidInput", message: "messages is empty" }, sent: [], failedAt: 0 } },
    ]);
  });

  it("records a thrown tool error as a tool result and continues the turn", async () => {
    const model = scriptedModel([toolStep("send", { body: "hi" }), textStep("reported")]);
    const agent = createAgent({
      model,
      tools: sendTool(async () => {
        throw new Error("platform down");
      }),
      plugins: [stopAfterSend],
    });

    const events = await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(toolResultsOf(model.doStreamCalls[1].prompt)).toMatchObject([
      { toolCallId: "call-1", toolName: "send", output: { type: "error-text", value: "Error: platform down" } },
    ]);
    expect(events.map((event) => event.type)).toContain("tool.failed");
    expect(events.map((event) => event.type)).toContain("turn.done");
  });

  it("repairs a stored tool call that has no result", async () => {
    const model = scriptedModel([textStep("continued")]);
    const agent = createAgent({ model });
    await agent.storage.append(
      createEntry("message", createUserMessage("hello")),
      createEntry("message", createAssistantMessage([{ type: "tool-call", toolCallId: "call-9", toolName: "send", input: {} }])),
    );

    const events = await runTurn(agent);

    expect(toolResultsOf(model.doStreamCalls[0].prompt)).toMatchObject([
      { toolCallId: "call-9", toolName: "send", output: { type: "error-text", value: "Tool result was not recorded" } },
    ]);
    expect(events.map((event) => event.type)).toContain("tool.result_repaired");
  });

  it("hands a tool its context and honours toModelOutput", async () => {
    const model = scriptedModel([toolStep("probe", {}), textStep("done")]);
    const probe: FunctionTool<unknown, { token: string }, { token: string }> = {
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      toModelOutput: ({ output }) => ({ type: "text", value: `seen:${output.token}` }),
      execute: async (_input, { context }) => ({ token: context.token }),
    };
    const agent = createAgent({ model, tools: { probe }, toolsContext: { probe: { token: "abc" } } });

    await runTurn(agent);

    expect(await toolOutputs(agent)).toEqual([{ type: "text", value: "seen:abc" }]);
  });

  it("ends the turn when a called tool has no execute function", async () => {
    const model = scriptedModel([toolStep("ghost", {}), textStep("should not run")]);
    const tools: ToolSet = { ghost: { inputSchema: jsonSchema({ type: "object", properties: {} }) } };
    const agent = createAgent({ model, tools });

    const events = await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(await toolOutputs(agent)).toEqual([{ type: "error-text", value: 'AgentRuntimeError: Tool "ghost" has no execute function' }]);
    expect(events.map((event) => event.type)).toContain("tool.failed");
  });

  it("retries a step with auto tool choice when an enforced choice is ignored", async () => {
    const model = scriptedModel([textStep("plain text"), textStep("plain text again")]);
    const agent = createAgent({ model, toolChoice: "required", toolChoiceViolation: "fallback" });

    const events = await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: "required" });
    expect(model.doStreamCalls[1].toolChoice).toEqual({ type: "auto" });
    expect(events.map((event) => event.type)).not.toContain("turn.failed");
  });

  it("fails the turn when an enforced tool choice is ignored and no fallback is configured", async () => {
    const model = scriptedModel([textStep("plain text")]);
    const agent = createAgent({ model, toolChoice: "required" });

    const events = await runTurn(agent);

    expect(events.map((event) => event.type)).toContain("turn.failed");
  });
});
