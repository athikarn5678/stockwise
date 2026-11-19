import { z } from "zod";

import type {
  AiProvider,
  AiProviderAttempt,
  AiProviderAttemptObserver,
  AiProviderFailureCategory,
  AiProviderFailureDetail,
  AiProviderName,
  AiProviderResult,
  AiProviderUsage,
} from "./ai-provider.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";
const TIMEOUT_MILLISECONDS = 15_000;
const REQUEST_LIMIT_BYTES = 16 * 1024;
const RESPONSE_TEXT_LIMIT_BYTES = 4 * 1024;
const RESPONSE_BODY_LIMIT_BYTES = 32 * 1024;
const MAX_TOKENS = 512;
const RESPONSE_BODY_BYTES_PER_TEXT_BYTE = 8;

const tokenCount = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .optional();

const usageSchema = z
  .object({
    prompt_tokens: tokenCount,
    completion_tokens: tokenCount,
    total_tokens: tokenCount,
    cost: z.number().finite().nonnegative().nullable().optional(),
  })
  .passthrough();

const completionSchema = z.object({
  object: z.literal("chat.completion"),
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_./:-]+$/),
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        finish_reason: z.string().nullable(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string(),
        }),
      }),
    )
    .length(1),
  usage: usageSchema.optional(),
});

function bodyFor(
  text: string,
  options: Readonly<{
    extraBody?: Readonly<Record<string, unknown>>;
    includeUsage: boolean;
    maxTokens: number;
    model: string;
  }>,
) {
  return JSON.stringify({
    model: options.model,
    messages: [{ role: "user", content: text }],
    max_tokens: options.maxTokens,
    // `usage.include` is an OpenRouter extension; OpenAI-compatible endpoints
    // receive the plain request body.
    ...(options.includeUsage ? { usage: { include: true } } : {}),
    ...options.extraBody,
  });
}

function classifyStatus(status: number): AiProviderFailureCategory {
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "PROVIDER_UNAVAILABLE";
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if ([400, 413, 422].includes(status)) return "INVALID_REQUEST";
  if (status >= 400 && status < 500 && status !== 402 && status !== 404)
    return "INVALID_REQUEST";
  return "PROVIDER_ERROR";
}

function retryable(category: AiProviderFailureCategory, status?: number) {
  return (
    category === "TIMEOUT" ||
    category === "TRANSPORT" ||
    category === "RATE_LIMITED" ||
    (status !== undefined && status >= 500)
  );
}

async function readBounded(
  response: Response,
  limitBytes: number,
): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limitBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, length),
    );
  } catch {
    return null;
  }
}

function normalizeUsage(
  usage: z.infer<typeof usageSchema> | undefined,
): AiProviderUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    ...(usage.prompt_tokens == null
      ? {}
      : { promptTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens == null
      ? {}
      : { completionTokens: usage.completion_tokens }),
    ...(usage.total_tokens == null ? {} : { totalTokens: usage.total_tokens }),
    ...(usage.cost == null ? {} : { cost: String(usage.cost) }),
  };
}

export type ChatCompletionProviderOptions = Readonly<{
  apiKey?: string | undefined;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  /** Extra top-level request fields (provider specific). */
  extraBody?: Readonly<Record<string, unknown>>;
  maxAttempts?: number;
  maxTokens?: number;
  requestHeaders?: () => Record<string, string>;
  model?: string;
  providerName?: AiProviderName;
  responseTextLimitBytes?: number;
  timeoutMilliseconds?: number;
}>;

export function createOpenRouterProvider({
  apiKey,
  endpoint = ENDPOINT,
  fetchImplementation = fetch,
  extraBody,
  maxAttempts = 3,
  maxTokens = MAX_TOKENS,
  model = MODEL,
  requestHeaders,
  providerName = "openrouter",
  responseTextLimitBytes = RESPONSE_TEXT_LIMIT_BYTES,
  timeoutMilliseconds = TIMEOUT_MILLISECONDS,
}: ChatCompletionProviderOptions): AiProvider {
  const includeUsage = providerName === "openrouter";
  const responseBodyLimitBytes = Math.max(
    RESPONSE_BODY_LIMIT_BYTES,
    responseTextLimitBytes * RESPONSE_BODY_BYTES_PER_TEXT_BYTE,
  );
  return {
    async generate(
      input,
      observer?: AiProviderAttemptObserver,
    ): Promise<AiProviderResult> {
      const attempts: AiProviderAttempt[] = [];
      if (apiKey === undefined || !/^[\x21-\x7e]+$/.test(apiKey)) {
        return { ok: false, failureCategory: "AUTHENTICATION", attempts };
      }
      if (typeof input.text !== "string" || input.text.trim().length === 0) {
        return { ok: false, failureCategory: "INVALID_REQUEST", attempts };
      }
      const body = bodyFor(input.text, {
        ...(extraBody === undefined ? {} : { extraBody }),
        includeUsage,
        maxTokens,
        model,
      });
      if (Buffer.byteLength(body, "utf8") > REQUEST_LIMIT_BYTES) {
        return { ok: false, failureCategory: "INVALID_REQUEST", attempts };
      }

      async function call(): Promise<AiProviderResult> {
        const attemptNumber = attempts.length + 1;
        await observer?.beforeAttempt({
          provider: providerName,
          requestedModel: model,
          attemptNumber,
        });
        const started = performance.now();
        const signal = AbortSignal.timeout(timeoutMilliseconds);
        let status: number | undefined;
        let failureCategory: AiProviderFailureCategory | undefined;
        let failureDetail: AiProviderFailureDetail | undefined;
        let completion: z.infer<typeof completionSchema> | undefined;

        try {
          const response = await fetchImplementation(endpoint, {
            method: "POST",
            headers: {
              ...requestHeaders?.(),
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body,
            signal,
            redirect: "error",
          });
          status = response.status;
          if (!response.ok) {
            // A generic 404 is not a transient failure; do not retry it.
            failureCategory = classifyStatus(status);
          } else {
            const raw = await readBounded(response, responseBodyLimitBytes);
            if (raw === null) {
              failureCategory = "INVALID_RESPONSE";
              failureDetail = { check: "size" };
            } else {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                failureCategory = "INVALID_RESPONSE";
                failureDetail = { check: "parse" };
              }
              if (failureCategory === undefined) {
                const checked = completionSchema.safeParse(parsed);
                if (!checked.success) {
                  failureCategory = "INVALID_RESPONSE";
                  failureDetail = { check: "schema" };
                } else {
                  const choice = checked.data.choices[0]!;
                  const contentBytes = Buffer.byteLength(
                    choice.message.content,
                    "utf8",
                  );
                  const finishReason = choice.finish_reason ?? "null";
                  if (contentBytes === 0) {
                    failureCategory = "INVALID_RESPONSE";
                    failureDetail = {
                      check: "empty",
                      contentBytes,
                      finishReason,
                    };
                  } else if (contentBytes > responseTextLimitBytes) {
                    failureCategory = "INVALID_RESPONSE";
                    failureDetail = {
                      check: "size",
                      contentBytes,
                      finishReason,
                    };
                  } else if (finishReason !== "stop") {
                    // A truncated answer ("length") is never accepted as text.
                    failureCategory = "INVALID_RESPONSE";
                    failureDetail = {
                      check: "finish",
                      contentBytes,
                      finishReason,
                    };
                  } else {
                    completion = checked.data;
                  }
                }
              }
            }
          }
        } catch {
          failureCategory = signal.aborted ? "TIMEOUT" : "TRANSPORT";
        }

        const usage = normalizeUsage(completion?.usage);
        attempts.push({
          provider: providerName,
          requestedModel: model,
          attemptNumber,
          durationMilliseconds: performance.now() - started,
          ...(status === undefined ? {} : { httpStatus: status }),
          ...(failureCategory === undefined ? {} : { failureCategory }),
          ...(failureDetail === undefined ? {} : { failureDetail }),
          ...(completion === undefined
            ? {}
            : {
                actualModel: completion.model,
                ...(usage === undefined ? {} : { usage }),
              }),
        });
        await observer?.afterAttempt(attempts.at(-1)!);

        if (completion !== undefined) {
          return {
            ok: true,
            text: completion.choices[0]!.message.content,
            requestedModel: model,
            actualModel: completion.model,
            ...(usage === undefined ? {} : { usage }),
            attempts,
          };
        }
        return {
          ok: false,
          failureCategory: failureCategory ?? "INVALID_RESPONSE",
          attempts,
        };
      }

      const first = await call();
      if (
        first.ok ||
        maxAttempts < 2 ||
        !retryable(first.failureCategory, first.attempts.at(-1)?.httpStatus)
      )
        return first;

      const second = await call();
      if (
        second.ok ||
        maxAttempts < 3 ||
        !retryable(second.failureCategory, second.attempts.at(-1)?.httpStatus)
      )
        return second;

      return call();
    },
  };
}
