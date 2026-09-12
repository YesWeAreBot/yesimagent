import type { LanguageModelCallOptions, ModelMessage, ToolChoice, ToolSet } from "ai";

import type { Agent } from "./agent.js";
import type { AgentEntry } from "./entry.js";
import type { AgentMessage } from "./message.js";
import type { ToolCallInfo, ToolDecision, ToolResultInfo } from "./tools.js";
import type { TurnResult } from "./turn.js";

export type Awaitable<T> = T | Promise<T>;

export interface TurnOptions {
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface StepOptions extends TurnOptions {
  readonly stepNumber: number;
  readonly messages: readonly ModelMessage[];
  /**
   * Tool context keyed by tool name, validated against each tool's `contextSchema` when it declares one.
   * A `prepareStep` that returns a different map changes it for the rest of the turn.
   */
  readonly toolsContext: Record<string, unknown>;
  readonly toolChoice?: ToolChoice<ToolSet>;
  readonly activeTools?: readonly string[];
  /** Model call settings for this step only; undefined fields fall back to the agent's. */
  readonly settings?: LanguageModelCallOptions;
}

export interface AgentPlugin {
  name: string;
  enforce?: "pre" | "post";
  init?(agent: Agent): Awaitable<void>;
  stop?(): Awaitable<void>;
  extendTools?(): Awaitable<ToolSet | void>;
  extendInstructions?(): Awaitable<string | void>;
  onAppend?(entries: AgentEntry[]): Awaitable<AgentEntry[]>;
  transformEntries?(entries: readonly AgentEntry[], options: TurnOptions): Awaitable<readonly AgentEntry[]>;
  transformMessages?(messages: AgentMessage[], options: TurnOptions): Awaitable<AgentMessage[]>;
  toModelMessages?(message: AgentMessage): ModelMessage[] | undefined;
  prepareStep?(options: StepOptions): Awaitable<StepOptions>;
  beforeToolCall?(decision: ToolDecision, call: ToolCallInfo): Awaitable<ToolDecision>;
  afterToolCall?(result: ToolResultInfo): Awaitable<ToolResultInfo>;
  onTurnFinish?(result: TurnResult): Awaitable<void>;
}

export function orderPlugins(plugins: readonly AgentPlugin[]): AgentPlugin[] {
  const pre = plugins.filter((plugin) => plugin.enforce === "pre");
  const normal = plugins.filter((plugin) => plugin.enforce !== "pre" && plugin.enforce !== "post");
  const post = plugins.filter((plugin) => plugin.enforce === "post");
  return [...pre, ...normal, ...post];
}

type Hook<Arguments extends readonly unknown[], Result> = (...args: Arguments) => Awaitable<Result>;

export function chainAll<Arguments extends readonly unknown[], Result>(
  hooks: ReadonlyArray<Hook<Arguments, Result> | undefined>,
): Hook<Arguments, void> | undefined {
  const active = hooks.filter((hook): hook is Hook<Arguments, Result> => hook !== undefined);
  if (active.length === 0) return undefined;

  return async (...args) => {
    await Promise.all(active.map((hook) => hook(...args)));
  };
}

export function chainFirst<Arguments extends readonly unknown[], Result>(
  hooks: ReadonlyArray<Hook<Arguments, Result | undefined> | undefined>,
): Hook<Arguments, Result | undefined> | undefined {
  const active = hooks.filter((hook): hook is Hook<Arguments, Result | undefined> => hook !== undefined);
  if (active.length === 0) return undefined;

  return async (...args) => {
    for (const hook of active) {
      const value = await hook(...args);
      if (value !== undefined) return value;
    }
    return undefined;
  };
}

export function chainPipe<T, A extends readonly unknown[]>(
  hooks: ReadonlyArray<((value: T, ...args: A) => Awaitable<T | undefined>) | undefined>,
): ((value: T, ...args: A) => Promise<T>) | undefined {
  const active = hooks.filter((hook): hook is (value: T, ...args: A) => Awaitable<T | undefined> => hook !== undefined);
  if (active.length === 0) return undefined;

  return async (value: T, ...args: A) => {
    let current = value;
    for (const hook of active) {
      const next = await hook(current, ...args);
      if (next !== undefined) current = next;
    }
    return current;
  };
}

export interface AgentHooks {
  onAppend?: (entries: AgentEntry[]) => Promise<AgentEntry[]>;
  transformEntries?: (entries: readonly AgentEntry[], options: TurnOptions) => Promise<readonly AgentEntry[]>;
  transformMessages?: (messages: AgentMessage[], options: TurnOptions) => Promise<AgentMessage[]>;
  toModelMessages?: (message: AgentMessage) => Awaitable<ModelMessage[] | undefined>;
  prepareStep?: (options: StepOptions) => Promise<StepOptions>;
  beforeToolCall?: (decision: ToolDecision, call: ToolCallInfo) => Promise<ToolDecision>;
  afterToolCall?: (result: ToolResultInfo) => Promise<ToolResultInfo>;
}

export function createAgentHooks(plugins: readonly AgentPlugin[]): AgentHooks {
  return {
    onAppend: chainPipe<AgentEntry[], []>(plugins.map((plugin) => plugin.onAppend)),
    transformEntries: chainPipe<readonly AgentEntry[], [TurnOptions]>(plugins.map((plugin) => plugin.transformEntries)),
    transformMessages: chainPipe<AgentMessage[], [TurnOptions]>(plugins.map((plugin) => plugin.transformMessages)),
    toModelMessages: chainFirst<[AgentMessage], ModelMessage[]>(plugins.map((plugin) => plugin.toModelMessages)),
    prepareStep: chainPipe<StepOptions, []>(plugins.map((plugin) => plugin.prepareStep)),
    beforeToolCall: chainPipe<ToolDecision, [ToolCallInfo]>(plugins.map((plugin) => plugin.beforeToolCall)),
    afterToolCall: chainPipe<ToolResultInfo, []>(plugins.map((plugin) => plugin.afterToolCall)),
  };
}
