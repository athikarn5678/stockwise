import {
  EmailDeliveryError,
  type IdentityEmailMessage,
  type IdentityEmailProvider,
} from "../../../apps/api/src/modules/identity/email-provider.ts";

const ADMITTED_ACCOUNT = /^d4n3-[a-f0-9-]+@example\.invalid$/;

export interface PrivateIdentityMailbox {
  allowAccount(email: string): void;
  releaseAccount(email: string): void;
  next(email: string): Promise<IdentityEmailMessage>;
  queuedCount(email: string): number;
  clear(): void;
  provider: IdentityEmailProvider;
}

export function createPrivateIdentityMailbox(): PrivateIdentityMailbox {
  const admitted = new Set<string>();
  const queued = new Map<string, IdentityEmailMessage[]>();
  const waiting = new Map<
    string,
    {
      resolve(message: IdentityEmailMessage): void;
      reject(): void;
      timer: NodeJS.Timeout;
    }
  >();
  let closed = false;
  function cancel(email: string) {
    const waiter = waiting.get(email);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiting.delete(email);
      waiter.reject();
    }
  }
  return {
    allowAccount(email) {
      if (closed || !ADMITTED_ACCOUNT.test(email))
        throw new Error("Mailbox account is not admissible.");
      admitted.add(email);
    },
    releaseAccount(email) {
      admitted.delete(email);
      queued.delete(email);
      cancel(email);
    },
    next(email) {
      if (closed || !admitted.has(email) || waiting.has(email))
        return Promise.reject(new Error("Private delivery wait refused."));
      const message = queued.get(email)?.shift();
      if (message !== undefined) return Promise.resolve(message);
      const { promise, resolve, reject } =
        Promise.withResolvers<IdentityEmailMessage>();
      const fail = () =>
        reject(new Error("Private identity delivery unavailable."));
      const timer = setTimeout(() => {
        waiting.delete(email);
        fail();
      }, 5_000);
      waiting.set(email, { resolve, reject: fail, timer });
      return promise;
    },
    queuedCount(email) {
      return queued.get(email)?.length ?? 0;
    },
    clear() {
      closed = true;
      admitted.clear();
      queued.clear();
      for (const email of waiting.keys()) cancel(email);
    },
    provider: {
      async send(message, signal) {
        if (closed || signal?.aborted || !admitted.has(message.recipient))
          throw new EmailDeliveryError();
        const pending = waiting.get(message.recipient);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          waiting.delete(message.recipient);
          pending.resolve(Object.freeze({ ...message }));
          return;
        }
        const messages = queued.get(message.recipient) ?? [];
        if (messages.length >= 3) throw new EmailDeliveryError();
        messages.push(Object.freeze({ ...message }));
        queued.set(message.recipient, messages);
      },
    },
  };
}
