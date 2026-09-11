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
  tools?: AgentToolSet; // see Tools
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

| Method               | Purpose                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `init()`             | Runs plugin `init` hooks and assembles the prompt; lazy on first turn.          |
| `stop()`             | Interrupts the active turn, stops plugins in reverse order.                     |
| `fresh()`            | Re-runs plugin `extendInstructions` / `extendTools` and reassembles the prompt. |
| `wait(options?)`     | Resolves when the agent is idle; rejects if the optional signal aborts.         |
| `interrupt(reason?)` | Aborts the active turn and everything queued.                                   |
| `clear()`            | Clears storage.                                                                 |
| `setModel(model)`    | Swaps the model; takes effect on the next step.                                 |

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

A turn is one pass through the queue: `turn.start` → steps → `turn.done` / `turn.failed` / `turn.aborted`. Each step calls the model once, executes the tool calls it produced, and continues (up to `maxSteps`) while tool calls remain — or until every tool call came from a `terminal` tool, which ends the turn even though tool calls were made.

Turn events:

| Event          | Emitted when                                                       |
| -------------- | ------------------------------------------------------------------ |
| `turn.queued`  | A message was deferred behind an active turn.                      |
| `turn.start`   | The turn begins.                                                   |
| `turn.step`    | A step finished, with that step's `usage` and `finishReason`.      |
| `turn.done`    | The turn finished; accumulated `usage` included.                   |
| `turn.failed`  | The model or a tool threw; `error` is `{ name, message, cause? }`. |
| `turn.aborted` | The turn was interrupted.                                          |

## Tools

Tools are AI SDK tools with one extension — `terminal`:

```ts
import { tool } from "ai";
import { z } from "zod";

const tools = {
  check_phone: tool({
    description: "Look at the phone.",
    inputSchema: z.object({}),
    execute: (input, { abortSignal }) => checkPhone({ abortSignal }),
    // A terminal tool ends the turn after it runs, instead of looping another model step.
    terminal: true,
  }),
};
```

Tool executions receive an `AgentToolRuntime` (agent id, channel, state, storage, turn id, signal, messages), so a tool can act on the agent it runs in. Plugins can intercept every call: `beforeToolCall` may `allow`, `block` (with a reason), or `replace` the arguments; `afterToolCall` can transform results. Conflicting tool names across sources throw `ToolConflictError` at assembly.

Tool events: `tool.start`, `tool.done`, `tool.failed`, `tool.blocked`.

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

| Hooks                                                 | Run                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `init` / `stop`                                       | Agent lifecycle. `init` failures roll back already-initialized plugins.              |
| `extendInstructions` / `extendTools`                  | Prompt assembly; each contributes a paragraph / a tool set.                          |
| `onAppend` / `transformEntries` / `transformMessages` | History pipeline, chained in plugin order; each hook's return feeds the next plugin. |
| `toModelMessages`                                     | Projects custom messages into model messages; first non-`undefined` wins.            |
| `prepareStep`                                         | Rewrites the step (messages, turnId, signal) before the model call.                  |
| `beforeToolCall` / `afterToolCall`                    | Tool decisions and result transformation.                                            |
| `onTurnFinish`                                        | Observer after a turn completes; must not change the result.                         |

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
