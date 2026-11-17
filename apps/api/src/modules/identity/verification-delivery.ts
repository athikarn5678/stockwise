import {
  EmailDeliveryError,
  type IdentityEmailProvider,
} from "./email-provider.ts";
import type { VerificationChallengeMaterial } from "./verification-security.ts";

interface VerificationDeliveryRepository {
  canDeliver(challengeId: string): Promise<boolean>;
  revokeDelivery(input: {
    challengeId: string;
    reason: "DELIVERY_FAILED" | "RESPONSE_ABORTED";
  }): Promise<void>;
}

const MAX_OUTSTANDING_DELIVERIES = 32;
const DELIVERY_TIMEOUT_MILLISECONDS = 10_000;

// Allowlisted operational metadata only. No account, token, provider body, or
// exception message is passed to logging.
export interface VerificationDeliveryFailure {
  stage:
    | "pre_send"
    | "provider_http"
    | "network"
    | "timeout"
    | "provider_unknown"
    | "compensation_failure";
  providerHttpStatus?: number;
}

export interface VerificationResponseDelivery {
  finish(): void;
  abort(): void;
}

export interface VerificationDeliveryReservation {
  release(): void;
  prepare(input: {
    prepared: VerificationChallengeMaterial;
    recipient: string;
  }): VerificationResponseDelivery;
}

export interface VerificationDelivery {
  reserve(): VerificationDeliveryReservation | null;
  drain(): Promise<void>;
}

export function createVerificationDelivery({
  emailProvider,
  publicWebOrigin,
  repository,
  onFailure = () => undefined,
}: {
  emailProvider: IdentityEmailProvider;
  publicWebOrigin: string;
  repository: VerificationDeliveryRepository;
  onFailure?: (
    kind: "verification" | "verification_compensation",
    failure: VerificationDeliveryFailure,
  ) => void;
}): VerificationDelivery {
  let outstanding = 0;
  let stopping = false;
  let shutdownExpired = false;
  let drainCompletion: PromiseWithResolvers<void> | null = null;
  const controllers = new Set<AbortController>();
  const jobs = new Set<Promise<void>>();

  function track(job: Promise<void>): void {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => undefined);
  }

  async function compensate(
    challengeId: string,
    reason: "DELIVERY_FAILED" | "RESPONSE_ABORTED",
  ): Promise<void> {
    try {
      await repository.revokeDelivery({ challengeId, reason });
    } catch {
      onFailure("verification_compensation", {
        stage: "compensation_failure",
      });
    }
  }

  return {
    reserve() {
      if (stopping || outstanding >= MAX_OUTSTANDING_DELIVERIES) return null;
      outstanding += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          outstanding -= 1;
          if (outstanding === 0) drainCompletion?.resolve();
        }
      };
      return {
        release,
        prepare({
          prepared: {
            challenge: { id: challengeId },
            code,
            rawLinkToken,
          },
          recipient,
        }) {
          let started = false;
          return {
            finish() {
              if (started || released) return;
              started = true;
              track(
                (async () => {
                  let sendStarted = false;
                  let timedOut = false;
                  try {
                    if (shutdownExpired)
                      throw new Error("Verification delivery drain expired.");
                    if (!(await repository.canDeliver(challengeId))) return;
                    if (shutdownExpired)
                      throw new Error("Verification delivery drain expired.");
                    const url = new URL("/verify-email", publicWebOrigin);
                    url.searchParams.set("token", rawLinkToken);
                    const controller = new AbortController();
                    controllers.add(controller);
                    let timer: NodeJS.Timeout | undefined;
                    try {
                      sendStarted = true;
                      await Promise.race([
                        emailProvider.send(
                          {
                            kind: "verification",
                            recipient,
                            url: url.toString(),
                            code,
                          },
                          controller.signal,
                        ),
                        new Promise<never>((_resolve, reject) => {
                          timer = setTimeout(() => {
                            timedOut = true;
                            controller.abort(
                              new DOMException(
                                "Verification delivery timed out.",
                                "TimeoutError",
                              ),
                            );
                            reject(new EmailDeliveryError("timeout"));
                          }, DELIVERY_TIMEOUT_MILLISECONDS);
                        }),
                      ]);
                    } finally {
                      clearTimeout(timer);
                      controllers.delete(controller);
                    }
                  } catch (error: unknown) {
                    const failure: VerificationDeliveryFailure = !sendStarted
                      ? { stage: "pre_send" }
                      : timedOut
                        ? { stage: "timeout" }
                        : error instanceof EmailDeliveryError
                          ? {
                              stage: error.category,
                              ...(error.httpStatus === undefined
                                ? {}
                                : { providerHttpStatus: error.httpStatus }),
                            }
                          : { stage: "provider_unknown" };
                    onFailure("verification", failure);
                    await compensate(challengeId, "DELIVERY_FAILED");
                  } finally {
                    release();
                  }
                })(),
              );
            },
            abort() {
              if (started || released) return;
              started = true;
              track(
                compensate(challengeId, "RESPONSE_ABORTED").finally(release),
              );
            },
          };
        },
      };
    },
    async drain() {
      stopping = true;
      if (outstanding === 0) return;
      drainCompletion ??= Promise.withResolvers<void>();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          drainCompletion.promise,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              shutdownExpired = true;
              for (const controller of controllers) controller.abort();
              resolve();
            }, DELIVERY_TIMEOUT_MILLISECONDS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
