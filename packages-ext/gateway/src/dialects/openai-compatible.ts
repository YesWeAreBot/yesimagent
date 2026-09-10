import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { ApiFactory } from "../types.js";

/**
 * The `/chat/completions` shape most third-party endpoints speak: DeepSeek, Groq, Kimi, GLM,
 * SiliconFlow, together, Fireworks, and any relay in front of them.
 *
 * `baseUrl` is required. `setup.id` becomes the SDK provider name, so every model this endpoint
 * serves reports `id.chat` and reads `providerOptions.${id}` rather than OpenAI's own namespace.
 * An unauthenticated endpoint needs no `apiKey` at all — the SDK only sends the header when one is
 * configured, unlike the OpenAI provider, which insists on a key.
 */
export const openaiCompletions: ApiFactory = (setup) =>
  createOpenAICompatible({
    ...setup.settings,
    name: setup.id,
    baseURL: setup.baseUrl ?? "",
    apiKey: setup.apiKey,
    headers: { ...setup.headers },
    fetch: setup.fetch,
  });
