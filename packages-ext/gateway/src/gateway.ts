import type { TypeSafeAiProvider } from "@ai-sdk/typesafe-ai";
import type { LanguageModelV4, LanguageModelV4CallOptions, ProviderV4 } from "@yesimagent/core";
import { formatErrorCause, wrapLanguageModel } from "@yesimagent/core";

import { BUILTIN_APIS } from "./dialects/index.js";
import { GatewayError } from "./errors.js";
import type { CandidateSource } from "./group.js";
import { ModelGroup } from "./group.js";
import type { ApiFactory, Gateway, GatewayConfig, GatewayOptions, Group, Model, ModelType, ProviderConfig, ProviderSetup, ThinkLevel } from "./types.js";
import { THINK_LEVELS } from "./types.js";

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Splits a `provider:modelId[:thinkLevel]` reference at its first colon, or `undefined` when it is
 *  not one. The tail is left whole — a model id may contain colons (`qwen3:32b`), and only the
 *  catalog can say whether the trailing segment is part of the id or a pinned level. */
const split = (reference: string): { provider: string; id: string } | undefined => {
  const separator = reference.indexOf(":");
  return separator === -1 ? undefined : { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
};

/** The declared model an id names, plus the think level the id pins, or `undefined` when nothing is
 *  declared under it. The id is tried as written first: a trailing `:level` only counts when no
 *  model is declared under the full id, so a model whose own id ends in a level name
 *  (`main:high`) resolves to itself instead of being read as `main` at level `high`. */
const lookup = (
  inModels: Map<string, Model<ModelType>>,
  provider: string,
  id: string,
): { model: Model<ModelType>; level: ThinkLevel | undefined } | undefined => {
  const exact = inModels.get(`${provider}:${id}`);
  if (exact) return { model: exact, level: undefined };

  const tail = id.lastIndexOf(":");
  if (tail === -1) return undefined;

  const candidate = id.slice(tail + 1);
  if (!(THINK_LEVELS as readonly string[]).includes(candidate)) return undefined;

  const model = inModels.get(`${provider}:${id.slice(0, tail)}`);
  return model === undefined ? undefined : { model, level: candidate as ThinkLevel };
};

/** Pins a think level onto every call the model sees, by way of the AI SDK's portable `reasoning`
 *  call option. `"max"` sits outside the spec's enum: OpenAI-family endpoints accept it, the other
 *  providers emit an unsupported warning and ignore it. */
const withThinkLevel = (model: LanguageModelV4, level: ThinkLevel): LanguageModelV4 =>
  wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({ ...params, reasoning: level as LanguageModelV4CallOptions["reasoning"] }),
    },
  });

/** Throws when the model declares the efforts it supports and the reference pins another one. */
const checkEfforts = (model: Model<"language">, level: ThinkLevel): void => {
  const efforts = model.metadata.thinking?.efforts;
  if (efforts?.length && !efforts.includes(level)) {
    throw new GatewayError(`Model "${model.id}" does not support think level "${level}" (declared: ${efforts.join(", ")})`);
  }
};

/** Replaces `${NAME}` with its value; an unset one fails the build. */
const expand = (value: string, where: string, env: Readonly<Record<string, string | undefined>>): string => {
  VARIABLE.lastIndex = 0;
  if (!VARIABLE.test(value)) return value;

  VARIABLE.lastIndex = 0;
  let missing: string | undefined;
  const expanded = value.replace(VARIABLE, (reference, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved.length === 0) {
      missing ??= name;
      return reference;
    }
    return resolved;
  });

  if (missing !== undefined) throw new GatewayError(`${where}: environment variable "${missing}" is not set`);
  return expanded;
};

export function createGateway(options: GatewayOptions): Gateway {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;

  const apis = new Map<string, ApiFactory>(Object.entries(BUILTIN_APIS));
  let providers = new Map<string, ProviderV4>();
  let models = new Map<string, Model<ModelType>>();
  let groups = new Map<string, ModelGroup>();

  const setupOf = (id: string, declaration: ProviderConfig): ProviderSetup => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(declaration.headers ?? {})) {
      headers[name] = expand(value, `providers.${id}.headers.${name}`, env);
    }
    return {
      id,
      baseUrl: declaration.baseUrl,
      apiKey: expand(declaration.apiKey, `providers.${id}.apiKey`, env),
      headers,
      settings: declaration.settings ?? {},
      fetch: fetchImpl,
    };
  };

  /** Resolves a reference against one provider map and model catalog — the live pair, or the one a
   *  rebuild is staging. */
  const locate = <T extends ModelType>(
    inProviders: Map<string, ProviderV4>,
    inModels: Map<string, Model<ModelType>>,
    type: T,
    reference: string,
  ): { provider: ProviderV4; model: Model<T>; level: ThinkLevel | undefined } => {
    const parts = split(reference);
    if (!parts) throw new GatewayError(`"${reference}" is not a "provider:model" reference`);

    const { provider: providerId, id } = parts;
    const provider = inProviders.get(providerId);
    if (!provider)
      throw new GatewayError(`Unknown provider "${providerId}" (from "${reference}"); registered: ${[...inProviders.keys()].join(", ") || "none"}`);

    const found = lookup(inModels, providerId, id);
    if (!found) throw new GatewayError(`Provider "${providerId}" does not declare "${id}"`);

    const model = found.model as Model<T>;
    if (model.type !== type) throw new GatewayError(`Model "${model.id}" is declared as ${model.type}, not ${type}`);
    if (found.level !== undefined && type !== "language") {
      throw new GatewayError(`Think level "${found.level}" only applies to language models (from "${reference}")`);
    }

    return { provider, model, level: found.level };
  };

  const candidate = (inProviders: Map<string, ProviderV4>, inModels: Map<string, Model<ModelType>>, reference: string): CandidateSource => {
    const { provider, model, level } = locate(inProviders, inModels, "language", reference);
    if (level !== undefined) checkEfforts(model, level);
    const built = provider.languageModel(model.modelId);
    return {
      // The level is part of the member's identity: the same model pinned at two levels is two
      // candidates, and two independent breaker entries.
      id: level === undefined ? model.id : `${model.id}:${level}`,
      model: level === undefined ? built : withThinkLevel(built, level),
      metadata: model.metadata,
    };
  };

  /** Builds the providers the configuration declares, the catalog of their models, and the groups into
   *  a staging picture, then swaps it in whole — a configuration that fails to build is rejected
   *  without touching what the gateway already serves. */
  const load = (next: GatewayConfig): void => {
    const nextProviders = new Map<string, ProviderV4>();
    const nextModels = new Map<string, Model<ModelType>>();

    for (const [id, declaration] of Object.entries(next.providers ?? {})) {
      if (typeof declaration.apiKey !== "string" || declaration.apiKey.length === 0) {
        throw new GatewayError(`providers.${id}: apiKey is required; use \${VAR} to read one from the environment`);
      }

      const factory = apis.get(declaration.api);
      if (!factory) throw new GatewayError(`providers.${id}: unknown api "${declaration.api}" (registered: ${[...apis.keys()].join(", ")})`);

      let provider: ProviderV4;
      try {
        provider = factory(setupOf(id, declaration));
      } catch (error) {
        throw new GatewayError(`providers.${id} (api: ${declaration.api}) could not be built: ${formatErrorCause(error)}`);
      }

      nextProviders.set(id, provider);
      for (const declared of declaration.models ?? []) {
        const { id: modelId, type = "language", ...metadata } = declared;
        const reference = `${id}:${modelId}`;
        nextModels.set(reference, { id: reference, provider: id, modelId, type, metadata });
      }
    }

    // Groups resolve their members against the staged picture, so a typo fails the rebuild before
    // anything reaches the live maps.
    const nextGroups = new Map<string, ModelGroup>();
    for (const [name, group] of Object.entries(next.groups ?? {})) {
      nextGroups.set(
        name,
        new ModelGroup(name, group.strategy ?? "failover", group.models, group.circuitBreaker, (reference) => candidate(nextProviders, nextModels, reference)),
      );
    }

    providers = nextProviders;
    models = nextModels;
    groups = nextGroups;
  };

  const gateway: Gateway = {
    defineApi(name, factory) {
      if (apis.has(name)) throw new GatewayError(`Api "${name}" is already registered`);
      apis.set(name, factory);
      return () => apis.delete(name);
    },

    get apis() {
      return [...apis.keys()];
    },

    provider(id): ProviderV4 | undefined {
      return providers.get(id);
    },

    reconfigure(next: GatewayConfig) {
      load(next);
    },

    languageModel(name) {
      const { provider, model, level } = locate(providers, models, "language", name);
      if (level !== undefined) checkEfforts(model, level);
      const built = provider.languageModel(model.modelId);
      return level === undefined ? built : withThinkLevel(built, level);
    },

    embeddingModel(name) {
      const { provider, model } = locate(providers, models, "embedding", name);
      return provider.embeddingModel(model.modelId);
    },

    imageModel(name) {
      const { provider, model } = locate(providers, models, "image", name);
      return provider.imageModel(model.modelId);
    },

    speechModel(name) {
      const { provider, model } = locate(providers, models, "speech", name);
      const factory = provider.speechModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no speechModel`);
      return factory(model.modelId);
    },

    transcriptionModel(name) {
      const { provider, model } = locate(providers, models, "transcription", name);
      const factory = provider.transcriptionModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no transcriptionModel`);
      return factory(model.modelId);
    },

    rerankingModel(name) {
      const { provider, model } = locate(providers, models, "reranking", name);
      const factory = provider.rerankingModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no rerankingModel`);
      return factory(model.modelId);
    },

    decisionModel(name) {
      const { provider, model } = locate(providers, models, "decision", name);
      const factory = (provider as TypeSafeAiProvider).decisionModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no decisionModel`);
      return factory(model.modelId);
    },

    group(name): Group {
      const group = groups.get(name);
      if (!group) throw new GatewayError(`Unknown model group "${name}" (declared: ${[...groups.keys()].join(", ") || "none"})`);
      return group;
    },

    groups() {
      return [...groups.keys()];
    },

    models<T extends ModelType = ModelType>(type?: T): ReadonlyArray<Model<T>> {
      // `Model<T>` only narrows the `type` tag, which the predicate is what makes true.
      return [...models.values()].filter((model): model is Model<T> => type === undefined || model.type === type);
    },

    model(name) {
      const parts = split(name);
      if (!parts) return undefined;
      const found = lookup(models, parts.provider, parts.id);
      // A level applies to language models only, exactly as resolution treats it.
      return found === undefined || (found.level !== undefined && found.model.type !== "language") ? undefined : found.model;
    },

    providers() {
      return [...providers.keys()];
    },
  };

  for (const [name, factory] of Object.entries(options.apis ?? {})) apis.set(name, factory);
  load(options.config);

  return gateway;
}
