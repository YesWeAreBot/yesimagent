import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { experimental_toolCaller, type FunctionTool } from "@ai-sdk/provider-utils";
import { jsonSchema, simulateReadableStream, type Tool, type ToolExecuteFunction, type ToolSet } from "ai";
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

/** Ends the turn after a send step, the policy a chat host wants. */
const stopAfterSend: AgentPlugin = {
  name: "stop-after-send",
  onStepFinish(info) {
    for (const message of info.result.messages) {
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type !== "tool-result" || part.toolName !== "send") continue;
        const output = typeof part.output === "object" && part.output !== null && "value" in part.output ? part.output.value : undefined;
        if (typeof output === "object" && output !== null && "ok" in output && output.ok === true) return { continue: false };
      }
    }
    return undefined;
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

/** The role order of everything the agent has stored, the way a projection reads it back. */
async function storedRoles(agent: Agent): Promise<string[]> {
  const entries = await agent.storage.read();
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.data.role] : []));
}

function toolResultsOf(prompt: LanguageModelV4CallOptions["prompt"]) {
  return prompt.flatMap((message) => (message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : []));
}

/**
 * A local caller tool, the shape code mode contributes: it runs inside the SDK and reaches its host
 * tools through `bind`. Hand-rolled here so core's tests carry no code-mode dependency.
 */
function callerTool(script: (host: ToolSet) => Promise<unknown>): Tool {
  return experimental_toolCaller(
    {
      description: "Run a program over the tools it was granted.",
      inputSchema: jsonSchema({ type: "object", properties: {}, required: [] }),
      execute: async () => ({ ok: true, ran: "unbound" }),
    },
    {
      type: "local",
      bind: (host) => ({
        description: "Run a program over the tools it was granted.",
        inputSchema: jsonSchema({ type: "object", properties: {}, required: [] }),
        execute: async () => ({ ok: true, ran: await script(host) }),
      }),
    },
  );
}

describe("agent tool loop", () => {
  it("ends the turn after a successful send step", async () => {
    const model = scriptedModel([toolStep("send", { body: "hi" }), textStep("should not run")]);
    const agent = createAgent({ model, tools: sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })), plugins: [stopAfterSend] });

    await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(await toolOutputs(agent)).toEqual([{ type: "json", value: { ok: true, id: "m-1", body: "hi" } }]);
  });

  it("keeps the turn going when the send failed", async () => {
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

  it("keeps a step's tool result next to its call when a record-only write lands mid-step", async () => {
    const model = scriptedModel([toolStep("send", { body: "hi" }), textStep("done")]);
    const agent = createAgent({ model, tools: sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })) });

    // A chat host records an inbound message the moment it arrives, so that write can run while the step
    // is still being persisted. Firing it from the step's own append window is where the two collide.
    let recorded = false;
    agent.channel.subscribe("agent", (event) => {
      if (recorded || event.type !== "message.appended" || event.message.role !== "assistant") return;
      recorded = true;
      agent.send(createUserMessage("inbound"), { trigger: false });
    });

    await runTurn(agent);

    // The inbound message may land before or after the step, never between the call and its result.
    expect(await storedRoles(agent)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
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

  it("continues the turn when a called tool has no execute function", async () => {
    const model = scriptedModel([toolStep("ghost", {}), textStep("reported")]);
    const tools: ToolSet = { ghost: { inputSchema: jsonSchema({ type: "object", properties: {} }) } };
    const agent = createAgent({ model, tools });

    const events = await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(await toolOutputs(agent)).toEqual([{ type: "error-text", value: 'AgentRuntimeError: Tool "ghost" has no execute function' }]);
    expect(events.map((event) => event.type)).toContain("tool.failed");
  });

  it("fails the turn when an enforced tool choice is ignored", async () => {
    const model = scriptedModel([textStep("plain text")]);
    const agent = createAgent({ model, toolChoice: "required" });

    const events = await runTurn(agent);

    expect(events.map((event) => event.type)).toContain("turn.failed");
  });

  it("carries a prepareStep runtimeContext through the turn and restarts from the config on the next one", async () => {
    const model = scriptedModel([toolStep("send", { body: "hi" }), textStep("done"), textStep("next turn")]);
    const seen: unknown[] = [];
    const plugin: AgentPlugin = {
      name: "runtime-context",
      prepareStep(step) {
        seen.push(step.runtimeContext.marker);
        return { ...step, runtimeContext: { marker: `step ${step.stepNumber}` } };
      },
    };
    const agent = createAgent({
      model,
      tools: sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })),
      runtimeContext: { marker: "config" },
      plugins: [plugin],
    });

    await runTurn(agent);
    await runTurn(agent);

    expect(seen).toEqual(["config", "step 0", "config"]);
  });

  it("picks up a plugin's changed tools on the next turn without a refresh call", async () => {
    const model = scriptedModel([textStep("first"), textStep("second")]);
    const probeTools: ToolSet = { probe: { description: "probe", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "ok" } };
    const lateTool: ToolSet = { late: { description: "late", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "ok" } };
    let extended = false;
    const plugin: AgentPlugin = {
      name: "dynamic-prompt",
      extendTools: () => (extended ? { ...probeTools, ...lateTool } : probeTools),
    };
    const agent = createAgent({ model, plugins: [plugin] });

    await runTurn(agent);
    extended = true;
    await runTurn(agent);

    expect(model.doStreamCalls.map((call) => call.tools?.map((tool) => tool.name))).toEqual([["probe"], ["probe", "late"]]);
  });

  it("assembles the prompt once per turn, not once per step", async () => {
    const model = scriptedModel([toolStep("send", { body: "hi" }), textStep("done")]);
    let assemblies = 0;
    const agent = createAgent({
      model,
      tools: sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })),
      plugins: [
        {
          name: "counting",
          extendTools: () => {
            assemblies += 1;
            return {};
          },
        },
      ],
    });

    await runTurn(agent);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(assemblies).toBe(1);
  });

  it("binds a caller tool's host tools, hiding them from the model", async () => {
    const model = scriptedModel([toolStep("run", {}), textStep("done")]);
    const agent = createAgent({
      model,
      tools: {
        ...sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })),
        run: callerTool(async (host) => (await host.send?.execute?.({ body: "hi" }, { toolCallId: "inner-1", messages: [], context: {} })) as unknown),
      },
      toolCallers: { send: ["run"] },
    });

    await runTurn(agent);

    // The model never sees `send`; the program reached it anyway, through the binding the SDK does.
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(["run"]);
    expect(await toolOutputs(agent)).toEqual([{ type: "json", value: { ok: true, ran: { ok: true, id: "m-1", body: "hi" } } }]);
  });

  it("runs a caller tool's nested calls through the tool events", async () => {
    const model = scriptedModel([toolStep("run", {}), textStep("done")]);
    const agent = createAgent({
      model,
      tools: {
        ...sendTool(async (input) => ({ ok: true, id: "m-1", body: input.body })),
        run: callerTool(async (host) => host.send?.execute?.({ body: "hi" }, { toolCallId: "inner-1", messages: [], context: {} })),
      },
      toolCallers: { send: ["run"] },
    });
    const events = await runTurn(agent);

    // The wrapped execute, not the raw tool: a nested call is a real call and shows up as one.
    expect(events.map((event) => event.type)).toContain("tool.start");
    const started = events.filter((event) => event.type === "tool.start");
    expect(started.map((event) => (event.type === "tool.start" ? event.toolName : ""))).toEqual(["run", "send"]);
  });
});
