# @kairou/gateway

An AI SDK model registry. Resolve a `provider:model` reference to a native AI SDK model, with failover groups and circuit breakers on top. Cordis-free — no framework, no service shell.

The gateway owns the boring part of using many providers: building AI SDK providers from configuration, expanding credentials, keeping a catalog of declared models, and offering interchangeable models through a group with health tracking. It hands out whatever the AI SDK factories return — it never wraps or reinterprets models.

- **Native models out** — every resolve returns what the AI SDK factories built. `providerOptions` keys, wire protocols, and capabilities behave exactly as the AI SDK documents them.
- **Configuration in** — a host reads its own file format (yaml, json, …) and hands the parsed shape over. The gateway only defines the shape and expands `${VAR}` references against its `env`.
- **Fail small** — bad configuration fails at construction with a `GatewayError`, not at the first call.

## Install

```sh
npm add @kairou/gateway
```

## Quickstart

```ts
import { createGateway } from "@kairou/gateway";

const gateway = createGateway({
  config: {
    providers: {
      relay: {
        api: "openai-completions",
        baseUrl: "https://relay.example.com/v1",
        apiKey: "${RELAY_KEY}",
        models: [{ id: "main", metadata: { name: "Main", contextWindow: 262144 } }],
      },
    },
    groups: {
      fast: { strategy: "failover", models: ["relay:main"], circuitBreaker: { failureThreshold: 2, cooldownSeconds: 60 } },
    },
  },
});

const model = gateway.languageModel("relay:main");
const [candidate] = gateway.group("fast").candidates();
```

`apiKey: "${RELAY_KEY}"` is read from `process.env` when the gateway is built; an unset variable fails construction with the variable named.

## Configuration

A `GatewayConfig` has two sections, both optional:

```ts
interface GatewayConfig {
  providers?: Record<string, ProviderConfig>;
  groups?: Record<string, GroupConfig>;
}
```

### Providers

Each entry in `providers` builds one AI SDK provider through a registered api.

```ts
interface ProviderConfig {
  api: string; // which ApiFactory builds it, see the table below
  apiKey: string; // required; ${NAME} reads it from the gateway's env
  baseUrl?: string; // omitted means the api's own default endpoint
  headers?: Record<string, string>; // values may use ${NAME} the same way
  settings?: Record<string, unknown>; // spread verbatim into the AI SDK factory
  models?: ModelConfig[]; // what this endpoint serves
}

interface ModelConfig {
  id: string; // model id as the provider knows it, e.g. "gpt-5.1"
  type?: ModelType; // defaults to "language"
  metadata?: ModelMetadata; // name, toolCall, reasoning, input, contextWindow, maxTokens
}
```

Everything a model needs is in the configuration: the catalog is built once from `models` at load time, and `gateway.model("relay:main")` looks it up. There is no discovery, no background refresh, no derived state to invalidate — `reconfigure()` replaces the whole picture.

### Groups

A group is a named set of interchangeable language models:

```ts
interface GroupConfig {
  strategy?: "failover" | "round-robin" | "random"; // defaults to "failover"
  models: string[]; // "provider:model" references
  circuitBreaker?: Partial<CircuitBreakerConfig>; // defaults: 3 failures / 60s cooldown
}
```

`gateway.group("fast").candidates()` returns the members in the strategy's order, skipping models whose breaker is open. Each candidate carries `success()` / `failure()` feedback into the group's breakers. When every breaker is open, the full list is offered anyway — a mute bot is worse than one more doomed attempt.

Every member must resolve when the gateway is built. A group with a typo in it fails at construction, with the reference named.

## Apis

The `api` key selects the factory that builds the provider. Four are built in (`builtinApis` is exported, so a host can inspect or spread it):

| api                    | Factory                     | Wire                                                                             |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `openai-completions`   | `@ai-sdk/openai-compatible` | `/chat/completions`; every endpoint reports its own `id.chat` provider namespace |
| `openai-responses`     | `@ai-sdk/openai`            | OpenAI Responses API                                                             |
| `anthropic-messages`   | `@ai-sdk/anthropic`         | Anthropic Messages                                                               |
| `google-generative-ai` | `@ai-sdk/google`            | Gemini                                                                           |

`settings` is spread straight into the AI SDK factory, so anything the factory accepts can be passed — `authToken` for Anthropic enterprise relays, `includeUsage` for compatible endpoints, and so on. Explicit fields (`baseUrl`, `apiKey`, `headers`, the gateway's `fetch`) always win over `settings`.

### Custom apis

Anything the built-in dialects don't cover, register through `apis` — including a provider you built yourself and want to keep a typed reference to:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@kairou/gateway";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const gateway = createGateway({
  config: { providers: { openai: { api: "openai", apiKey: "unused", models: [{ id: "gpt-5.1" }] } } },
  apis: { openai: () => openai },
});

// The concrete instance is yours, so provider-native tools stay fully typed:
const tools = { web_search: openai.tools.webSearch({}) };
```

## Gateway

```ts
interface Gateway {
  defineApi(name: string, factory: ApiFactory): () => void;
  provider(id: string): ProviderV4 | undefined; // for ProviderV4 parts the gateway doesn't model
  readonly apis: readonly string[];
  reconfigure(config: GatewayConfig): void;

  languageModel(name: string): LanguageModelV4;
  embeddingModel(name: string): EmbeddingModelV4;
  imageModel(name: string): ImageModelV4;
  speechModel(name: string): SpeechModelV4;
  transcriptionModel(name: string): TranscriptionModelV4;
  rerankingModel(name: string): RerankingModelV4;
  group(name: string): Group;
  groups(): readonly string[];

  models(type?: ModelType): readonly Model[]; // the catalog, for host-side decisions
  model(name: string): Model | undefined;
  providers(): readonly string[];
}
```

- `languageModel("relay:main")` resolves and builds; a typo, a wrong modality, or an unlisted model throws a `GatewayError` naming the reference.
- `model("relay:main")` is the pure catalog query: `undefined` when nothing is declared under that reference. Hosts that want pre-flight validation check it before resolving.
- `provider("relay")` hands back the AI SDK provider for the parts the gateway doesn't model, such as `files()` and `skills()`.

## License

[MIT](../../LICENSE)
