import { describe, expect, it } from "vitest";

import { GatewayError } from "../src/errors.js";
import { createGateway } from "../src/gateway.js";
import type { Gateway, GatewayConfig, GatewayOptions } from "../src/types.js";
import { mockProvider, openProvider, recordingApi } from "./helpers.js";

const LANGUAGE = ["main", "turbo", "slow"];

function build(config: GatewayConfig, extra: Omit<Partial<GatewayOptions>, "config"> = {}): Gateway {
  const mocked = mockProvider({ language: LANGUAGE, embedding: ["vectors"] });
  return createGateway({
    config,
    apis: { mock: () => mocked.provider, ...extra.apis },
    ...extra,
  });
}

const config = (): GatewayConfig => ({
  providers: {
    mock: {
      api: "mock",
      apiKey: "sk-test",
      models: [{ id: "main" }, { id: "turbo" }, { id: "slow" }, { id: "vectors", type: "embedding" }],
    },
  },
  groups: {
    fallbacks: { strategy: "failover", models: ["mock:main", "mock:turbo", "mock:slow"], circuitBreaker: { failureThreshold: 2, cooldownSeconds: 60 } },
  },
});

describe("gateway resolution", () => {
  it("resolves a reference to the model the provider serves", () => {
    const gateway = build(config());

    expect(gateway.languageModel("mock:main").modelId).toBe("main");
    expect(gateway.embeddingModel("mock:vectors").modelId).toBe("vectors");
  });

  it("refuses a model that is not the modality the caller asked for", () => {
    const gateway = build(config());

    expect(() => gateway.languageModel("mock:vectors")).toThrow(/declared as embedding, not language/);
    expect(() => gateway.embeddingModel("mock:main")).toThrow(/declared as language, not embedding/);
  });

  it("reports the mistakes a caller can make", () => {
    const gateway = build(config());

    expect(() => gateway.languageModel("ghost:a")).toThrow(/Unknown provider "ghost"/);
    expect(() => gateway.languageModel("typo")).toThrow(/is not a "provider:model" reference/);
    expect(() => gateway.languageModel("mock:absent")).toThrow(/does not declare "absent"/);
    expect(() => gateway.group("nope")).toThrow(/Unknown model group "nope" \(declared: fallbacks\)/);
  });

  it("refuses a modality the provider does not serve", () => {
    const gateway = build(
      { providers: { open: { api: "open", apiKey: "sk", models: [{ id: "any", type: "speech" }] } } },
      { apis: { open: () => openProvider() } },
    );

    expect(() => gateway.speechModel("open:any")).toThrow(/Provider "open" serves no speechModel/);
  });
});

describe("gateway catalog", () => {
  it("lists what each provider declares, and narrows by modality", () => {
    const gateway = build(config());

    expect(gateway.providers()).toEqual(["mock"]);
    expect(gateway.models().map((model) => model.id)).toEqual(["mock:main", "mock:turbo", "mock:slow", "mock:vectors"]);
    expect(gateway.models("embedding").map((model) => model.id)).toEqual(["mock:vectors"]);
    expect(gateway.model("mock:main")?.metadata).toEqual({});
  });

  it("keeps declared metadata and the declared type", () => {
    const gateway = build({
      providers: {
        relay: {
          api: "mock",
          apiKey: "sk",
          models: [
            { id: "m", metadata: { name: "M", contextWindow: 262144 } },
            { id: "pic", type: "image" },
          ],
        },
      },
    });

    expect(gateway.model("relay:m")?.metadata).toEqual({ name: "M", contextWindow: 262144 });
    expect(gateway.models("image").map((model) => model.id)).toEqual(["relay:pic"]);
  });

  it("keeps the last entry of a repeated id", () => {
    const gateway = build(
      {
        providers: {
          relay: { api: "mock", apiKey: "sk", models: [{ id: "a" }, { id: "b", type: "embedding" }, { id: "a", metadata: { name: "second" } }] },
        },
      },
      { apis: { mock: () => openProvider() } },
    );

    expect(gateway.models().map((model) => [model.id, model.type])).toEqual([
      ["relay:a", "language"],
      ["relay:b", "embedding"],
    ]);
    expect(gateway.model("relay:a")?.metadata).toEqual({ name: "second" });
  });
});

const injectedFetch = async () => new Response("{}");

describe("gateway providers", () => {
  it("expands ${NAME} in the credential and the headers", () => {
    const recorded = recordingApi(mockProvider({ language: ["m"] }));

    createGateway({
      config: {
        providers: {
          relay: { api: "probe", apiKey: "${RELAY_KEY}", headers: { "x-team": "${TEAM}", "x-fixed": "yes" }, models: [{ id: "m" }] },
        },
      },
      apis: { probe: recorded.api },
      env: { RELAY_KEY: "sk-live", TEAM: "platform" },
    });

    expect(recorded.setups[0].apiKey).toBe("sk-live");
    expect(recorded.setups[0].headers).toEqual({ "x-team": "platform", "x-fixed": "yes" });
  });

  it("fails on an unset environment variable", () => {
    expect(() =>
      build({
        providers: { relay: { api: "mock", apiKey: "${ABSENT}", models: [{ id: "m" }] } },
      }),
    ).toThrow(GatewayError);
    expect(() =>
      build({
        providers: { relay: { api: "mock", apiKey: "sk", headers: { "x-team": "${ALSO_ABSENT}" }, models: [{ id: "m" }] } },
      }),
    ).toThrow(/providers\.relay\.headers\.x-team: environment variable "ALSO_ABSENT" is not set/);
  });

  it("fails when a provider declares no credential", () => {
    expect(() =>
      build({
        // The cast keeps the missing-key case typeable: the runtime check must exist regardless.
        providers: { relay: { api: "mock", apiKey: undefined as unknown as string, models: [{ id: "m" }] } },
      }),
    ).toThrow(/providers\.relay: apiKey is required/);
  });

  it("hands the api factory the resolved endpoint, credential and transport", () => {
    const recorded = recordingApi(mockProvider({ language: ["m"] }));

    const gateway = createGateway({
      config: {
        providers: {
          relay: {
            api: "probe",
            baseUrl: "https://relay.test/v1",
            apiKey: "${RELAY_KEY}",
            headers: { "x-team": "${TEAM}" },
            settings: { authToken: "tok" },
            models: [{ id: "m" }],
          },
          local: { api: "probe", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "local-key", models: [{ id: "m" }] },
        },
      },
      apis: { probe: recorded.api },
      env: { RELAY_KEY: "sk-live", TEAM: "platform" },
      fetch: injectedFetch as typeof globalThis.fetch,
    });

    expect(recorded.setups.map((setup) => [setup.id, setup.baseUrl, setup.apiKey])).toEqual([
      ["relay", "https://relay.test/v1", "sk-live"],
      ["local", "http://127.0.0.1:8080/v1", "local-key"],
    ]);
    expect(recorded.setups[0].headers).toEqual({ "x-team": "platform" });
    expect(recorded.setups[0].settings).toEqual({ authToken: "tok" });
    expect(recorded.setups[0].fetch).toBe(injectedFetch);
    expect(gateway.languageModel("relay:m").modelId).toBe("m");
  });

  it("connects a provider whose api is registered through defineApi", () => {
    const gateway = createGateway({ config: {} });
    gateway.defineApi("later", () => mockProvider({ language: ["m"] }).provider);

    gateway.reconfigure({ providers: { relay: { api: "later", apiKey: "sk", models: [{ id: "m" }] } } });

    expect(gateway.providers()).toEqual(["relay"]);
    expect(gateway.languageModel("relay:m").modelId).toBe("m");
  });

  it("fails when an api is unknown or a factory throws", () => {
    expect(() => build({ providers: { unknown: { api: "nope", apiKey: "sk" } } })).toThrow(/providers\.unknown: unknown api "nope"/);

    expect(() =>
      createGateway({
        config: { providers: { broken: { api: "probe", apiKey: "sk" } } },
        apis: {
          probe: () => {
            throw new Error("bad credentials");
          },
        },
      }),
    ).toThrow(/providers\.broken \(api: probe\) could not be built: Error: bad credentials/);
  });

  it("hands back the provider instance an endpoint was built from", () => {
    const mocked = mockProvider({ language: ["a"] });
    const gateway = createGateway({
      config: { providers: { mine: { api: "probe", apiKey: "sk", models: [{ id: "a" }] } } },
      apis: { probe: () => mocked.provider },
    });

    expect(gateway.provider("mine")).toBe(mocked.provider);
    expect(gateway.provider("nope")).toBeUndefined();
  });

  it("refuses a duplicated api, and releases it again", () => {
    const gateway = createGateway({ config: {} });

    expect(gateway.apis).toContain("openai-completions");
    expect(() => gateway.defineApi("openai-completions", () => mockProvider().provider)).toThrow(/already registered/);

    const dispose = gateway.defineApi("probe", () => mockProvider().provider);
    expect(gateway.apis).toContain("probe");
    dispose();
    expect(gateway.apis).not.toContain("probe");
  });
});

describe("gateway reconfigure", () => {
  it("replaces everything the previous configuration declared", () => {
    const gateway = build(config());
    expect(gateway.models()).toHaveLength(4);

    gateway.reconfigure({ providers: { mock: { api: "mock", apiKey: "sk-test", models: [{ id: "turbo" }] } } });

    expect(gateway.providers()).toEqual(["mock"]);
    expect(gateway.models().map((model) => model.id)).toEqual(["mock:turbo"]);
    expect(gateway.languageModel("mock:turbo").modelId).toBe("turbo");
    expect(() => gateway.group("fallbacks")).toThrow(/Unknown model group "fallbacks"/);
  });

  it("rebuilds groups with the new configuration", () => {
    const gateway = build(config());

    gateway.reconfigure({
      providers: config().providers,
      groups: { rotated: { strategy: "round-robin", models: ["mock:slow"] } },
    });

    expect(gateway.groups()).toEqual(["rotated"]);
    expect(
      gateway
        .group("rotated")
        .candidates()
        .map((candidate) => candidate.id),
    ).toEqual(["mock:slow"]);
  });
});
