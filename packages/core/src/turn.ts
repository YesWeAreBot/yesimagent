import type { FinishReason, LanguageModelUsage } from "ai";

import { AgentBusyError } from "./errors.js";
import type { AgentEvent } from "./event.js";
import type { AgentMessage } from "./message.js";

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
  usage?: Partial<LanguageModelUsage>;
}

export interface AgentWaitOptions {
  signal?: AbortSignal;
}

interface QueuedTurn {
  request: TurnRequest;
  controller: AbortController;
}

export class AgentQueue {
  private readonly queue: QueuedTurn[] = [];
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }>();
  private active: QueuedTurn | undefined;
  private activeDone: Promise<void> | undefined;
  private pumping = false;

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
    if (this.active) {
      this.active.controller.abort(reason);
      await this.activeDone?.catch(() => undefined);
    }

    for (const turn of this.queue.splice(0)) turn.controller.abort(reason);
    this.notifyIdleWaiters();
  }

  private async pump(): Promise<void> {
    if (this.active || this.pumping) return;

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
      this.notifyIdleWaiters();
      void this.pump();
    }
  }

  private async runTurn(turn: QueuedTurn): Promise<void> {
    const { request } = turn;
    const allMessages = [...request.messages];
    let usage: Partial<LanguageModelUsage> | undefined;
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

        // The last step's usage passes through: every step re-sends the same growing prefix, so summing
        // `inputTokens` across steps would count the context once per step. Per-step numbers stay visible
        // in the `turn.step` events.
        usage = result.usage;
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
      await this.options.emit({ type: "turn.done", turnId: request.turnId, usage });
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
      ...(usage === undefined ? {} : { usage }),
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

function createQueuedTurn(messages: AgentMessage[]): QueuedTurn {
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
  return { request, controller };
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
