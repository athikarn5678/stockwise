import { describe, expect, it, vi } from "vitest";

import { createOpenCodeGoProvider } from "./opencode-go-provider.ts";
import { createOpenRouterProvider } from "./openrouter-provider.ts";

const key = "test-key-placeholder";
const input = { text: "Approved aggregate analysis only" };

function completion(model: string, text: string) {
  return new Response(
    JSON.stringify({
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: text },
        },
      ],
    }),
    { status: 200 },
  );
}

function client(response: () => Response) {
  const fetchImplementation = vi.fn<typeof fetch>(async () => response());
  return {
    fetchImplementation,
    provider: createOpenCodeGoProvider({ apiKey: key, fetchImplementation }),
  };
}

function requestBody(
  fetchImplementation: ReturnType<typeof vi.fn<typeof fetch>>,
) {
  const options = fetchImplementation.mock.calls[0]?.[1];
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("OpenCode Go provider", () => {
  it("posts the OpenAI-compatible body without the OpenRouter usage extension", async () => {
    const { fetchImplementation, provider } = client(() =>
      completion("deepseek-v4.1-flash", "Analysis"),
    );
    const result = await provider.generate(input);

    expect(result).toMatchObject({
      ok: true,
      requestedModel: "deepseek-v4.1-flash",
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://opencode.ai/zen/go/v1/chat/completions",
    );
    expect(requestBody(fetchImplementation)).toEqual({
      messages: [{ content: input.text, role: "user" }],
      max_tokens: 4000,
      model: "deepseek-v4.1-flash",
    });
    expect(result.attempts[0]).toMatchObject({
      provider: "opencode-go",
      requestedModel: "deepseek-v4.1-flash",
    });
  });

  it("sends the session header OpenCode Go requires", async () => {
    const { fetchImplementation, provider } = client(() =>
      completion("deepseek-v4.1-flash", "Analysis"),
    );
    await provider.generate(input);
    const headers = fetchImplementation.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.Authorization).toBe(`Bearer ${key}`);
  });

  it("makes a single attempt even for a retryable failure", async () => {
    const { fetchImplementation, provider } = client(
      () => new Response("{}", { status: 503 }),
    );
    expect(await provider.generate(input)).toMatchObject({ ok: false });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("keeps the OpenRouter default request byte-identical", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      completion("some/free-model", "Summary"),
    );
    const provider = createOpenRouterProvider({
      apiKey: key,
      fetchImplementation,
    });
    expect(await provider.generate(input)).toMatchObject({ ok: true });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(String(fetchImplementation.mock.calls[0]?.[1]?.body)).toBe(
      '{"model":"openrouter/free","messages":[{"role":"user","content":"Approved aggregate analysis only"}],"max_tokens":512,"usage":{"include":true}}',
    );
  });

  it("allows the larger analysis response text budget", async () => {
    const longer = "a".repeat(8 * 1024);
    const openCodeGo = await client(() =>
      completion("deepseek-v4.1-flash", longer),
    ).provider.generate(input);
    expect(openCodeGo.ok).toBe(true);

    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      completion("some/free-model", longer),
    );
    const openRouter = await createOpenRouterProvider({
      apiKey: key,
      fetchImplementation,
    }).generate(input);
    expect(openRouter).toMatchObject({ failureCategory: "INVALID_RESPONSE" });
  });

  it("rejects text beyond the 12 KB analysis limit", async () => {
    const tooLong = "a".repeat(12 * 1024 + 1);
    const result = await client(() =>
      completion("deepseek-v4.1-flash", tooLong),
    ).provider.generate(input);
    expect(result).toMatchObject({
      ok: false,
      failureCategory: "INVALID_RESPONSE",
    });
  });

  it("fails safely without a key", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = createOpenCodeGoProvider({
      apiKey: undefined,
      fetchImplementation,
    });
    expect(await provider.generate(input)).toEqual({
      ok: false,
      failureCategory: "AUTHENTICATION",
      attempts: [],
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
