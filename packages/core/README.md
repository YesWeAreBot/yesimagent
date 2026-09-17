# @yesimagent/core

A small agent runtime on the [AI SDK](https://ai-sdk.dev). It runs turns — queueing an incoming message, reading history, calling the model, executing tools, and emitting events — while storage, state, and plugins stay pluggable.

- **AI SDK underneath** — the model loop is `streamText` with an `AbortSignal`; messages map onto `ModelMessage`. Re-exports `ai`, `@ai-sdk/provider` and `@ai-sdk/provider-utils`, so a host depending on `@yesimagent/core` sees one consistent AI SDK.
- **Append-only entries** — everything that happens lands in storage as typed entries. History is what actually happened, and plugins can read and transform it before each step.
- **Turns are explicit** — one active turn at a time, with `defer` / `join` / `reject` behavior for messages that arrive mid-turn.

## Install

```sh
pnpm add @yesimagent/core
```

## Quickstart

```ts
import { createAgent, createUserMessage } from "@yesimagent/core";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const agent = createAgent({
  model: openai.responses("gpt-5.1"),
  instructions: "You are a concise assistant.",
});

// Subscribe before sending: the turn starts on the next tick, and events are not replayed.
agent.channel.subscribe("agent", (event) => {
  if (event.type === "turn.done") console.log(`turn ${event.turnId} finished`);
});

agent.send(createUserMessage("Say hello."));
await agent.wait();
```

## Agent

`createAgent(config)` builds an agent. The config:

```ts
interface AgentConfig {
  id?: string; // defaults to a random UUID
  model: LanguageModel; // any AI SDK LanguageModel, e.g. from @yesimagent/gateway
  instructions?: string; // system prompt, joined with plugin instructions
  tools?: ToolSet; // see Tools
  runtimeContext?: Record<string, unknown>; // per-turn host state, see Tools
  toolsContext?: Record<string, unknown>; // per-tool context, see Tools
  toolChoice?: ToolChoice<ToolSet>; // per step; a prepareStep may override it
  activeTools?: readonly string[]; // only these tools are available per step; omit for all of them
  settings?: LanguageModelCallOptions; // sampling and limits for every step
  storage?: AgentStorage<AgentEntry>; // defaults to in-memory
  plugins?: readonly AgentPlugin[]; // see Plugins
  maxSteps?: number; // per turn, defaults to 20
  initialState?: AgentState; // restored on init; every change persists as a state entry
}
```

Two ways to drive it:

- `send(message, options?)` submits a turn and returns its id immediately. When a turn is already active, `options.ifBusy` decides: `"defer"` queues it (default), `"join"` attaches it to the active turn's current step, `"reject"` throws `AgentBusyError`. `options.trigger: false` persists the message without starting a turn.
- `run(message)` submits a turn and returns an async iterable of that turn's events, closing after `turn.done`, `turn.failed`, or `turn.aborted`.

Lifecycle around turns:

| Method               | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `init()`             | Runs plugin `init` hooks; lazy on the first turn.                       |
| `stop()`             | Interrupts the active turn, stops plugins in reverse order.             |
| `wait(options?)`     | Resolves when the agent is idle; rejects if the optional signal aborts. |
| `interrupt(reason?)` | Aborts the active turn and everything queued.                           |
| `clear()`            | Clears storage.                                                         |
| `setModel(model)`    | Swaps the model; takes effect on the next step.                         |

## Messages and entries

Messages are what the model sees; entries are what storage keeps.

```ts
createUserMessage(content); // also: createSystemMessage, createAssistantMessage, createToolMessage
createCustomMessage(type, data); // runtime-only message, projected into model messages by plugins
```

Every message carries runtime metadata (`id`, `timestamp`), assistant messages additionally `usage` and `finishReason`. A message becomes durable when the agent appends it as an entry:

```ts
interface AgentEntry<T> {
  type: "message" | "event" | "state"; // one entry per kind
  data: T;
  id: string;
  timestamp: number;
  turnId?: string; // set for messages produced inside a turn
}
```

Storage is `append` / `read` / `clear`. Built-in: `createMemoryStorage()` and `createJsonlStorage(filePath)`. Any host backend — a database, a key-value store — is an `AgentStorage` implementation away.

## Turns

A turn is one pass through the queue: `turn.start` → steps → `turn.done` / `turn.failed` / `turn.aborted`. Each step calls the model once, executes the tool calls it produced, and continues (up to `maxSteps`) while tool calls remain. Whether a step ends the turn is a step-level decision: after the joined messages are persisted, `onStepFinish` runs and a returned `{ continue: false }` ends the turn even though tool calls were made. A step whose calls were all invalid keeps the turn going, so the model can repair its input.

An enforced `toolChoice` that the model ignores fails the turn with `ToolChoiceViolationError`.

Turn events:

| Event          | Emitted when                                                  |
| -------------- | ------------------------------------------------------------- |
| `turn.queued`  | A message was deferred behind an active turn.                 |
| `turn.start`   | The turn begins.                                              |
| `turn.step`    | A step finished, with that step's `usage` and `finishReason`. |
| `turn.done`    | The turn finished; accumulated `usage` included.              |
| `turn.failed`  | The model threw; `error` is `{ name, message, cause? }`.      |
| `turn.aborted` | The turn was interrupted.                                     |

## Tools

Tools are AI SDK tools. The AI SDK runs them inside the step and core records the result messages:

```ts
import { tool } from "ai";
import { z } from "zod";

const tools = {
  check_phone: tool({
    description: "Look at the phone.",
    inputSchema: z.object({}),
    execute: (input, { abortSignal }) => checkPhone({ abortSignal }),
  }),
};
```

Every call gets a result. A returned value is sent as text when it is a string, as JSON otherwise, or through the tool's own `toModelOutput` when it declares one; a thrown error becomes an `error-text` result and the step continues, so the model can react. A tool with no `execute` records an error result and the step continues, so the model can react (within `maxSteps`).

### Tool context

`toolsContext` hands server-side state to tools without putting it in the prompt. Each tool reads its own entry from `execute`'s second argument:

```ts
const agent = createAgent({
  model,
  tools: { send_message: sendMessageTool },
  // keyed by tool name; `ctx` here is any host service, not a JSON value
  toolsContext: { send_message: { bot, channelOf: (id: string) => lookup(id) } },
});

// inside the tool
execute: (input, { context }) => context.bot.sendMessage(context.channelOf(input.channel), input.message);
```

When a tool declares a `contextSchema`, its entry is validated against it before execution; without one, the value passes through untouched — which is what non-JSON services need. A `prepareStep` may return a new `toolsContext` to change it for the rest of the turn.

A bare object built next to `createAgent` is checked against `ToolSet`, which types `execute`'s arguments loosely. Annotate the tool (or build it with `tool()`) to keep the context and results typed:

```ts
import type { FunctionTool } from "@yesimagent/core";

const sendMessage: FunctionTool<SendInput, SendOutput, SendMessageContext> = {
  inputSchema: jsonSchema<SendInput>({/* … */}),
  toModelOutput: ({ output }) => ({ type: "text", value: output.summary }),
  execute: (input, { context }) => context.bot.sendMessage(input.channel, input.message),
};
```

### Runtime context

`runtimeContext` is the turn's shared host state. It is handed to the model call as the AI SDK's `runtimeContext`, so lifecycle callbacks and telemetry see it there, and every plugin's `prepareStep` reads it from `StepOptions`. Tools never see it — publish what a tool needs through `toolsContext`:

```ts
const turn: AgentPlugin = {
  name: "turn-state",
  prepareStep(step) {
    const seen = (step.runtimeContext.seen as string[] | undefined) ?? [];
    return { ...step, runtimeContext: { seen: [...seen, step.turnId] } };
  },
};
```

A `prepareStep` that returns a different object changes it for the rest of the turn, exactly like `toolsContext`; the next turn starts again from `config.runtimeContext`. Treat the value as immutable and publish a new one instead of mutating in place.

### Ending the turn from a step

Turn termination is a step-level plugin decision, not a tool flag: `onStepFinish` runs once per step, after the joined messages are persisted, and receives `{ turnId, stepNumber, result }` where `result` is that step's messages. Return `{ continue: false }` when the step means the turn is over — typically a successful send — and return nothing so the model gets another step, typically after a failure it can fix:

```ts
const stopper: AgentPlugin = {
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
```

The first plugin to return a decision owns it; the rest still observe the same step. A plugin that throws is treated as having no opinion.

Plugins can also intercept calls before they run: `beforeToolCall` may `allow`, `block` (with a reason), or `replace` the arguments, and `afterToolCall` can rewrite the result. Conflicting tool names across sources throw `ToolConflictError` at assembly.

Tool events: `tool.start`, `tool.done`, `tool.failed`, `tool.blocked`, and `tool.result_repaired` — emitted for a tool call core had to fill a result in for, which happens when a stored history is missing one.

## Plugins

A plugin extends the agent through small, optional hooks:

```ts
import type { AgentPlugin } from "@yesimagent/core";

const memory: AgentPlugin = {
  name: "memory",
  enforce: "pre",                    // ordering: "pre" → registration order → "post"
  init(agent) { /* wire up */ },
  stop() { /* tear down */ },
  extendInstructions: () => "Recall relevant memories before answering.",
  extendTools: () => ({ memory_search: /* ... */ }),
};
```

The hook families:

| Hooks                                                 | Run                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `init` / `stop`                                       | Agent lifecycle. `init` failures roll back already-initialized plugins.                               |
| `extendInstructions` / `extendTools`                  | Prompt assembly; each contributes a paragraph / a tool set. Run once per turn, before its first step. |
| `onAppend` / `transformEntries` / `transformMessages` | History pipeline, chained in plugin order; each hook's return feeds the next plugin.                  |
| `toModelMessages`                                     | Projects custom messages into model messages; first non-`undefined` wins.                             |
| `prepareStep`                                         | Rewrites the step (messages, toolsContext, toolChoice, activeTools, settings) before the model call.  |
| `beforeToolCall` / `afterToolCall`                    | Tool decisions and result transformation, including whether the result ends the turn.                 |
| `onTurnFinish`                                        | Observer after a turn completes; must not change the result.                                          |

Assembly runs once per turn, before its first step, so a plugin whose instructions or tools change owns that change: compute them once, hand back the cache from `extendInstructions` / `extendTools`, and refresh the cache when your own trigger fires. The agent itself has no refresh entry point, and a tool name contributed twice at the same assembly is a `ToolConflictError`.

## State

`agent.state` is a plain object plugins and instructions can read and write. `AgentCustomState` is the extension point — declare-merge your fields into it. State changes are serialized and appended to storage as `state` entries; on init, the latest one is restored, falling back to `initialState`.

```ts
declare module "@yesimagent/core" {
  interface AgentCustomState {
    userName?: string;
  }
}

agent.state.update({ userName: "Alice" }); // also: set(valueOrFn), get()
```

## Channel

`agent.channel` is a tiny typed pub-sub (`subscribe` / `emit`) for anything that wants to observe or talk to the agent outside the turn loop — UIs, bridges, tests. The agent itself emits its lifecycle on the `"agent"` channel; listener errors are swallowed so they cannot affect the loop.

## Errors

| Error               | Meaning                                                |
| ------------------- | ------------------------------------------------------ |
| `AgentBusyError`    | `send` with `ifBusy: "reject"` while a turn is active. |
| `ToolConflictError` | Two sources registered the same tool name.             |
| `AgentRuntimeError` | Base class for both.                                   |

## License

[MIT](../../LICENSE)
