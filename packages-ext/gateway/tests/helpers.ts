import {
  type EmbeddingModelV4Result,
  type LanguageModelV4GenerateResult,
  MockEmbeddingModelV4,
  MockImageModelV4,
  MockLanguageModelV4,
  MockProviderV4,
  type ProviderV4,
} from "@kairou/core";

import type { ProviderSetup } from "../src/types.js";

export const GENERATE_RESULT = {
  content: [{ type: "text" as const, text: "ok" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

export const EMBED_RESULT = { embeddings: [[0.1, 0.2]], usage: { tokens: 2 }, warnings: [] } satisfies EmbeddingModelV4Result;

export interface Mocked {
  readonly provider: ProviderV4;
  readonly language: Record<string, MockLanguageModelV4>;
  readonly embedding: Record<string, MockEmbeddingModelV4>;
}

/** A provider whose models record every call, so a test can assert what settings actually reached them. */
export function mockProvider(models: { language?: readonly string[]; embedding?: readonly string[] } = {}): Mocked {
  const language: Record<string, MockLanguageModelV4> = {};
  for (const id of models.language ?? []) language[id] = new MockLanguageModelV4({ modelId: id, doGenerate: GENERATE_RESULT });

  const embedding: Record<string, MockEmbeddingModelV4> = {};
  for (const id of models.embedding ?? []) embedding[id] = new MockEmbeddingModelV4({ modelId: id, doEmbed: EMBED_RESULT });

  return { provider: new MockProviderV4({ languageModels: language, embeddingModels: embedding }), language, embedding };
}

/** A provider that builds a model for any id, the way a real endpoint does. */
export function openProvider(): ProviderV4 {
  return {
    specificationVersion: "v4",
    languageModel: (modelId) => new MockLanguageModelV4({ modelId, doGenerate: GENERATE_RESULT }),
    embeddingModel: (modelId) => new MockEmbeddingModelV4({ modelId, doEmbed: EMBED_RESULT }),
    imageModel: (modelId) => new MockImageModelV4({ modelId }),
  };
}

/** An api factory that records the setup it was handed. */
export function recordingApi(mocked: Mocked): { setups: ProviderSetup[]; api: (setup: ProviderSetup) => ProviderV4 } {
  const setups: ProviderSetup[] = [];
  return {
    setups,
    api: (setup) => {
      setups.push(setup);
      return mocked.provider;
    },
  };
}
