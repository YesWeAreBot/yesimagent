import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV4, LanguageModelV4Prompt, LanguageModelV4ToolCallPart } from "@yesimagent/core";
import { wrapLanguageModel } from "@yesimagent/core";

import type { ApiFactory } from "../types.js";

export const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

const GEMINI_3_MODEL = /(^|\/)gemini-3(?:[.-]|$)/i;

export const isGemini3Model = (modelId: string): boolean => GEMINI_3_MODEL.test(modelId);

const isServerToolCall = (part: LanguageModelV4ToolCallPart): boolean => {
  const options = part.providerOptions?.google;
  return options?.serverToolCallId != null && options?.serverToolType != null;
};

const withSkipSignature = (part: LanguageModelV4ToolCallPart): LanguageModelV4ToolCallPart => ({
  ...part,
  providerOptions: {
    ...part.providerOptions,
    google: {
      ...part.providerOptions?.google,
      thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR,
    },
  },
});

/**
 * Gemini 3 requires a signature on replayed tool calls. Supply the documented sentinel for calls
 * created by another provider while preserving real signatures and the SDK's ordering rules.
 */
export function addGoogleThoughtSignatures(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  let changed = false;

  const messages = prompt.map((message) => {
    if (message.role !== "assistant") return message;

    let hasSignedFunctionCall = false;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-call") return part;
      if (part.providerExecuted === true && part.toolName === "code_execution") return part;

      const serverToolCall = isServerToolCall(part);
      const hasSignature = part.providerOptions?.google?.thoughtSignature != null;
      if (hasSignature) {
        if (!serverToolCall) hasSignedFunctionCall = true;
        return part;
      }
      if (!serverToolCall && hasSignedFunctionCall) return part;

      changed = true;
      messageChanged = true;
      return withSkipSignature(part);
    });

    return messageChanged ? { ...message, content } : message;
  });

  return changed ? messages : prompt;
}

/** Adds the Google sentinel at the provider boundary without changing persisted conversation history. */
export function withGoogleThoughtSignatures(model: LanguageModelV4, modelId: string = model.modelId): LanguageModelV4 {
  if (!isGemini3Model(modelId)) return model;

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({ ...params, prompt: addGoogleThoughtSignatures(params.prompt) }),
    },
  });
}

/**
 * The Google Generative AI API behind Gemini models.
 *
 * `baseUrl` is optional: without it the SDK uses Google's endpoint and reads `GOOGLE_GENERATIVE_AI_API_KEY`
 * when no `apiKey` is configured.
 */
export const googleGenerativeAi: ApiFactory = (setup) => {
  const settings = {
    ...setup.settings,
    baseURL: setup.baseUrl,
    apiKey: setup.apiKey,
    headers: { ...setup.headers },
    fetch: setup.fetch,
  };
  const provider = createGoogleGenerativeAI(settings);
  return {
    ...provider,
    languageModel: (modelId) => withGoogleThoughtSignatures(provider.languageModel(modelId), modelId),
  };
};

export { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
