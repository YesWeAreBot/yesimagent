import { createOpenAI } from "@ai-sdk/openai";

import type { ApiFactory } from "../types.js";

/**
 * OpenAI's own API, including the Responses API.
 *
 * `baseUrl` is optional: without it the SDK uses OpenAI's endpoint and reads `OPENAI_API_KEY` when
 * no `apiKey` is configured. Any header, key or `settings` entry is spread straight into the SDK
 * factory, so `settings` can add anything the SDK accepts — but never override `baseUrl`, `apiKey`,
 * `headers` or the gateway's `fetch`.
 */
export const openaiResponses: ApiFactory = (setup) =>
  createOpenAI({
    ...setup.settings,
    baseURL: setup.baseUrl,
    apiKey: setup.apiKey,
    headers: { ...setup.headers },
    fetch: setup.fetch,
  });

export { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
