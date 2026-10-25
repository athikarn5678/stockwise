import { renderIdentityEmail } from "./email-templates.ts";

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MILLISECONDS = 10_000;

export type IdentityEmailMessage = Readonly<
  | { kind: "verification"; recipient: string; url: string; code: string }
  | { kind: "invitation" | "password_reset"; recipient: string; url: string }
>;

export interface IdentityEmailProvider {
  send(message: IdentityEmailMessage, signal?: AbortSignal): Promise<void>;
}

export type EmailDeliveryFailureCategory =
  "provider_http" | "network" | "timeout";

export class EmailDeliveryError extends Error {
  readonly category: EmailDeliveryFailureCategory;
  readonly httpStatus: number | undefined;

  constructor(
    category: EmailDeliveryFailureCategory = "network",
    httpStatus?: number,
  ) {
    super("Identity email delivery failed.");
    this.name = "EmailDeliveryError";
    this.category = category;
    this.httpStatus = category === "provider_http" ? httpStatus : undefined;
  }
}

function isTimeout(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  );
}

export const nonDeliveryEmailProvider: IdentityEmailProvider = {
  async send() {
    // Development intentionally performs no delivery and retains no token data.
  },
};

export interface RecordingIdentityEmailProvider extends IdentityEmailProvider {
  readonly messages: IdentityEmailMessage[];
}

export function createRecordingEmailProvider(): RecordingIdentityEmailProvider {
  const messages: IdentityEmailMessage[] = [];

  return {
    messages,
    async send(message) {
      messages.push(Object.freeze({ ...message }));
    },
  };
}

export function createResendEmailProvider({
  apiKey,
  fetchImplementation = fetch,
  from,
}: {
  apiKey: string;
  fetchImplementation?: typeof fetch;
  from: string;
}): IdentityEmailProvider {
  return {
    async send(message, signal) {
      const isVerification = message.kind === "verification";
      const isInvitation = message.kind === "invitation";
      const subject = isVerification
        ? "Verify your StockWise email"
        : isInvitation
          ? "Accept your StockWise invitation"
          : "Reset your StockWise password";

      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(RESEND_TIMEOUT_MILLISECONDS)
          : AbortSignal.any([
              signal,
              AbortSignal.timeout(RESEND_TIMEOUT_MILLISECONDS),
            ]);

      try {
        const response = await fetchImplementation(RESEND_EMAIL_ENDPOINT, {
          body: JSON.stringify({
            from,
            subject,
            ...renderIdentityEmail(message),
            to: [message.recipient],
          }),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "stockwise-api/1.0",
          },
          method: "POST",
          signal: requestSignal,
        });

        if (!response.ok) {
          // Status only: never parse, log or retain provider response bodies.
          throw new EmailDeliveryError("provider_http", response.status);
        }
      } catch (error: unknown) {
        if (error instanceof EmailDeliveryError) throw error;
        throw new EmailDeliveryError(
          isTimeout(error) || isTimeout(requestSignal.reason)
            ? "timeout"
            : "network",
        );
      }
    },
  };
}
