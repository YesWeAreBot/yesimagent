import { streamText, type LanguageModel, type ModelMessage, type ToolExecutionOptions } from "ai";

import { AgentChannel } from "./channel.js";
import { createEntry, type AgentEntry } from "./entry.js";
import type { AgentEvent } from "./event.js";
import { createAssistantMessage, createToolMessage, type AgentMessage } from "./message.js";
import { createAgentHooks, orderPlugins, type AgentPlugin } from "./plugin.js";
import { AgentStateManager, type AgentState } from "./state.js";
import { createMemoryStorage, type AgentStorage } from "./storage.js";
import { executeAgentTool, mergeTools, toolDefinitions, type AgentToolSet } from "./tools.js";
import { AgentQueue, type AgentWaitOptions, type BusyBehavior, type TurnRequest, type TurnStepResult } from "./turn.js";

const DEFAULT_MAX_STEPS = 20;

export interface AgentSendOptions {
  ifBusy?: BusyBehavior;
  trigger?: boolean;
}

export interface AgentConfig {
  id?: string;
  model: LanguageModel;
  instructions?: string;
  tools?: AgentToolSet;
  storage?: AgentStorage<AgentEntry>;
  plugins?: readonly AgentPlugin[];
  maxSteps?: number;
  initialState?: AgentState;
}

export interface Agent {
  readonly id: string;
  readonly channel: AgentChannel;
  readonly storage: AgentStorage<AgentEntry>;
  readonly state: AgentStateManager;
  init(): Promise<void>;
  stop(): Promise<void>;
  rebuild(): Promise<void>;
  fresh(): Promise<void>;
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

interface AssembledPrompt {
  instructions?: string;
  tools: AgentToolSet;
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

  let model = config.model;
  let assembled: AssembledPrompt = { instructions: config.instructions, tools: { ...config.tools } };
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

  const runStep = async (request: TurnRequest, stepNumber: number, incoming: AgentMessage[], allMessages: readonly AgentMessage[]): Promise<TurnStepResult> => {
    await ensureInit();
    if (incoming.length > 0) await persistMessages(incoming, request.turnId);
    throwIfAborted(request.signal);

    let messages = await collectModelMessages(request.turnId, request.signal);
    const prepared = hooks.prepareStep
      ? await hooks.prepareStep({ messages, turnId: request.turnId, stepNumber, signal: request.signal })
      : { messages, turnId: request.turnId, stepNumber, signal: request.signal };
    messages = [...prepared.messages];

    const response = streamText({
      model,
      instructions: assembled.instructions,
      messages,
      tools: toolDefinitions(assembled.tools),
      abortSignal: request.signal,
      maxRetries: 0,
    });

    for await (const part of response.fullStream) {
      if (part.type === "error") throw part.error;
    }

    const usage = await response.usage;
    const finishReason = await response.finishReason;
    const responseMessages = await response.responseMessages;
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

    const outputMessages: AgentMessage[] = [];
    if (assistantMessages.length > 0) {
      outputMessages.push(...(await persistMessages(assistantMessages, request.turnId)));
    }
    if (returnedToolMessages.length > 0) {
      outputMessages.push(...(await persistMessages(returnedToolMessages, request.turnId)));
    }

    const toolCalls = await response.toolCalls;
    let terminalCount = 0;
    for (const call of toolCalls) {
      if (call.invalid) continue;
      const tool = assembled.tools[call.toolName];
      if (!tool?.execute) continue;

      const executionOptions: ToolExecutionOptions<unknown> = {
        toolCallId: call.toolCallId,
        messages: [...messages],
        abortSignal: request.signal,
        context: {},
      };
      const execution = await executeAgentTool(call.toolName, tool, call.input, executionOptions, {
        agentId: id,
        channel,
        state,
        storage,
        turnId: request.turnId,
        signal: request.signal,
        messages: [...allMessages, ...outputMessages],
        beforeToolCall: hooks.beforeToolCall,
        afterToolCall: hooks.afterToolCall,
        emit,
      });
      if (execution.terminal) terminalCount += 1;
      if (execution.result !== undefined) {
        const toolMessage = createToolMessage([
          { type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: String(execution.result) } },
        ]);
        outputMessages.push(...(await persistMessages([toolMessage], request.turnId)));
      }
    }

    const validToolCalls = toolCalls.filter((call) => !call.invalid);
    const allTerminal = validToolCalls.length > 0 && terminalCount === validToolCalls.length;
    return {
      messages: outputMessages,
      usage,
      finishReason,
      continue: validToolCalls.length > 0 && !allTerminal,
    };
  };

  const queue = new AgentQueue({
    maxSteps,
    runStep,
    emit,
    onTurnFinish: async (result) => {
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
    const pluginTools: AgentToolSet[] = [];
    for (const plugin of plugins) {
      const instructions = await plugin.extendInstructions?.();
      if (instructions) instructionParts.push(instructions);
      const tools = await plugin.extendTools?.();
      if (tools) pluginTools.push(tools);
    }
    assembled = {
      instructions: instructionParts.length === 0 ? undefined : instructionParts.join("\n\n"),
      tools: mergeTools(config.tools ?? {}, ...pluginTools),
    };
    await emit({ type: "agent.prompt_assemble" });
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
        await assemblePrompt();
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
    async rebuild() {
      await ensureInit();
      await assemblePrompt();
    },
    async fresh() {
      await this.rebuild();
    },
    send(message, options = {}) {
      if (stopping) throw new Error("Agent is stopping");
      if (options.trigger === false) {
        void ensureInit().then(() => persistMessages([message]));
        return undefined;
      }

      const behavior = options.ifBusy ?? "defer";
      const activeTurnId = queue.activeTurnId;
      if (behavior === "join" && activeTurnId) {
        const persistence = ensureInit()
          .then(() => persistMessages([message], activeTurnId))
          .then(() => undefined);
        return queue.enqueue([message], "join", persistence);
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
