import { createServer, type IncomingMessage, type Server } from "node:http";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGateway } from "../src/gateway.js";
import type { Gateway, GatewayConfig } from "../src/types.js";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

const CHAT_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "main",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

let server: Server;
let origin: string;
let received: Received[];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(CHAT_RESPONSE));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(() => {
  server.close();
});

function gatewayWith(providers: GatewayConfig["providers"]): Gateway {
  return createGateway({
    config: { providers },
    apis: { keyless: (setup) => createOpenAICompatible({ name: "keyless", baseURL: setup.baseUrl ?? "", headers: { ...setup.headers }, fetch: setup.fetch }) },
  });
}

describe("openai-completions dialect", () => {
  it("posts to the configured endpoint with the configured credential and settings", async () => {
    received = [];
    const gateway = gatewayWith({
      relay: {
        api: "openai-completions",
        baseUrl: `${origin}/v1`,
        apiKey: "sk-test",
        headers: { "x-team": "platform" },
        models: [{ id: "main" }],
      },
    });

    const model = gateway.languageModel("relay:main");
    expect(model.provider).toBe("relay.chat");

    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].url).toBe("/v1/chat/completions");
    expect(received[0].headers.authorization).toBe("Bearer sk-test");
    expect(received[0].headers["x-team"]).toBe("platform");
    expect(received[0].body).toMatchObject({ model: "main" });
  });

  it("sends no Authorization header to an endpoint whose api ignores the key", async () => {
    received = [];
    // A keyless local endpoint: the config must carry an apiKey, but a dialect serving unauthenticated
    // endpoints simply does not turn it into a header.
    const gateway = gatewayWith({ local: { api: "keyless", baseUrl: `${origin}/v1`, apiKey: "unused", models: [{ id: "main" }] } });

    await gateway.languageModel("local:main").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

    expect(received[0].headers.authorization).toBeUndefined();
  });
});

describe("keyless dialect", () => {
  it("receives the credential but chooses not to send it", async () => {
    received = [];
    let sawKey: string | undefined;
    const gateway = createGateway({
      config: { providers: { local: { api: "keyless", baseUrl: `${origin}/v1`, apiKey: "ignored", models: [{ id: "main" }] } } },
      apis: {
        keyless: (setup) => {
          sawKey = setup.apiKey;
          return createOpenAICompatible({ name: "keyless", baseURL: setup.baseUrl ?? "", headers: { ...setup.headers }, fetch: setup.fetch });
        },
      },
    });

    await gateway.languageModel("local:main").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(sawKey).toBe("ignored");
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].body).toMatchObject({ model: "main" });
  });
});
