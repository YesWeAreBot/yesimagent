import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "../src/errors.js";
import { createGateway } from "../src/gateway.js";
import type { Gateway, GatewayConfig } from "../src/types.js";
import { mockProvider } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const MODELS = ["a", "b", "c"];

function build(groups: GatewayConfig["groups"]): Gateway {
  const mocked = mockProvider({ language: MODELS });
  return createGateway({
    config: { providers: { mock: { api: "mock", apiKey: "sk", models: MODELS.map((id) => ({ id })) } }, groups },
    apis: { mock: () => mocked.provider },
  });
}

const ids = (candidates: ReadonlyArray<{ id: string }>): string[] => candidates.map((candidate) => candidate.id);

describe("group candidates", () => {
  it("returns every member in order, with its metadata and breaker feedback", () => {
    const gateway = build({ main: { models: ["mock:a", "mock:b", "mock:c"] } });

    const candidates = gateway.group("main").candidates();
    expect(ids(candidates)).toEqual(["mock:a", "mock:b", "mock:c"]);
    expect(candidates[0].model.modelId).toBe("a");
    expect(() => candidates[0].failure()).not.toThrow();
    expect(() => candidates[0].success()).not.toThrow();
  });

  it("hides a member whose breaker is open, and offers it again after the cooldown", () => {
    vi.useFakeTimers();
    const gateway = build({ main: { models: ["mock:a", "mock:b"], circuitBreaker: { failureThreshold: 2, cooldownSeconds: 60 } } });
    const group = gateway.group("main");

    group.candidates()[0].failure();
    expect(ids(group.candidates())).toEqual(["mock:a", "mock:b"]);

    group.candidates()[0].failure();
    expect(group.status()).toMatchObject({ "mock:a": { state: "open", failures: 2 } });
    expect(ids(group.candidates())).toEqual(["mock:b"]);

    vi.advanceTimersByTime(60_000);
    expect(group.status()["mock:a"].state).toBe("half-open");
    expect(ids(group.candidates())).toEqual(["mock:a", "mock:b"]);
  });

  it("closes a breaker on success and on reset", () => {
    const gateway = build({ main: { models: ["mock:a", "mock:b"], circuitBreaker: { failureThreshold: 1, cooldownSeconds: 600 } } });
    const group = gateway.group("main");

    const first = group.candidates()[0];
    first.failure();
    expect(group.status()["mock:a"].state).toBe("open");

    first.success();
    expect(group.status()["mock:a"]).toEqual({ state: "closed", failures: 0 });

    group.candidates()[0].failure();
    group.reset();
    expect(Object.values(group.status()).every((status) => status.state === "closed")).toBe(true);
  });

  it("offers every member again once all breakers are open", () => {
    const gateway = build({ main: { models: ["mock:a", "mock:b"], circuitBreaker: { failureThreshold: 1, cooldownSeconds: 600 } } });
    const group = gateway.group("main");

    for (const candidate of group.candidates()) candidate.failure();
    expect(Object.values(group.status()).every((status) => status.state === "open")).toBe(true);

    expect(ids(group.candidates())).toEqual(["mock:a", "mock:b"]);
  });

  it("fails at construction when a member cannot be resolved", () => {
    expect(() => build({ main: { models: ["ghost:a"] } })).toThrow(/Unknown provider "ghost"/);
    expect(() => build({ main: { models: ["typo"] } })).toThrow(GatewayError);
    expect(() => build({ main: { models: ["mock:absent"] } })).toThrow(/does not declare "absent"/);
    expect(() => build({ main: { models: ["mock:vectors"] } })).toThrow(GatewayError);
  });

  it("rotates the head on every call under round-robin", () => {
    const gateway = build({ rotating: { strategy: "round-robin", models: ["mock:a", "mock:b", "mock:c"] } });
    const group = gateway.group("rotating");

    expect(ids(group.candidates())).toEqual(["mock:a", "mock:b", "mock:c"]);
    expect(ids(group.candidates())).toEqual(["mock:b", "mock:c", "mock:a"]);
    expect(ids(group.candidates())).toEqual(["mock:c", "mock:a", "mock:b"]);
    expect(ids(group.candidates())).toEqual(["mock:a", "mock:b", "mock:c"]);
  });

  it("returns every member under random, in some order", () => {
    const gateway = build({ lucky: { strategy: "random", models: ["mock:a", "mock:b", "mock:c"] } });
    const group = gateway.group("lucky");

    expect(group.strategy).toBe("random");
    for (let round = 0; round < 10; round++) {
      expect(ids(group.candidates()).sort()).toEqual(["mock:a", "mock:b", "mock:c"]);
    }
  });

  it("keeps the breaker state of each member out of the others' way", () => {
    const gateway = build({ main: { models: ["mock:a", "mock:b"], circuitBreaker: { failureThreshold: 1, cooldownSeconds: 600 } } });
    const group = gateway.group("main");

    group.candidates()[0].failure();

    expect(group.status()).toEqual({
      "mock:a": { state: "open", failures: 1 },
      "mock:b": { state: "closed", failures: 0 },
    });
  });
});
