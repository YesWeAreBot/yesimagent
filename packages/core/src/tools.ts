import type { Tool, ToolExecutionOptions, ToolSet } from "ai";

import type { AgentChannel } from "./channel.js";
import type { AgentEntry } from "./entry.js";
import { ToolConflictError } from "./errors.js";
import type { AgentEvent } from "./event.js";
import type { AgentMessage } from "./message.js";
import type { AgentStateManager } from "./state.js";
import type { AgentStorage } from "./storage.js";

export type AgentTool = Tool & {
  terminal?: boolean | ((input: unknown) => boolean);
};

export type AgentToolSet = Record<string, AgentTool>;

export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type ToolDecision = { type: "allow" } | { type: "block"; reason: string } | { type: "replace"; args: unknown };

export interface ToolResultInfo extends ToolCallInfo {
  result: unknown;
  isError: boolean;
}

export interface AgentToolRuntime {
  readonly agentId: string;
  readonly channel: AgentChannel;
  readonly state: AgentStateManager;
  readonly storage: AgentStorage<AgentEntry>;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly messages: readonly AgentMessage[];
  readonly beforeToolCall?: (decision: ToolDecision, call: ToolCallInfo) => Promise<ToolDecision>;
  readonly afterToolCall?: (result: ToolResultInfo) => Promise<ToolResultInfo>;
  readonly emit: (event: AgentEvent) => Promise<void>;
}

export function mergeTools(...toolSets: readonly AgentToolSet[]): AgentToolSet {
  const merged: AgentToolSet = {};

  for (const tools of toolSets) {
    for (const [name, tool] of Object.entries(tools)) {
      if (name in merged) {
        throw new ToolConflictError(name);
      }
      merged[name] = tool;
    }
  }

  return merged;
}

export function toolDefinitions(tools: AgentToolSet): ToolSet {
  const definitions: ToolSet = {};

  for (const [name, tool] of Object.entries(tools)) {
    const { execute: _execute, terminal: _terminal, ...definition } = tool;
    definitions[name] = definition as Tool;
  }

  return definitions;
}

export function isTerminalTool(tool: AgentTool, input: unknown): boolean {
  if (tool.terminal === true) return true;
  if (typeof tool.terminal !== "function") return false;

  try {
    return tool.terminal(input);
  } catch {
    return false;
  }
}

export async function executeAgentTool(
  name: string,
  tool: AgentTool,
  input: unknown,
  options: ToolExecutionOptions<unknown>,
  runtime: AgentToolRuntime,
): Promise<{ result: unknown; terminal: boolean }> {
  if (!tool.execute) {
    return { result: undefined, terminal: false };
  }

  const toolCallId = options.toolCallId;
  const call = { toolCallId, toolName: name, args: input };
  const decision = (await runtime.beforeToolCall?.({ type: "allow" }, call)) ?? { type: "allow" };
  if (decision.type === "block") {
    await runtime.emit({ type: "tool.blocked", turnId: runtime.turnId, toolName: name, toolCallId, reason: decision.reason });
    return { result: { blocked: true, reason: decision.reason }, terminal: false };
  }

  const nextInput = decision.type === "replace" ? decision.args : input;
  await runtime.emit({ type: "tool.start", turnId: runtime.turnId, toolName: name, toolCallId, args: nextInput });

  try {
    const result = await raceAbort(
      Promise.resolve(
        tool.execute(nextInput, {
          ...options,
          abortSignal: runtime.signal,
        }),
      ),
      runtime.signal,
    );
    const transformed =
      (await runtime.afterToolCall?.({ toolCallId, toolName: name, args: nextInput, result, isError: false })) ??
      ({ toolCallId, toolName: name, args: nextInput, result, isError: false } satisfies ToolResultInfo);
    await runtime.emit({ type: "tool.done", turnId: runtime.turnId, toolName: name, toolCallId, result: transformed.result });
    return { result: transformed.result, terminal: isTerminalTool(tool, nextInput) };
  } catch (error) {
    const transformed =
      (await runtime.afterToolCall?.({ toolCallId, toolName: name, args: nextInput, result: error, isError: true })) ??
      ({ toolCallId, toolName: name, args: nextInput, result: error, isError: true } satisfies ToolResultInfo);
    await runtime.emit({
      type: "tool.failed",
      turnId: runtime.turnId,
      toolName: name,
      toolCallId,
      args: nextInput,
      error: serializeError(transformed.result),
    });
    throw error;
  }
}

function serializeError(error: unknown): { name: string; message: string; cause?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause === undefined ? {} : { cause: String(error.cause) }),
    };
  }
  return { name: "Error", message: String(error) };
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
