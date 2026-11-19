import { randomUUID } from "node:crypto";

import type { AiProvider } from "./ai-provider.ts";
import { createOpenRouterProvider } from "./openrouter-provider.ts";

export const OPENCODE_GO_ENDPOINT =
  "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_GO_DEFAULT_MODEL = "deepseek-v4.1-flash";
// A whole on-demand run (both languages concurrently, at most one quick retry)
// must end under the 60 s ALB idle timeout, so one call may take 25 s at most.
const TIMEOUT_MILLISECONDS = 25_000;
const MAX_TOKENS = 4_000;
const RESPONSE_TEXT_LIMIT_BYTES = 32 * 1024;

/**
 * OpenCode Go exposes an OpenAI-compatible chat-completions API, so it reuses
 * the existing adapter with its own endpoint, model and response budget.
 */
export function createOpenCodeGoProvider({
  apiKey,
  fetchImplementation = fetch,
  model = OPENCODE_GO_DEFAULT_MODEL,
}: {
  apiKey?: string | undefined;
  fetchImplementation?: typeof fetch;
  model?: string | undefined;
}): AiProvider {
  return createOpenRouterProvider({
    apiKey,
    endpoint: OPENCODE_GO_ENDPOINT,
    // Measured live: with reasoning on, a run takes 37-54 s (2-3k reasoning
    // tokens), over the 60 s ALB idle limit; with it off about 11 s and the
    // output still passes the same validator. Short sectioned prose needs no
    // chain of thought.
    extraBody: { thinking: { type: "disabled" } },
    fetchImplementation,
    // One attempt per call; the service decides about one quick retry.
    maxAttempts: 1,
    maxTokens: MAX_TOKENS,
    model,
    providerName: "opencode-go",
    // OpenCode Go rejects requests without a session id (400 MissingSessionID).
    requestHeaders: () => ({ "x-opencode-session": randomUUID() }),
    responseTextLimitBytes: RESPONSE_TEXT_LIMIT_BYTES,
    timeoutMilliseconds: TIMEOUT_MILLISECONDS,
  });
}
