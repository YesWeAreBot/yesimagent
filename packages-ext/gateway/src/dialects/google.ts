import { createGoogleGenerativeAI } from "@ai-sdk/google";

import type { ApiFactory } from "../types.js";

/**
 * The Google Generative AI API behind Gemini models.
 *
 * `baseUrl` is optional: without it the SDK uses Google's endpoint and reads `GOOGLE_GENERATIVE_AI_API_KEY`
 * when no `apiKey` is configured.
 */
export const googleGenerativeAi: ApiFactory = (setup) =>
  createGoogleGenerativeAI({
    ...setup.settings,
    baseURL: setup.baseUrl,
    apiKey: setup.apiKey,
    headers: { ...setup.headers },
    fetch: setup.fetch,
  });

export { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
