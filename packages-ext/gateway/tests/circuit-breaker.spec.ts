import { afterEach, describe, expect, it, vi } from "vitest";

import { CircuitBreaker } from "../src/circuit-breaker.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CircuitBreaker", () => {
  it("opens after the threshold and offers a probe once the cooldown lapses", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownSeconds: 60 });

    expect(breaker.status).toEqual({ state: "closed", failures: 0 });

    breaker.failure();
    expect(breaker.status).toEqual({ state: "closed", failures: 1 });

    breaker.failure();
    expect(breaker.status).toEqual({ state: "open", failures: 2 });

    vi.advanceTimersByTime(59_999);
    expect(breaker.state).toBe("open");

    vi.advanceTimersByTime(1);
    expect(breaker.state).toBe("half-open");
  });

  it("restarts the cooldown when a probe fails, and closes on success", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownSeconds: 10 });

    breaker.failure();
    expect(breaker.state).toBe("open");

    vi.advanceTimersByTime(9_000);
    breaker.failure();
    vi.advanceTimersByTime(9_000);
    expect(breaker.state).toBe("open");

    vi.advanceTimersByTime(1_000);
    expect(breaker.state).toBe("half-open");

    breaker.success();
    expect(breaker.status).toEqual({ state: "closed", failures: 0 });
  });

  it("falls back to the shared defaults", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker();

    breaker.failure();
    breaker.failure();
    expect(breaker.status).toEqual({ state: "closed", failures: 2 });

    breaker.failure();
    expect(breaker.status).toEqual({ state: "open", failures: 3 });

    vi.advanceTimersByTime(60_000);
    expect(breaker.state).toBe("half-open");
  });

  it("refuses a threshold that would trip before anything failed", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 0, cooldownSeconds: -5 });

    expect(breaker.status).toEqual({ state: "closed", failures: 0 });

    breaker.failure();
    expect(breaker.state).toBe("half-open");
  });
});
