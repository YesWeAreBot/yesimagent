import { createTypeSafeAi, type TypeSafeAiProviderSettings } from "@ai-sdk/typesafe-ai";

import type { ApiFactory } from "../types.js";

export const typesafeAi: ApiFactory = (setup) => {
  const settings: TypeSafeAiProviderSettings = {
    ...setup.settings,
    baseURL: setup.baseUrl,
    apiKey: setup.apiKey,
    headers: { ...setup.headers },
    fetch: setup.fetch,
  };
  return createTypeSafeAi(settings);
};

export { createTypeSafeAi, type TypeSafeAiProvider } from "@ai-sdk/typesafe-ai";
