import { createAnthropic } from "@ai-sdk/anthropic";

import type { ApiFactory } from "../types.js";

/**
 * Anthropic's Messages API, and the relays that expose it alongside OpenAI's.
 *
 * `apiKey` sends an `x-api-key` header; put `{ authToken }` in `settings` instead to send
 * `Authorization: Bearer`, which some enterprise endpoints require. Without either, the SDK reads
 * `ANTHROPIC_API_KEY`.
 */
export const anthropicMessages: ApiFactory = (setup) =>
  createAnthropic({
    ...setup.settings,
    baseURL: setup.baseUrl,
    apiKey: setup.apiKey,
    headers: { ...setup.headers },
    fetch: setup.fetch,
  });
