import { randomUUID } from "node:crypto";

import type { AiProvider } from "./ai-provider.ts";
import { createOpenRouterProvider } from "./openrouter-provider.ts";

export const OPENCODE_GO_ENDPOINT =
  "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_GO_DEFAULT_MODEL = "deepseek-v4.1-flash";
const TIMEOUT_MILLISECONDS = 90_000;
const MAX_TOKENS = 4_000;
const RESPONSE_TEXT_LIMIT_BYTES = 12 * 1024;

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
    fetchImplementation,
    maxTokens: MAX_TOKENS,
    model,
    providerName: "opencode-go",
    // OpenCode Go rejects requests without a session id (400 MissingSessionID).
    requestHeaders: () => ({ "x-opencode-session": randomUUID() }),
    responseTextLimitBytes: RESPONSE_TEXT_LIMIT_BYTES,
    timeoutMilliseconds: TIMEOUT_MILLISECONDS,
  });
}
