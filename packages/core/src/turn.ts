import type { LanguageModelUsage } from "ai";

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
  /** `persist` runs at the step boundary, not at the call site — see `drainJoined`. */
  addJoined(messages: AgentMessage[], persist?: () => Promise<void>): void;
  drainJoined(): Promise<AgentMessage[]>;
}

export interface TurnStepResult {
  messages: AgentMessage[];
  usage?: Partial<LanguageModelUsage>;
  finishReason?: string;
  continue: boolean;
}

export interface TurnQueueOptions {
  maxSteps: number;
  runStep(request: TurnRequest, stepNumber: number, messages: AgentMessage[], allMessages: readonly AgentMessage[]): Promise<TurnStepResult>;
  emit(event: AgentEvent): Promise<void>;
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
    return this.active?.request.turnId;
  }

  isIdle(): boolean {
    return this.active === undefined && this.queue.length === 0 && !this.pumping;
  }

  enqueue(messages: AgentMessage[], behavior: BusyBehavior = "defer", persistence?: () => Promise<void>): string {
    if (this.active && behavior === "reject") throw new AgentBusyError();

    if (this.active && behavior === "join") {
      this.active.request.addJoined(messages, persistence);
      return this.active.request.turnId;
    }

    const turn = createQueuedTurn(messages);
    if (persistence) turn.request.addJoined([], persistence);
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

    try {
      await this.options.emit({ type: "turn.start", turnId: request.turnId });
      let stepNumber = 0;
      let incoming = request.messages.splice(0, request.messages.length);

      while (stepNumber < this.options.maxSteps) {
        throwIfAborted(request.signal);
        const result = await this.options.runStep(request, stepNumber, incoming, allMessages);
        allMessages.push(...result.messages);
        usage = addUsage(usage, result.usage);
        await this.options.emit({ type: "turn.step", turnId: request.turnId, stepNumber, usage: result.usage, finishReason: result.finishReason });

        const drained = await request.drainJoined();
        if (!result.continue) break;
        stepNumber += 1;
        incoming = drained;
        allMessages.push(...drained);
      }

      throwIfAborted(request.signal);
      if (request.signal.aborted) status = "aborted";
      await this.options.emit({ type: "turn.done", turnId: request.turnId, usage });
    } catch (error) {
      status = isAbortError(error) || request.signal.aborted ? "aborted" : "failed";
      turnError = serializeError(error);
      await this.options.emit(
        status === "aborted"
          ? { type: "turn.aborted", turnId: request.turnId, reason: turnError.message }
          : { type: "turn.failed", turnId: request.turnId, error: turnError },
      );
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
  const joined: AgentMessage[] = [];
  const pending: Array<() => Promise<void>> = [];
  const request: TurnRequest = {
    turnId: crypto.randomUUID(),
    submittedAt: Date.now(),
    messages: [...messages],
    signal: controller.signal,
    addJoined(nextMessages, persist) {
      joined.push(...nextMessages);
      if (persist) pending.push(persist);
    },
    async drainJoined() {
      await Promise.all(pending.splice(0).map((run) => run()));
      return joined.splice(0);
    },
  };
  return { request, controller };
}

function addUsage(previous: Partial<LanguageModelUsage> | undefined, next: Partial<LanguageModelUsage> | undefined): Partial<LanguageModelUsage> | undefined {
  if (!previous && !next) return undefined;
  const result: Partial<LanguageModelUsage> = { ...previous, ...next };
  const keys = ["inputTokens", "outputTokens", "totalTokens"] as const;
  for (const key of keys) {
    const left = previous?.[key];
    const right = next?.[key];
    if (typeof left === "number" || typeof right === "number") result[key] = (left ?? 0) + (right ?? 0);
  }
  return result;
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
