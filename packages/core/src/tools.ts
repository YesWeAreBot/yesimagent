import type { Tool, ToolExecutionOptions } from "ai";

import { AgentRuntimeError } from "./errors.js";
import type { AgentEvent } from "./event.js";
import type { Awaitable } from "./plugin.js";

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

/** What one step's tool calls run against: the plugins' hooks, the turn's events, and its abort signal. */
export interface ToolCallRuntime {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: AgentEvent) => Awaitable<void>;
  readonly beforeToolCall?: (decision: ToolDecision, call: ToolCallInfo) => Awaitable<ToolDecision>;
  readonly afterToolCall?: (result: ToolResultInfo) => Awaitable<ToolResultInfo>;
}

/**
 * Runs one wrapped tool call: the plugins' decision and result hooks, the `tool.*` events, then the tool
 * itself. Execution stays with the AI SDK around this call — it validates input and context, resolves
 * description functions, applies `toModelOutput`, and turns a throw into an `error-text` result.
 *
 * A tool with no `execute` keeps the same behaviour: the call records an error result and the step goes on.
 */
export async function runTool(
  name: string,
  tool: Tool | undefined,
  input: unknown,
  options: ToolExecutionOptions<unknown>,
  runtime: ToolCallRuntime,
): Promise<unknown> {
  const toolCallId = options.toolCallId;
  if (tool?.execute === undefined) {
    const error = new AgentRuntimeError(`Tool "${name}" has no execute function`);
    await runtime.emit({ type: "tool.failed", turnId: runtime.turnId, toolName: name, toolCallId, args: input, error: serializeError(error) });
    throw error;
  }
  const execute = tool.execute;

  const call = { toolCallId, toolName: name, args: input };
  const decision = (await runtime.beforeToolCall?.({ type: "allow" }, call)) ?? { type: "allow" };
  if (decision.type === "block") {
    await runtime.emit({ type: "tool.blocked", turnId: runtime.turnId, toolName: name, toolCallId, reason: decision.reason });
    return { blocked: true, reason: decision.reason };
  }

  const nextInput = decision.type === "replace" ? decision.args : input;
  await runtime.emit({ type: "tool.start", turnId: runtime.turnId, toolName: name, toolCallId, args: nextInput });

  let outcome: ToolResultInfo;
  try {
    const result = await raceAbort(Promise.resolve(execute.call(tool, nextInput, options)), runtime.signal);
    outcome = { toolCallId, toolName: name, args: nextInput, result, isError: false };
  } catch (error) {
    // An aborted turn is not a tool error: it must keep travelling as an abort.
    if (runtime.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    outcome = { toolCallId, toolName: name, args: nextInput, result: error, isError: true };
  }

  const transformed = (await runtime.afterToolCall?.(outcome)) ?? outcome;
  if (outcome.isError) {
    await runtime.emit({
      type: "tool.failed",
      turnId: runtime.turnId,
      toolName: name,
      toolCallId,
      args: nextInput,
      error: serializeError(transformed.result),
    });
  } else {
    await runtime.emit({ type: "tool.done", turnId: runtime.turnId, toolName: name, toolCallId, result: transformed.result });
  }

  // A throw reads back to the model as `error-text`; anything else travels as the tool's own model output.
  if (transformed.isError) throw transformed.result;
  return transformed.result;
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
