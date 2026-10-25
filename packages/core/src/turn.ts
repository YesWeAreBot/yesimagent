import type { FinishReason, LanguageModelUsage } from "ai";

import { AgentBusyError } from "./errors.js";
import type { AgentEvent } from "./event.js";
import { createUserMessage, type AgentMessage } from "./message.js";

/**
 * One turn's events, buffered for its stream: a stream created by `run()` reads the replay and then
 * rides the listeners live. A turn that terminates without a stream has no reader left, so its buffer
 * is dropped there — a `send`-driven agent must not keep one buffer per finished turn.
 */
export class TurnEvents {
  private readonly buffers = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  /** Buffers the event under its turn and hands it to that turn's listeners. */
  push(event: AgentEvent): void {
    if (!hasTurnId(event)) return;

    const buffered = this.buffers.get(event.turnId) ?? [];
    buffered.push(event);
    this.buffers.set(event.turnId, buffered);
    for (const listener of this.listeners.get(event.turnId) ?? []) listener(event);

    if (isTerminalEvent(event) && !this.listeners.has(event.turnId)) this.buffers.delete(event.turnId);
  }

  /** The events a stream starting now still has to see, oldest first. */
  replay(turnId: string): AgentEvent[] {
    return [...(this.buffers.get(turnId) ?? [])];
  }

  /** Adds a live listener for one turn; the returned function removes it again. */
  subscribe(turnId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.listeners.get(turnId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.listeners.set(turnId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(turnId);
    };
  }

  /** Drops a finished turn's replay; the stream that consumed it calls this on close. */
  drop(turnId: string): void {
    this.buffers.delete(turnId);
  }
}

export function hasTurnId(event: AgentEvent): event is AgentEvent & { turnId: string } {
  return "turnId" in event && typeof event.turnId === "string";
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted";
}

export type BusyBehavior = "defer" | "join" | "reject";
export type TurnStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface TurnRequest {
  readonly turnId: string;
  readonly submittedAt: number;
  readonly messages: AgentMessage[];
  readonly signal: AbortSignal;
  /** Messages are persisted after the current step's output batch. */
  addJoined(messages: AgentMessage[]): void;
  drainJoined(): AgentMessage[];
  /** Messages are persisted after the active turn finishes. */
  addDeferred(messages: AgentMessage[]): void;
  drainDeferred(): AgentMessage[];
  isAccepting(): boolean;
  seal(): void;
}

export interface TurnStepResult {
  messages: AgentMessage[];
  usage?: Partial<LanguageModelUsage>;
  finishReason?: FinishReason;
  continue: boolean;
}

/** What a step boundary hands to plugins: the step's own result, plus where it sits in the turn. */
export interface StepFinishInfo {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly result: TurnStepResult;
}

/** A plugin's step-level decision. Omitted fields keep the core default. */
export interface StepFinishDecision {
  continue?: boolean;
}

export interface TurnQueueOptions {
  maxSteps: number;
  runStep(request: TurnRequest, stepNumber: number, messages: AgentMessage[]): Promise<TurnStepResult>;
  emit(event: AgentEvent): Promise<void>;
  /** Persists messages at a safe step or turn boundary. */
  flushMessages(messages: AgentMessage[], turnId: string): Promise<void>;
  /** Called once per step, after `drainJoined`, including the final step. The first plugin that returns a decision owns it. */
  onStepFinish?(info: StepFinishInfo): StepFinishDecision | void | Promise<StepFinishDecision | void>;
  onTurnFinish?(result: TurnResult): Promise<void> | void;
}

export interface TurnError {
  name: string;
  message: string;
  cause?: string;
  stack?: string;
}

export interface TurnResult {
  turnId: string;
  status: Exclude<TurnStatus, "queued" | "running">;
  messages: AgentMessage[];
  error?: TurnError;
  /** The turn's usage, summed across its steps; per-step numbers stay on the `turn.step` events. */
  totalUsage?: Partial<LanguageModelUsage>;
}

export interface AgentWaitOptions {
  signal?: AbortSignal;
}

interface QueuedTurn {
  request: TurnRequest;
  controller: AbortController;
  /** Marks a `continue`-requested turn: interrupt discards it even if it started while aborting. */
  wake?: boolean;
}

export class AgentQueue {
  private readonly queue: QueuedTurn[] = [];
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }>();
  private active: QueuedTurn | undefined;
  private activeDone: Promise<void> | undefined;
  private pumping = false;
  /** Set while `interrupt` tears the queue down: the pump must not start the next turn mid-discard. */
  private interrupting = false;
  /** Prompts of a `continue` requested while turns were running; an empty array still means a wake is pending. Materialized once the queue drains. */
  private pendingWake: string[] | undefined;

  constructor(private readonly options: TurnQueueOptions) {}

  get activeTurnId(): string | undefined {
    return this.active?.request.isAccepting() ? this.active.request.turnId : undefined;
  }

  isIdle(): boolean {
    return this.active === undefined && this.queue.length === 0 && !this.pumping;
  }

  addDeferredToActive(messages: AgentMessage[]): void {
    if (!this.active || !this.active.request.isAccepting()) throw new Error("No active turn to add deferred messages to");
    this.active.request.addDeferred(messages);
  }

  addJoinedToActive(messages: AgentMessage[]): void {
    if (!this.active || !this.active.request.isAccepting()) throw new Error("No active turn to add joined messages to");
    this.active.request.addJoined(messages);
  }

  enqueue(messages: AgentMessage[], behavior: BusyBehavior = "defer"): string {
    if (this.active?.request.isAccepting() && behavior === "reject") throw new AgentBusyError();

    if (this.active?.request.isAccepting() && behavior === "join") {
      this.active.request.addJoined(messages);
      return this.active.request.turnId;
    }

    const turn = createQueuedTurn(messages);
    this.queue.push(turn);
    void this.pump();
    return turn.request.turnId;
  }

  /**
   * The queue side of `agent.continue`: requests another turn. A prompt, when given, is appended as
   * the turn's opening user message; without one the turn opens on the stored history alone. Idle, it
   * enqueues that turn and returns its turn id; while turns are running or a wake is pending, the
   * request merges into the single pending slot and returns `undefined` — the wake still fires once
   * the queue drains, even after a terminal last step.
   */
  continue(prompt?: string): string | undefined {
    const prompts = prompt === undefined ? [] : [prompt];
    if (this.pendingWake) {
      this.pendingWake.push(...prompts);
      return undefined;
    }
    if (this.active || this.queue.length > 0) {
      this.pendingWake = prompts;
      return undefined;
    }
    const turn = createQueuedTurn(wakeMessages(prompts), true);
    this.queue.push(turn);
    void this.pump();
    return turn.request.turnId;
  }

  wait(options: AgentWaitOptions = {}): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.isIdle()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void } = { resolve, reject, signal };
      waiter.onAbort = () => {
        this.idleWaiters.delete(waiter);
        reject(createAbortError());
      };
      this.idleWaiters.add(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  async interrupt(reason?: unknown): Promise<void> {
    this.pendingWake = undefined;
    this.interrupting = true;
    try {
      if (this.active) {
        this.active.controller.abort(reason);
        await this.activeDone?.catch(() => undefined);
      }

      for (const turn of this.queue.splice(0)) {
        turn.controller.abort(reason);
        // A queued turn already announced itself with `turn.queued`: it needs a terminal too, or its
        // stream (and its buffered events) would wait forever.
        await this.options.emit({
          type: "turn.aborted",
          turnId: turn.request.turnId,
          ...(reason === undefined ? {} : { reason: reason instanceof Error ? reason.message : String(reason) }),
        });
      }
      // A wake materialized while aborting above may already be running; discard it too.
      if (this.active?.wake) {
        this.active.controller.abort(reason);
        await this.activeDone?.catch(() => undefined);
      }
      this.notifyIdleWaiters();
    } finally {
      this.interrupting = false;
      // Anything that raced into the queue while interrupting (a `send`) starts now.
      void this.pump();
    }
  }

  private async pump(): Promise<void> {
    if (this.active || this.pumping || this.interrupting) return;

    const next = this.queue.shift();
    if (!next) {
      this.notifyIdleWaiters();
      return;
    }

    this.pumping = true;
    this.active = next;
    let settleActive!: () => void;
    this.activeDone = new Promise<void>((resolve) => {
      settleActive = resolve;
    });

    try {
      await this.runTurn(next);
    } finally {
      this.active = undefined;
      this.pumping = false;
      this.activeDone = undefined;
      settleActive();
      // Deferred wake fires once the queue drains, even after a terminal last step.
      if (this.pendingWake && this.queue.length === 0) {
        const prompts = this.pendingWake;
        this.pendingWake = undefined;
        this.queue.push(createQueuedTurn(wakeMessages(prompts), true));
      }
      this.notifyIdleWaiters();
      void this.pump();
    }
  }

  private async runTurn(turn: QueuedTurn): Promise<void> {
    const { request } = turn;
    const allMessages = [...request.messages];
    let totalUsage: Partial<LanguageModelUsage> | undefined;
    let status: TurnResult["status"] = "done";
    let turnError: TurnError | undefined;
    const flushJoined = async (): Promise<void> => {
      while (true) {
        const joined = request.drainJoined();
        if (joined.length === 0) return;
        await this.options.flushMessages(joined, request.turnId);
        allMessages.push(...joined);
      }
    };
    const flushTurnTail = async (): Promise<void> => {
      while (true) {
        await flushJoined();
        const deferred = request.drainDeferred();
        if (deferred.length === 0) return;
        await this.options.flushMessages(deferred, request.turnId);
        allMessages.push(...deferred);
      }
    };

    try {
      await this.options.emit({ type: "turn.start", turnId: request.turnId });
      let stepNumber = 0;
      let incoming = request.messages.splice(0, request.messages.length);

      while (stepNumber < this.options.maxSteps) {
        throwIfAborted(request.signal);
        const result = await this.options.runStep(request, stepNumber, incoming);
        allMessages.push(...result.messages);

        // Joined messages land after the complete step output and are visible to the next step.
        await flushJoined();

        // The turn's total sums across steps: every step is a call of its own, prefix included.
        // Per-step numbers stay visible in the `turn.step` events.
        if (result.usage !== undefined) {
          totalUsage = totalUsage === undefined ? result.usage : addUsage(totalUsage, result.usage);
        }
        await this.options.emit({ type: "turn.step", turnId: request.turnId, stepNumber, usage: result.usage, finishReason: result.finishReason });

        const decision = await this.options.onStepFinish?.({ turnId: request.turnId, stepNumber, result });
        await flushJoined();
        if (!(decision?.continue ?? result.continue)) break;
        stepNumber += 1;
        incoming = [];
      }

      await flushTurnTail();
      request.seal();
      throwIfAborted(request.signal);
      if (request.signal.aborted) status = "aborted";
      await this.options.emit({ type: "turn.done", turnId: request.turnId, ...(totalUsage === undefined ? {} : { totalUsage }) });
    } catch (error) {
      status = isAbortError(error) || request.signal.aborted ? "aborted" : "failed";
      turnError = serializeError(error);
      try {
        await flushTurnTail();
      } catch {
        // Suppressed: turn already failed, don't mask the original error
      }
      request.seal();
      await this.options.emit(
        status === "aborted"
          ? { type: "turn.aborted", turnId: request.turnId, reason: turnError.message }
          : { type: "turn.failed", turnId: request.turnId, error: turnError },
      );
    } finally {
      request.seal();
    }

    const result: TurnResult = {
      turnId: request.turnId,
      status,
      messages: allMessages,
      ...(totalUsage === undefined ? {} : { totalUsage }),
      ...(turnError === undefined || status === "done" ? {} : { error: turnError }),
    };
    await this.options.onTurnFinish?.(result);
  }

  private notifyIdleWaiters(): void {
    if (!this.isIdle()) return;

    for (const waiter of this.idleWaiters) {
      this.idleWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }
}

function createQueuedTurn(messages: AgentMessage[], wake = false): QueuedTurn {
  const controller = new AbortController();
  const deferred: AgentMessage[] = [];
  const joined: AgentMessage[] = [];
  let accepting = true;
  const request: TurnRequest = {
    turnId: crypto.randomUUID(),
    submittedAt: Date.now(),
    messages: [...messages],
    signal: controller.signal,
    addJoined(nextMessages) {
      joined.push(...nextMessages);
    },
    drainJoined() {
      return joined.splice(0);
    },
    addDeferred(nextMessages) {
      deferred.push(...nextMessages);
    },
    drainDeferred() {
      return deferred.splice(0);
    },
    isAccepting() {
      return accepting;
    },
    seal() {
      accepting = false;
    },
  };
  const queued: QueuedTurn = { request, controller };
  if (wake) queued.wake = true;
  return queued;
}

/**
 * The opening messages of a `continue` turn: the prompts as given, several of them merged into the one
 * message a single pending wake always produced. Without a prompt there is none — the turn opens on the
 * stored history alone, so no placeholder message is ever written.
 */
function wakeMessages(prompts: string[]): AgentMessage[] {
  return prompts.length === 0 ? [] : [createUserMessage(prompts.join("; "))];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function serializeError(error: unknown): TurnError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause === undefined ? {} : { cause: String(error.cause) }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: "Error", message: String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) };
}

/** Adds two step usages field by field into a turn total; absent counts stay absent, and `raw`
 *  (per-call provider data) stays out of the sum. */
function addUsage(left: Partial<LanguageModelUsage>, right: Partial<LanguageModelUsage>): Partial<LanguageModelUsage> {
  return {
    inputTokens: addTokenCounts(left.inputTokens, right.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addTokenCounts(left.inputTokenDetails?.noCacheTokens, right.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: addTokenCounts(left.inputTokenDetails?.cacheReadTokens, right.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: addTokenCounts(left.inputTokenDetails?.cacheWriteTokens, right.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokens: addTokenCounts(left.outputTokens, right.outputTokens),
    outputTokenDetails: {
      textTokens: addTokenCounts(left.outputTokenDetails?.textTokens, right.outputTokenDetails?.textTokens),
      reasoningTokens: addTokenCounts(left.outputTokenDetails?.reasoningTokens, right.outputTokenDetails?.reasoningTokens),
    },
    totalTokens: addTokenCounts(left.totalTokens, right.totalTokens),
  };
}

function addTokenCounts(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}
