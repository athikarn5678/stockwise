export type AiProviderFailureCategory =
  | "TIMEOUT"
  | "TRANSPORT"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "AUTHENTICATION"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "PROVIDER_ERROR";

export type AiProviderUsage = Readonly<{
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: string;
}>;

export type AiProviderName = "openrouter" | "opencode-go" | "seeded-template";

export type AiProviderAttempt = Readonly<{
  provider: AiProviderName;
  requestedModel: string;
  attemptNumber: number;
  durationMilliseconds: number;
  httpStatus?: number;
  failureCategory?: AiProviderFailureCategory;
  actualModel?: string;
  usage?: AiProviderUsage;
}>;

export type AiProviderResult =
  | Readonly<{
      ok: true;
      text: string;
      requestedModel: AiProviderAttempt["requestedModel"];
      actualModel: string;
      usage?: AiProviderUsage;
      attempts: readonly AiProviderAttempt[];
    }>
  | Readonly<{
      ok: false;
      failureCategory: AiProviderFailureCategory;
      attempts: readonly AiProviderAttempt[];
    }>;

export type AiProviderAttemptObserver = Readonly<{
  beforeAttempt(
    attempt: Pick<
      AiProviderAttempt,
      "provider" | "requestedModel" | "attemptNumber"
    >,
  ): Promise<void>;
  afterAttempt(attempt: AiProviderAttempt): Promise<void>;
}>;

export interface AiProvider {
  generate(
    input: Readonly<{ text: string }>,
    observer?: AiProviderAttemptObserver,
  ): Promise<AiProviderResult>;
}
