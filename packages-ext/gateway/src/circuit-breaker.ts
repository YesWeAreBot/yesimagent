import { DEFAULT_CIRCUIT_BREAKER, type BreakerState, type CircuitBreakerConfig, type CircuitBreakerStatus } from "./types.js";

/**
 * Failure tracker for one model in a group.
 *
 * A breaker starts `closed`: while it stays closed the model is offered as a candidate. Once
 * `failureThreshold` consecutive failures land it opens and the model is skipped, until
 * `cooldownSeconds` have passed since the most recent failure — then it turns `half-open` and is
 * offered again as a probe. A success at any point closes it; a failure while open restarts the
 * cooldown, so a model that keeps failing is not re-probed on every call.
 *
 * The state is derived from the clock on read, so nothing here has to be scheduled or disposed.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    const { failureThreshold, cooldownSeconds } = { ...DEFAULT_CIRCUIT_BREAKER, ...config };
    // A non-positive threshold would open the breaker on the first read and never close it, so it
    // cannot be taken at face value. Values are otherwise the host's business.
    this.threshold = Math.max(1, failureThreshold);
    this.cooldownMs = Math.max(0, cooldownSeconds) * 1000;
  }

  /** Current state, derived from the clock on read: `open` until the cooldown since the last failure lapses, then `half-open`. */
  get state(): BreakerState {
    if (this.failures < this.threshold) return "closed";
    return Date.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }

  get status(): CircuitBreakerStatus {
    return { state: this.state, failures: this.failures };
  }

  /** The last call succeeded: back to healthy. */
  success(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  /** The last call failed: closer to opening, or back to the start of the cooldown if already open. */
  failure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}
