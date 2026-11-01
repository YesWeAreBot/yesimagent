import { createServer, type Server } from "node:http";

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV4Prompt } from "@yesimagent/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addGoogleThoughtSignatures,
  googleGenerativeAi,
  isGemini3Model,
  SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  withGoogleThoughtSignatures,
} from "../src/dialects/google.js";

const assistantWithUnsignedCalls: LanguageModelV4Prompt = [
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "send", toolName: "send_message", input: { body: "hello" } },
      { type: "tool-call", toolCallId: "wait", toolName: "wait", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "send", toolName: "send_message", output: { type: "text", value: "sent" } },
      { type: "tool-result", toolCallId: "wait", toolName: "wait", output: { type: "text", value: "waited" } },
    ],
  },
];

let server: Server;
let origin: string;
let requestBody: Record<string, unknown> | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(() => {
  server.close();
});

describe("Gemini 3 thought signatures", () => {
  it("adds the sentinel to every unsigned tool call in one model response", () => {
    const result = addGoogleThoughtSignatures(assistantWithUnsignedCalls);
    const assistant = result[0];
    expect(assistant.role).toBe("assistant");
    if (assistant.role !== "assistant") return;

    expect(assistant.content).toMatchObject([
      { providerOptions: { google: { thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR } } },
      { providerOptions: { google: { thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR } } },
    ]);
    expect(assistantWithUnsignedCalls[0]).not.toHaveProperty("providerOptions");
  });

  it("preserves signed calls and follows the SDK ordering rule within each response", () => {
    const prompt: LanguageModelV4Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "before",
            toolName: "before",
            input: {},
            providerOptions: { openai: { trace: "kept" } },
          },
          {
            type: "tool-call",
            toolCallId: "signed",
            toolName: "signed",
            input: {},
            providerOptions: { google: { thoughtSignature: "real-signature", extra: "kept" } },
          },
          { type: "tool-call", toolCallId: "after", toolName: "after", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "next-message", toolName: "next_message", input: {} }],
      },
    ];

    const result = addGoogleThoughtSignatures(prompt);
    const first = result[0];
    const second = result[1];
    expect(first.role).toBe("assistant");
    expect(second.role).toBe("assistant");
    if (first.role !== "assistant" || second.role !== "assistant") return;

    expect(first.content).toMatchObject([
      {
        toolCallId: "before",
        providerOptions: {
          openai: { trace: "kept" },
          google: { thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR },
        },
      },
      { toolCallId: "signed", providerOptions: { google: { thoughtSignature: "real-signature", extra: "kept" } } },
      { toolCallId: "after" },
    ]);
    expect(first.content[2]).not.toHaveProperty("providerOptions");
    expect(second.content).toMatchObject([{ providerOptions: { google: { thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR } } }]);
    expect(prompt[0]).toMatchObject({
      content: [{ providerOptions: { openai: { trace: "kept" } } }, { providerOptions: { google: { thoughtSignature: "real-signature", extra: "kept" } } }, {}],
    });
  });

  it("preserves signed calls, skips code execution, and signs server calls", () => {
    const prompt: LanguageModelV4Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "signed",
            toolName: "signed",
            input: {},
            providerOptions: { google: { thoughtSignature: "real-signature" } },
          },
          { type: "tool-call", toolCallId: "after-signed", toolName: "after_signed", input: {} },
          {
            type: "tool-call",
            toolCallId: "code",
            toolName: "code_execution",
            input: {},
            providerExecuted: true,
          },
          {
            type: "tool-call",
            toolCallId: "server",
            toolName: "server_tool",
            input: {},
            providerOptions: { google: { serverToolCallId: "server-id", serverToolType: "search" } },
          },
        ],
      },
    ];

    const result = addGoogleThoughtSignatures(prompt);
    const assistant = result[0];
    expect(assistant.role).toBe("assistant");
    if (assistant.role !== "assistant") return;

    expect(assistant.content).toMatchObject([
      { providerOptions: { google: { thoughtSignature: "real-signature" } } },
      { toolCallId: "after-signed" },
      { toolCallId: "code" },
      {
        providerOptions: {
          google: {
            serverToolCallId: "server-id",
            serverToolType: "search",
            thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR,
          },
        },
      },
    ]);
    expect(assistant.content[1]).not.toHaveProperty("providerOptions");
    expect(assistant.content[2]).not.toHaveProperty("providerOptions");
  });

  it("matches Gemini 3 model ids only", () => {
    expect(["gemini-3", "gemini-3-pro-preview", "gemini-3.8-flash", "google/gemini-3.1-pro-preview"].every(isGemini3Model)).toBe(true);
    expect(["gemini-2.5-pro", "gemma-3-27b-it", "gemini-30-flash", "deepseek/deepseek-v4.1-flash"].some(isGemini3Model)).toBe(false);
  });

  it("wraps Gemini 3 at the provider boundary and leaves other models unchanged", async () => {
    requestBody = undefined;
    const provider = createGoogleGenerativeAI({ apiKey: "test", baseURL: origin });
    const gemini25 = provider.languageModel("gemini-2.5-pro");
    expect(withGoogleThoughtSignatures(gemini25, gemini25.modelId)).toBe(gemini25);

    const dialect = googleGenerativeAi({
      id: "google",
      baseUrl: origin,
      apiKey: "test",
      headers: {},
      settings: {},
      fetch: globalThis.fetch,
    });
    const result = await dialect.languageModel("gemini-3.8-flash").doGenerate({ prompt: assistantWithUnsignedCalls });

    expect(requestBody).toBeDefined();
    const contents = requestBody?.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const calls = contents.flatMap(({ parts }) => parts.filter((part) => "functionCall" in part));
    expect(calls).toMatchObject([
      { functionCall: { name: "send_message" }, thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR },
      { functionCall: { name: "wait" }, thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR },
    ]);
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ message: expect.stringContaining("Replayed") }));
  });
});
