import type { LanguageModelV4 } from "@yesimagent/core";

import { CircuitBreaker } from "./circuit-breaker.js";
import type { Candidate, CircuitBreakerConfig, CircuitBreakerStatus, Group, GroupStrategy, ModelMetadata } from "./types.js";

/** A group member as the gateway resolves it, before the group binds it to its breaker. */
export interface CandidateSource {
  /** Canonical reference, `${provider}:${modelId}`. */
  readonly id: string;
  readonly model: LanguageModelV4;
  readonly metadata: ModelMetadata;
}

/** One declared member: the reference it was configured under, and what it resolves to. */
interface Member {
  readonly reference: string;
  readonly source: CandidateSource;
}

/**
 * A named set of interchangeable language models.
 *
 * The group only *selects* models — it never wraps `generateText` / `streamText`. Trying the
 * candidates in order and deciding when to stop belongs to the caller; the group orders them,
 * hides the ones whose breaker is open, and collects the success/failure reports coming back.
 */
export class ModelGroup implements Group {
  private readonly members: readonly Member[];
  private readonly breakers: Record<string, CircuitBreaker> = {};
  private cursor = 0;

  constructor(
    readonly name: string,
    readonly strategy: GroupStrategy,
    readonly models: readonly string[],
    private readonly config: Partial<CircuitBreakerConfig> | undefined,
    resolve: (reference: string) => CandidateSource,
  ) {
    // Every member must resolve now: a group is configuration, and broken configuration fails at
    // construction, not at the first call.
    this.members = models.map((reference) => ({ reference, source: resolve(reference) }));
  }

  candidates(): readonly Candidate[] {
    const ordered = this.order();
    // Every model is tripped. A mute digital being is worse than one more doomed attempt, so hand
    // back the full list and let the caller decide when to give up.
    const offered =
      ordered.some((member) => this.breaker(member.reference).state !== "open") || ordered.length === 0
        ? ordered.filter((member) => this.breaker(member.reference).state !== "open")
        : ordered;

    return offered.map((member) => ({
      id: member.source.id,
      model: member.source.model,
      metadata: member.source.metadata,
      success: () => this.breaker(member.reference).success(),
      failure: () => this.breaker(member.reference).failure(),
    }));
  }

  status(): Readonly<Record<string, CircuitBreakerStatus>> {
    const status: Record<string, CircuitBreakerStatus> = {};
    for (const member of this.members) status[member.reference] = this.breaker(member.reference).status;
    return status;
  }

  reset(): void {
    for (const member of this.members) this.breaker(member.reference).success();
  }

  private breaker(reference: string): CircuitBreaker {
    const existing = this.breakers[reference];
    if (existing) return existing;
    const created = new CircuitBreaker(this.config);
    this.breakers[reference] = created;
    return created;
  }

  private order(): readonly Member[] {
    if (this.strategy === "failover" || this.members.length === 0) return [...this.members];

    if (this.strategy === "random") {
      const shuffled = [...this.members];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
      }
      return shuffled;
    }

    const offset = this.cursor;
    this.cursor = (this.cursor + 1) % this.members.length;
    return [...this.members.slice(offset), ...this.members.slice(0, offset)];
  }
}
