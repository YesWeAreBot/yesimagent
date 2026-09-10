import { formatErrorCause } from "@kairou/core";
import type { ProviderV4 } from "@kairou/core";

import { builtinApis } from "./dialects/index.js";
import { GatewayError } from "./errors.js";
import { ModelGroup } from "./group.js";
import type { CandidateSource } from "./group.js";
import type { ApiFactory, Gateway, GatewayConfig, GatewayOptions, Group, Model, ModelType, ProviderConfig, ProviderSetup } from "./types.js";

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Splits a `provider:modelId` reference, or `undefined` when it is not one. */
const split = (reference: string): readonly [string, string] | undefined => {
  const separator = reference.indexOf(":");
  return separator === -1 ? undefined : ([reference.slice(0, separator), reference.slice(separator + 1)] as const);
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

  const apis = new Map<string, ApiFactory>(Object.entries(builtinApis));
  const providers = new Map<string, ProviderV4>();
  const models = new Map<string, Model>();
  const groups = new Map<string, ModelGroup>();

  let config: GatewayConfig;

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

  /** Resolves a reference to the provider behind it and the declared model it names. */
  const locate = (type: ModelType, reference: string): { provider: ProviderV4; model: Model } => {
    const parts = split(reference);
    if (!parts) throw new GatewayError(`"${reference}" is not a "provider:model" reference`);

    const provider = providers.get(parts[0]);
    if (!provider) throw new GatewayError(`Unknown provider "${parts[0]}" (from "${reference}"); registered: ${[...providers.keys()].join(", ") || "none"}`);

    const model = models.get(`${parts[0]}:${parts[1]}`);
    if (!model) throw new GatewayError(`Provider "${parts[0]}" does not declare "${parts[1]}"`);
    if (model.type !== type) throw new GatewayError(`Model "${model.id}" is declared as ${model.type}, not ${type}`);

    return { provider, model };
  };

  const candidate = (reference: string): CandidateSource => {
    const { provider, model } = locate("language", reference);
    return { id: model.id, model: provider.languageModel(model.modelId), metadata: model.metadata };
  };

  /** Rebuilds the providers the configuration declares, the catalog of their models, and the groups. */
  const load = (): void => {
    providers.clear();
    models.clear();

    for (const [id, declaration] of Object.entries(config.providers ?? {})) {
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

      providers.set(id, provider);
      for (const declared of declaration.models ?? []) {
        const reference = `${id}:${declared.id}`;
        models.set(reference, { id: reference, provider: id, modelId: declared.id, type: declared.type ?? "language", metadata: declared.metadata ?? {} });
      }
    }

    groups.clear();
    for (const [name, group] of Object.entries(config.groups ?? {})) {
      groups.set(name, new ModelGroup(name, group.strategy ?? "failover", group.models, group.circuitBreaker, candidate));
    }
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
      config = next;
      load();
    },

    languageModel(name) {
      const { provider, model } = locate("language", name);
      return provider.languageModel(model.modelId);
    },

    embeddingModel(name) {
      const { provider, model } = locate("embedding", name);
      return provider.embeddingModel(model.modelId);
    },

    imageModel(name) {
      const { provider, model } = locate("image", name);
      return provider.imageModel(model.modelId);
    },

    speechModel(name) {
      const { provider, model } = locate("speech", name);
      const factory = provider.speechModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no speechModel`);
      return factory(model.modelId);
    },

    transcriptionModel(name) {
      const { provider, model } = locate("transcription", name);
      const factory = provider.transcriptionModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no transcriptionModel`);
      return factory(model.modelId);
    },

    rerankingModel(name) {
      const { provider, model } = locate("reranking", name);
      const factory = provider.rerankingModel;
      if (!factory) throw new GatewayError(`Provider "${model.provider}" serves no rerankingModel`);
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

    models(type) {
      const all = [...models.values()];
      return type === undefined ? all : all.filter((model) => model.type === type);
    },

    model(name) {
      return models.get(name);
    },

    providers() {
      return [...providers.keys()];
    },
  };

  config = options.config;
  for (const [name, factory] of Object.entries(options.apis ?? {})) apis.set(name, factory);
  load();

  return gateway;
}
