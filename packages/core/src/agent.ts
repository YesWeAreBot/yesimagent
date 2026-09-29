import { experimental_getToolCaller as getToolCaller } from "@ai-sdk/provider-utils";
import {
  experimental_toolCaller as toolCaller,
  streamText,
  type LanguageModel,
  type LanguageModelCallOptions,
  type ModelMessage,
  type Tool,
  type ToolChoice,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";

import { AgentChannel } from "./channel.js";
import { createEntry, type AgentEntry } from "./entry.js";
import { AgentBusyError, ToolConflictError } from "./errors.js";
import type { AgentEvent } from "./event.js";
import { createAssistantMessage, createToolMessage, type AgentMessage } from "./message.js";
import { createAgentHooks, orderPlugins, type AgentPlugin, type StepOptions } from "./plugin.js";
import { AgentStateManager, type AgentState } from "./state.js";
import { createMemoryStorage, type AgentStorage } from "./storage.js";
import { runTool, type ToolCallRuntime } from "./tools.js";
import { AgentQueue, type AgentWaitOptions, type BusyBehavior, type StepFinishDecision, type TurnRequest, type TurnStepResult } from "./turn.js";

const DEFAULT_MAX_STEPS = 20;

export interface AgentSendOptions {
  ifBusy?: BusyBehavior;
  trigger?: boolean;
}

export interface AgentConfig {
  id?: string;
  model: LanguageModel;
  instructions?: string;
  tools?: ToolSet;
  /** Host state shared by every step of a turn; a `prepareStep` may replace it for the rest of the turn. */
  runtimeContext?: Record<string, unknown>;
  /** Tool context keyed by tool name; a `prepareStep` may change it for the rest of a turn. */
  toolsContext?: Record<string, unknown>;
  toolChoice?: ToolChoice<ToolSet>;
  activeTools?: readonly string[];
  /**
   * Which caller tools may invoke each tool, e.g. code mode: `{ query: ['code_mode'] }` lets a generated
   * program call `query` while hiding it from the model's own tool list. A tool with no entry keeps its
   * default direct callability, so the table only names what it takes away.
   */
  toolCallers?: ToolCallers;
  /** Model call settings applied to every step; a `prepareStep` may override them per step. */
  settings?: LanguageModelCallOptions;
  storage?: AgentStorage<AgentEntry>;
  plugins?: readonly AgentPlugin[];
  maxSteps?: number;
  initialState?: AgentState;
}

/**
 * The caller table, loosened the same way `toolsContext` is: a bare `ToolSet` declares no caller tools,
 * so the SDK's own parameter would collapse to the direct-call marker alone. Hosts build the set
 * dynamically and name their caller tools as plain strings; the SDK still validates the table itself.
 */
export type ToolCallers = Record<string, readonly string[]>;

export interface Agent {
  readonly id: string;
  readonly channel: AgentChannel;
  readonly storage: AgentStorage<AgentEntry>;
  readonly state: AgentStateManager;
  init(): Promise<void>;
  stop(): Promise<void>;
  send(message: AgentMessage, options?: AgentSendOptions): string | undefined;
  run(message: AgentMessage, options?: Omit<AgentSendOptions, "trigger">): AsyncIterable<AgentEvent>;
  wait(options?: AgentWaitOptions): Promise<void>;
  interrupt(reason?: unknown): Promise<void>;
  getModel(): LanguageModel;
  setModel(model: LanguageModel): void;
  clear(): Promise<void>;
  getActiveTurnId(): string | null;
  isIdle(): boolean;
}

export function createAgent(config: AgentConfig): Agent {
  const id = config.id ?? crypto.randomUUID();
  const channel = new AgentChannel();
  const baseStorage = config.storage ?? createMemoryStorage();
  let storageTail = Promise.resolve();
  const storage: AgentStorage<AgentEntry> = {
    append: (...entries) => {
      const operation = storageTail.then(() => baseStorage.append(...entries));
      storageTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    read: () => storageTail.then(() => baseStorage.read()),
    clear: () => {
      const operation = storageTail.then(() => baseStorage.clear());
      storageTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };

  const state = new AgentStateManager({
    initialState: structuredClone(config.initialState ?? { version: 1 }),
    onChange: (next) => storage.append(createEntry("state", structuredClone(next))),
  });
  const plugins = orderPlugins(config.plugins ?? []);
  const hooks = createAgentHooks(plugins);
  const maxSteps = Math.max(1, config.maxSteps ?? DEFAULT_MAX_STEPS);
  const submittedEntries = new WeakMap<object, AgentEntry<"message">>();
  const turnBuffers = new Map<string, AgentEvent[]>();
  const turnListeners = new Map<string, Set<(event: AgentEvent) => void>>();
  const turnRuntimeContexts = new Map<string, Record<string, unknown>>();
  const turnToolContexts = new Map<string, Record<string, unknown>>();

  let model = config.model;
  // The model-visible parts a turn assembles, each on its own: the request also carries `activeTools`,
  // `toolChoice` and `settings`, which stay step-scoped (`config` + `prepareStep`) rather than assembled.
  let instructions = config.instructions;
  let tools: ToolSet = { ...config.tools };
  let initialized = false;
  let initializing: Promise<void> | undefined;
  let stopping = false;

  let agent!: Agent;

  const emit = async (event: AgentEvent): Promise<void> => {
    if (hasTurnId(event)) {
      const buffered = turnBuffers.get(event.turnId) ?? [];
      buffered.push(event);
      turnBuffers.set(event.turnId, buffered);
      for (const listener of turnListeners.get(event.turnId) ?? []) listener(event);
    }

    if (event.type === "turn.start" || event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted") {
      await storage.append(createEntry("event", event, hasTurnId(event) ? { turnId: event.turnId } : undefined));
    }
    await channel.emit("agent", event);
  };

  const appendEntries = async (entries: AgentEntry[]): Promise<AgentEntry[]> => {
    if (entries.length === 0) return [];
    const transformed = hooks.onAppend ? await hooks.onAppend(entries) : entries;
    await storage.append(...transformed);
    for (const entry of transformed) {
      if (!isMessageEntry(entry)) continue;
      await emit({ type: "message.appended", message: entry.data });
    }
    return transformed;
  };

  const persistMessages = async (messages: readonly AgentMessage[], turnId?: string): Promise<AgentMessage[]> => {
    const fresh: AgentMessage[] = [];
    const known: AgentMessage[] = [];

    for (const message of messages) {
      const entry = typeof message === "object" && message !== null ? submittedEntries.get(message) : undefined;
      if (entry) known.push(entry.data);
      else fresh.push(message);
    }

    if (fresh.length === 0) return known;
    const entries = await appendEntries(fresh.map((message) => createEntry("message", message, turnId ? { turnId } : undefined)));
    for (const entry of entries) {
      if (!isMessageEntry(entry)) continue;
      submittedEntries.set(entry.data, entry);
      known.push(entry.data);
    }
    return known;
  };

  const collectModelMessages = async (turnId: string, signal: AbortSignal): Promise<ModelMessage[]> => {
    const rawEntries = await storage.read();
    const transformedEntries = hooks.transformEntries ? await hooks.transformEntries(rawEntries, { turnId, signal }) : rawEntries;
    const agentMessages = transformedEntries.filter((entry): entry is AgentEntry<"message"> => entry.type === "message").map((entry) => entry.data);
    const transformedMessages = hooks.transformMessages ? await hooks.transformMessages([...agentMessages], { turnId, signal }) : agentMessages;
    const modelMessages: ModelMessage[] = [];

    for (const message of transformedMessages) {
      if (message.role === "custom") {
        const projected = await hooks.toModelMessages?.(message);
        if (projected) modelMessages.push(...projected);
        continue;
      }
      modelMessages.push(toModelMessage(message));
    }
    return modelMessages;
  };

  const streamStep = async (request: TurnRequest, options: StepOptions, stepTools: ToolSet, stepMessages: ModelMessage[]) => {
    const response = streamText({
      model,
      instructions,
      messages: stepMessages,
      tools: stepTools,
      // A loose `ToolSet` types as declaring no tool context, so the SDK parameter is `never`. The map is
      // still read per tool at runtime and each entry is validated against the tool's own `contextSchema`.
      toolsContext: options.toolsContext as never,
      // Same reason as the cast above: a loose `ToolSet` types as declaring no caller tool, so the SDK
      // parameter would admit the direct-call marker only. The SDK validates every table itself.
      experimental_toolCallers: config.toolCallers as never,
      runtimeContext: options.runtimeContext,
      ...(options.activeTools === undefined ? {} : { activeTools: options.activeTools }),
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...options.settings,
      abortSignal: request.signal,
      maxRetries: 0,
    });

    // Draining the stream is what runs the step's tool calls; an `error` part has to surface as a failed turn.
    for await (const part of response.fullStream) {
      if (part.type === "error") throw part.error;
    }

    return response;
  };

  const runStep = async (request: TurnRequest, stepNumber: number, incoming: AgentMessage[]): Promise<TurnStepResult> => {
    await ensureInit();
    if (incoming.length > 0) await persistMessages(incoming, request.turnId);
    // The prompt is assembled here and nowhere else: once per turn, before the first step, so a plugin
    // that caches its own instructions and tools decides when they change — the agent holds no
    // refresh entry point.
    if (stepNumber === 0) await assemblePrompt();
    throwIfAborted(request.signal);

    const collected = await collectModelMessages(request.turnId, request.signal);
    const step: StepOptions = {
      turnId: request.turnId,
      signal: request.signal,
      stepNumber,
      messages: collected,
      runtimeContext: turnRuntimeContexts.get(request.turnId) ?? config.runtimeContext ?? {},
      toolsContext: turnToolContexts.get(request.turnId) ?? config.toolsContext ?? {},
      ...(config.toolChoice === undefined ? {} : { toolChoice: config.toolChoice }),
      ...(config.activeTools === undefined ? {} : { activeTools: config.activeTools }),
      ...(config.settings === undefined ? {} : { settings: config.settings }),
    };
    const prepared = hooks.prepareStep ? await hooks.prepareStep(step) : step;
    if (prepared.runtimeContext !== step.runtimeContext) turnRuntimeContexts.set(request.turnId, prepared.runtimeContext);
    if (prepared.toolsContext !== step.toolsContext) turnToolContexts.set(request.turnId, prepared.toolsContext);

    const messages = [...prepared.messages];
    const toolRuntime: ToolCallRuntime = {
      turnId: request.turnId,
      signal: request.signal,
      emit,
      ...(hooks.beforeToolCall === undefined ? {} : { beforeToolCall: hooks.beforeToolCall }),
      ...(hooks.afterToolCall === undefined ? {} : { afterToolCall: hooks.afterToolCall }),
    };
    // The step's tools wrap their own `execute` so the hooks and events above run inside the SDK's call,
    // while the SDK keeps ownership of validation, model output and error handling.
    // A caller tool's `experimental_toolCaller` is defined non-enumerable, so the spread below would drop
    // it and the SDK would never bind its host tools — re-attach the definition around the wrapped tool.
    // What `bind` produces is what the SDK runs in place of it, so that bound copy takes the wrap too:
    // the caller is a tool call like any other, and the host tools it was bound already carry theirs.
    const stepTools: ToolSet = {};
    const wrap = (name: string, tool: Tool): Tool => {
      const wrapped: Tool = {
        ...tool,
        execute: (input: unknown, options: ToolExecutionOptions<unknown>) => runTool(name, tool, input, options, toolRuntime),
      };
      const caller = getToolCaller(tool);
      // Only a local caller runs here; a provider caller hands the call to the provider, keeping its options.
      return caller?.type === "local" ? toolCaller(wrapped, { type: "local", bind: (host) => wrap(name, caller.bind(host)) }) : wrapped;
    };
    for (const [name, tool] of Object.entries(tools)) {
      stepTools[name] = wrap(name, tool);
    }

    const response = await streamStep(request, prepared, stepTools, messages);

    const usage = await response.usage;
    const finishReason = await response.finishReason;
    const responseMessages = await response.responseMessages;
    // An aborted step records nothing: the turn ends as aborted rather than as a half-written step.
    throwIfAborted(request.signal);
    const assistantMessages = responseMessages
      .filter((message) => message.role === "assistant")
      .map((message) =>
        createAssistantMessage(message.content, {
          usage,
          finishReason,
          providerOptions: message.providerOptions,
        }),
      );
    const returnedToolMessages = responseMessages
      .filter((message) => message.role === "tool")
      .map((message) => createToolMessage(message.content, { providerOptions: message.providerOptions }));

    // The step's messages go out in one append: a host write that lands mid-step may fall before or after
    // the step, never between an assistant call and its result — the model history only stays valid if
    // the two are adjacent.
    const outputMessages = await persistMessages([...assistantMessages, ...returnedToolMessages], request.turnId);

    const toolCalls = await response.toolCalls;

    return {
      messages: outputMessages, // step output only; joined/pending drained by runTurn
      usage,
      finishReason,
      // Default: a step with tool calls continues (all-invalid ones too, so the model can repair its input). `onStepFinish` may override.
      continue: toolCalls.length > 0,
    };
  };

  const queue = new AgentQueue({
    maxSteps,
    runStep,
    emit,
    flushMessages: async (messages, turnId) => {
      await ensureInit();
      await persistMessages(messages, turnId);
    },
    onStepFinish: async (info) => {
      let decision: StepFinishDecision | undefined;
      for (const plugin of plugins) {
        try {
          const value = await plugin.onStepFinish?.(info);
          if (value !== undefined) decision ??= value;
        } catch {
          // A step observer must not change the completed step result.
        }
      }
      return decision;
    },
    onTurnFinish: async (result) => {
      turnRuntimeContexts.delete(result.turnId);
      turnToolContexts.delete(result.turnId);
      for (const plugin of plugins) {
        try {
          await plugin.onTurnFinish?.(result);
        } catch {
          // A post-turn observer must not change the completed turn result.
        }
      }
    },
  });

  const assemblePrompt = async (): Promise<void> => {
    const instructionParts = config.instructions ? [config.instructions] : [];
    const pluginTools: ToolSet[] = [];
    for (const plugin of plugins) {
      const instructions = await plugin.extendInstructions?.();
      if (instructions) instructionParts.push(instructions);
      const extended = await plugin.extendTools?.();
      if (extended) pluginTools.push(extended);
    }

    const merged: ToolSet = { ...config.tools };
    for (const extended of pluginTools) {
      for (const [name, tool] of Object.entries(extended)) {
        if (name in merged) throw new ToolConflictError(name);
        merged[name] = tool;
      }
    }

    // Both parts land together, so a turn never reads instructions assembled against other tools.
    instructions = instructionParts.length === 0 ? undefined : instructionParts.join("\n\n");
    tools = merged;
  };

  const ensureInit = (): Promise<void> => {
    if (initialized) return Promise.resolve();
    if (initializing) return initializing;

    initializing = (async () => {
      const initializedPlugins: AgentPlugin[] = [];
      try {
        for (const plugin of plugins) {
          await plugin.init?.(agent);
          initializedPlugins.push(plugin);
        }
        initialized = true;
        await emit({ type: "agent.init" });
      } catch (error) {
        for (const plugin of initializedPlugins.reverse()) await Promise.resolve(plugin.stop?.()).catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      if (!initialized) initializing = undefined;
    });
    return initializing;
  };

  const createTurnStream = (turnId: string): AsyncIterable<AgentEvent> => {
    const pending = [...(turnBuffers.get(turnId) ?? [])];
    let closed = pending.some(isTerminalEvent);
    let resume: (() => void) | undefined;
    const push = (event: AgentEvent) => {
      pending.push(event);
      closed ||= isTerminalEvent(event);
      const notify = resume;
      resume = undefined;
      notify?.();
    };
    const listeners = turnListeners.get(turnId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(push);
    turnListeners.set(turnId, listeners);

    const cleanup = () => {
      listeners.delete(push);
      if (listeners.size === 0) turnListeners.delete(turnId);
      turnBuffers.delete(turnId);
      closed = true;
      const notify = resume;
      resume = undefined;
      notify?.();
    };

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            while (pending.length === 0) {
              if (closed) {
                cleanup();
                return { done: true, value: undefined };
              }
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
            }
            const value = pending.shift()!;
            if (closed && pending.length === 0) cleanup();
            return { done: false, value };
          },
          async return(): Promise<IteratorResult<AgentEvent>> {
            cleanup();
            return { done: true, value: undefined };
          },
        };
      },
    };
  };

  agent = {
    id,
    channel,
    storage,
    state,
    init: ensureInit,
    async stop() {
      if (stopping) return;
      stopping = true;
      try {
        await queue.interrupt("Agent stopped");
        if (!initialized) return;
        for (const plugin of [...plugins].reverse()) await plugin.stop?.();
        initialized = false;
        initializing = undefined;
        await emit({ type: "agent.stop" });
      } finally {
        stopping = false;
      }
    },
    send(message, options = {}) {
      if (stopping) throw new Error("Agent is stopping");
      const behavior = options.ifBusy ?? "defer";
      const activeTurnId = queue.activeTurnId;
      if (activeTurnId) {
        if (options.trigger === false) {
          if (behavior === "join") queue.addJoinedToActive([message]);
          else queue.addDeferredToActive([message]);
          return undefined;
        }
        if (behavior === "reject") throw new AgentBusyError();
        if (behavior === "join") {
          queue.addJoinedToActive([message]);
          return activeTurnId;
        }
      }
      if (options.trigger === false) {
        // No active turn: persist immediately since there is no boundary to batch with.
        void ensureInit().then(() => persistMessages([message]));
        return undefined;
      }

      const turnId = queue.enqueue([message], behavior);
      if (turnId !== activeTurnId) void emit({ type: "turn.queued", turnId });
      return turnId;
    },
    run(message, options = {}) {
      const turnId = this.send(message, { ...options, trigger: true });
      if (!turnId) throw new Error("A triggered turn must have a turn id");
      return createTurnStream(turnId);
    },
    wait: (options) => queue.wait(options),
    interrupt: (reason) => queue.interrupt(reason),
    getModel: () => model,
    setModel: (next) => {
      model = next;
    },
    clear: async () => {
      await storage.clear();
    },
    getActiveTurnId: () => queue.activeTurnId ?? null,
    isIdle: () => queue.isIdle(),
  };

  return agent;
}

function toModelMessage(message: Exclude<AgentMessage, { role: "custom" }>): ModelMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "system":
      return { role: "system", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content, ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }) };
    case "tool":
      return { role: "tool", content: message.content, ...(message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions }) };
    default:
      throw new Error(`Unsupported message role: ${String(message)}`);
  }
}

function isMessageEntry(entry: AgentEntry): entry is AgentEntry<"message"> {
  return entry.type === "message";
}

function hasTurnId(event: AgentEvent): event is AgentEvent & { turnId: string } {
  return "turnId" in event && typeof event.turnId === "string";
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}
