import type { ApiFactory } from "../types.js";
import { anthropicMessages } from "./anthropic.js";
import { googleGenerativeAi } from "./google.js";
import { openaiCompletions } from "./openai-compatible.js";
import { openaiResponses } from "./openai.js";

/**
 * The dialects a gateway starts with. Keys are the values `providers.<id>.api` takes; a host can
 * replace or extend any of them through `GatewayOptions.apis`.
 */
export const BUILTIN_APIS: Readonly<Record<string, ApiFactory>> = {
  "openai-completions": openaiCompletions,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages,
  "google-generative-ai": googleGenerativeAi,
};
