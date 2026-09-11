import type { EmbeddingModelV4, ImageModelV4, LanguageModelV4, ProviderV4, RerankingModelV4, SpeechModelV4, TranscriptionModelV4 } from "@yesimagent/core";

/* Model vocabulary */

/** Modality an AI SDK `ProviderV4` can serve. */
export const MODEL_TYPES = ["language", "embedding", "image", "speech", "transcription", "reranking"] as const;

export type ModelType = (typeof MODEL_TYPES)[number];

/** Input a model accepts. */
export const MODEL_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;

export type ModelModality = (typeof MODEL_MODALITIES)[number];

/* Configuration */

/** Knowledge about a model that configuration can declare, used by hosts to pick between candidates. */
export interface ModelMetadata {
  /** Human readable name. */
  readonly name?: string;
  /** Whether the model supports tool calling. */
  readonly toolCall?: boolean;
  /** Whether the model produces reasoning content. */
  readonly reasoning?: boolean;
  /** Accepted input modalities. */
  readonly input?: readonly ModelModality[];
  /** Total context window, in tokens. */
  readonly contextWindow?: number;
  /** Maximum output, in tokens. */
  readonly maxTokens?: number;
}

/** One model an endpoint serves. */
export interface ModelConfig {
  /** Model id as the provider knows it, e.g. `gpt-4o`. */
  readonly id: string;
  /** Defaults to `language`. */
  readonly type?: ModelType;
  readonly metadata?: ModelMetadata;
}

/** An endpoint, with the credentials and passthrough settings needed to talk to it. */
export interface ProviderConfig {
  /** Registered api that builds this provider. */
  readonly api: string;
  /** Omitted means the api's own default endpoint. */
  readonly baseUrl?: string;
  /** Credential, required. `${NAME}` reads it from the gateway's `env` at build time. */
  readonly apiKey: string;
  /** Extra request headers. Values may use `${NAME}` the same way `apiKey` does. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Passed verbatim to the api factory, e.g. `{ authToken, fetch }`. Explicit fields above win over it. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Models this endpoint serves. */
  readonly models?: readonly ModelConfig[];
}

export const GROUP_STRATEGIES = ["failover", "round-robin", "random"] as const;

export type GroupStrategy = (typeof GROUP_STRATEGIES)[number];

export interface CircuitBreakerConfig {
  /** Consecutive failures before the breaker opens. */
  readonly failureThreshold: number;
  /** Seconds the breaker stays open before a probe is allowed. */
  readonly cooldownSeconds: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = { failureThreshold: 3, cooldownSeconds: 60 };

export const BREAKER_STATES = ["closed", "open", "half-open"] as const;

export type BreakerState = (typeof BREAKER_STATES)[number];

export interface CircuitBreakerStatus {
  readonly state: BreakerState;
  readonly failures: number;
}

/** A named set of interchangeable models. */
export interface GroupConfig {
  /** Defaults to `failover`. */
  readonly strategy?: GroupStrategy;
  /** Model references, `${provider}:${modelId}`. */
  readonly models: readonly string[];
  readonly circuitBreaker?: Partial<CircuitBreakerConfig>;
}

/**
 * The configuration a gateway is built from, and the shape a configuration file has once a host has
 * read it. Both sections are optional: a host reads its own file format and hands this shape over,
 * and the gateway fills in what is missing. Anything it cannot use makes `createGateway` throw.
 */
export interface GatewayConfig {
  /** Endpoints to build providers from. */
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  readonly groups?: Readonly<Record<string, GroupConfig>>;
}

/* Extension seams */

/** A provider as configured: endpoint, credentials, passthrough settings, transport. */
export interface ProviderSetup {
  /** Id from `providers.<id>`. */
  readonly id: string;
  /** Omitted when the api supplies its own default endpoint. */
  readonly baseUrl: string | undefined;
  /** The resolved credential, expanded from `apiKey`. */
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Verbatim `settings:`, spread into the AI SDK factory. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Transport used for requests. Hosts may inject one to add timeouts, retries or proxying. */
  readonly fetch: typeof globalThis.fetch;
}

/** Builds the AI SDK provider behind one `api`. */
export type ApiFactory = (setup: ProviderSetup) => ProviderV4;

/* Resolved models */

/** A model the gateway can resolve. */
export interface Model {
  /** Canonical reference, `${provider}:${modelId}`. */
  readonly id: string;
  readonly provider: string;
  /** Model id as the provider knows it. */
  readonly modelId: string;
  readonly type: ModelType;
  readonly metadata: ModelMetadata;
}

/**
 * One attempt in a failover loop. `success()` / `failure()` feed the owning group's breaker.
 */
export interface Candidate {
  /** Canonical reference, `${provider}:${modelId}`. */
  readonly id: string;
  /** Native AI SDK model, ready to hand to `generateText` / `streamText`. */
  readonly model: LanguageModelV4;
  readonly metadata: ModelMetadata;
  /** Report that this candidate handled the call. */
  success(): void;
  /** Report that this candidate failed, which may open the group's breaker for it. */
  failure(): void;
}

/** A group of interchangeable language models, plus the health of each one. */
export interface Group {
  readonly name: string;
  readonly strategy: GroupStrategy;
  /**
   * Candidates in the strategy's order. Models whose breaker is open are omitted while a
   * closed candidate remains, and included again once every breaker is open or half-open.
   */
  candidates(): readonly Candidate[];
  /** Breaker state per model reference. */
  status(): Readonly<Record<string, CircuitBreakerStatus>>;
  /** Closes every breaker in the group. */
  reset(): void;
}

/* Gateway */

export interface GatewayOptions {
  readonly config: GatewayConfig;
  /** Additional apis, merged over the built-in dialects and keyed by the name `providers.<id>.api` uses. */
  readonly apis?: Readonly<Record<string, ApiFactory>>;
  /** Transport for every provider, unless a provider overrides it through `settings`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Source for `${NAME}` expansion in `apiKey` and `headers`. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface Gateway {
  /** Registers an api, available to the next `reconfigure`. Throws if the name is taken. Returns a disposer. */
  defineApi(name: string, factory: ApiFactory): () => void;
  /**
   * The AI SDK provider built for an endpoint, for the parts of `ProviderV4` the gateway does not
   * model, such as `files()` and `skills()`.
   *
   * Provider-native tools are *not* here: `tools` lives on the concrete provider types
   * (`OpenAIProvider`, `AnthropicProvider`, …), not on `ProviderV4`. A host that wants them supplies
   * its own api whose factory returns that concrete provider, and keeps the reference it created:
   *
   * ```ts
   * const openai = createOpenAI({ apiKey, baseURL });
   * createGateway({ config, apis: { openai: () => openai } });
   * const tools = { web_search: openai.tools.webSearch({}) };  // fully typed
   * ```
   */
  provider(id: string): ProviderV4 | undefined;
  /** Names of every registered api. */
  readonly apis: readonly string[];

  /** Replaces the configuration, rebuilding providers, the model catalog and the groups. */
  reconfigure(config: GatewayConfig): void;

  /** Resolves a `${provider}:${modelId}` reference of the given modality. */
  languageModel(name: string): LanguageModelV4;
  embeddingModel(name: string): EmbeddingModelV4;
  imageModel(name: string): ImageModelV4;
  speechModel(name: string): SpeechModelV4;
  transcriptionModel(name: string): TranscriptionModelV4;
  rerankingModel(name: string): RerankingModelV4;
  /** The group's candidates, for callers that want to try another model after a failure. */
  group(name: string): Group;
  groups(): readonly string[];

  /** The models declared across every provider, optionally narrowed to one modality. */
  models(type?: ModelType): readonly Model[];
  /** A single model by `${provider}:${modelId}`, or `undefined` when nothing is declared under it. */
  model(name: string): Model | undefined;
  providers(): readonly string[];
}
