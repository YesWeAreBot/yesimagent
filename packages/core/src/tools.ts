import { getErrorMessage, type JSONValue } from "@ai-sdk/provider";
import { validateTypes, type ToolResultOutput } from "@ai-sdk/provider-utils";
import type { Tool, ToolExecutionOptions, ToolSet } from "ai";

import type { AgentChannel } from "./channel.js";
import type { AgentEntry } from "./entry.js";
import { AgentRuntimeError, ToolConflictError } from "./errors.js";
import type { AgentEvent } from "./event.js";
import type { AgentMessage } from "./message.js";
import type { AgentStateManager } from "./state.js";
import type { AgentStorage } from "./storage.js";

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

export interface ToolExecutionResult {
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

export function mergeTools(...toolSets: readonly ToolSet[]): ToolSet {
  const merged: ToolSet = {};

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

/**
 * Strips `execute` so the AI SDK returns tool calls instead of running them, and resolves description
 * functions against the step's tool context — the definition handed to the model carries a string.
 */
export function toolDefinitions(tools: ToolSet, toolsContext: Record<string, unknown> = {}): ToolSet {
  const definitions: ToolSet = {};

  for (const [name, tool] of Object.entries(tools)) {
    const { execute: _execute, ...definition } = tool;
    definitions[name] = (
      typeof definition.description === "function"
        ? { ...definition, description: definition.description({ context: toolsContext[name], experimental_sandbox: undefined }) }
        : definition
    ) as Tool;
  }

  return definitions;
}

export async function executeAgentTool(
  name: string,
  tool: Tool | undefined,
  input: unknown,
  options: ToolExecutionOptions<unknown>,
  runtime: AgentToolRuntime,
): Promise<ToolExecutionResult> {
  const toolCallId = options.toolCallId;
  if (!tool?.execute) {
    const error = new AgentRuntimeError(`Tool "${name}" has no execute function`);
    await runtime.emit({ type: "tool.failed", turnId: runtime.turnId, toolName: name, toolCallId, args: input, error: serializeError(error) });
    // The call still records an error result; whether the turn continues is an `onStepFinish` decision.
    return { result: error, isError: true };
  }

  const call = { toolCallId, toolName: name, args: input };
  const decision = (await runtime.beforeToolCall?.({ type: "allow" }, call)) ?? { type: "allow" };
  if (decision.type === "block") {
    await runtime.emit({ type: "tool.blocked", turnId: runtime.turnId, toolName: name, toolCallId, reason: decision.reason });
    return { result: { blocked: true, reason: decision.reason }, isError: false };
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
    const outcome: ToolResultInfo = { toolCallId, toolName: name, args: nextInput, result, isError: false };
    const transformed = (await runtime.afterToolCall?.(outcome)) ?? outcome;
    await runtime.emit({ type: "tool.done", turnId: runtime.turnId, toolName: name, toolCallId, result: transformed.result });
    return { result: transformed.result, isError: transformed.isError };
  } catch (error) {
    // An aborted turn is not a tool error: it must keep travelling as an abort.
    if (runtime.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;

    const outcome: ToolResultInfo = { toolCallId, toolName: name, args: nextInput, result: error, isError: true };
    const transformed = (await runtime.afterToolCall?.(outcome)) ?? outcome;
    await runtime.emit({
      type: "tool.failed",
      turnId: runtime.turnId,
      toolName: name,
      toolCallId,
      args: nextInput,
      error: serializeError(transformed.result),
    });
    return { result: transformed.result, isError: transformed.isError };
  }
}

/**
 * Validates a tool's context against its `contextSchema` when it declares one; otherwise the value is
 * passed through untouched.
 */
export async function resolveToolContext(name: string, tool: Tool | undefined, provided: unknown): Promise<unknown> {
  if (!tool?.contextSchema) return provided;
  return validateTypes<unknown>({
    value: provided,
    schema: tool.contextSchema,
    context: { field: "tool context", entityName: name },
  });
}

/**
 * Converts a tool result into what the model reads: `toModelOutput` when the tool declares it, raw text
 * for strings, JSON otherwise. Errors always travel as `error-text`.
 */
export async function toolResultOutput(
  tool: Tool | undefined,
  options: { toolCallId: string; input: unknown; output: unknown; isError?: boolean },
): Promise<ToolResultOutput> {
  if (options.isError) return { type: "error-text", value: getErrorMessage(options.output) };
  if (tool?.toModelOutput) {
    return tool.toModelOutput({ toolCallId: options.toolCallId, input: options.input, output: options.output });
  }
  return typeof options.output === "string"
    ? { type: "text", value: options.output }
    : { type: "json", value: options.output === undefined ? null : (options.output as JSONValue) };
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
