import { appendFileSync, lstatSync } from "node:fs";

import {
  CaptureStoreRefusal,
  assertPrivateCaptureFile,
  defaultStoreDeps,
  type StoreDeps,
} from "./browser-capture-store.mts";
import {
  verifyLocalPostgresReceipt,
  type LocalPostgresReceipt,
} from "./local-runner.mts";

/**
 * TEST-ONLY controlled mail capture for real-browser acceptance. It is a Node
 * `--import` preload for the unmodified `apps/api/src/main.ts`: it replaces the
 * `send` method of the exported non-delivery provider object, so the actual
 * Native API, routers, OTP/link/reset/invitation issuance, hashing, expiry and
 * consumption run unchanged and only the final "deliver" step records locally.
 *
 * It opens no listener and adds no endpoint. Captured messages are appended to
 * one JSON-lines file owned by the launcher. Only addresses matching
 * `SYNTHETIC_RECIPIENT` are recorded; any other recipient is silently ignored,
 * exactly like non-delivery, so a real address can never be captured or
 * mailed. Nothing is ever sent. The preload refuses to load (the API then
 * exits) unless every guard below holds.
 */
export const SYNTHETIC_RECIPIENT =
  /^d5br-[a-z0-9][a-z0-9.-]{0,40}@example\.invalid$/;
export const MAX_CAPTURED_MESSAGES = 200;

type Environment = Readonly<Record<string, string | undefined>>;

export class MailCaptureRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`BROWSER_MAIL_CAPTURE_REFUSED:${reason}`);
    this.name = "MailCaptureRefusal";
    this.reason = reason;
  }
}

export function loopbackReceiptDatabase(
  environment: Environment,
): LocalPostgresReceipt {
  let receipt: unknown;
  try {
    receipt = JSON.parse(environment.STOCKWISE_LOCAL_DATABASE_RECEIPT ?? "");
  } catch {
    throw new MailCaptureRefusal("RECEIPT_MISSING");
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new MailCaptureRefusal("DATABASE_URL_MISSING");
  let appUrl: string;
  try {
    // The API connects to the receipt's test database; the receipt validator
    // also expects its application database on the same host and port.
    const url = new URL(databaseUrl);
    url.pathname = "/stockwise_test";
    appUrl = url.toString();
  } catch {
    throw new MailCaptureRefusal("DATABASE_URL_INVALID");
  }
  if (!verifyLocalPostgresReceipt(receipt, appUrl, databaseUrl))
    throw new MailCaptureRefusal("RECEIPT_MISMATCH");
  return receipt;
}

/** Throws unless this process is a receipt-bound, test-runtime, non-delivery API. */
export function admitCapture(
  environment: Environment,
  deps: StoreDeps = defaultStoreDeps,
): { file: string } {
  if (environment.STOCKWISE_BROWSER_MAIL_CAPTURE !== "synthetic-only")
    throw new MailCaptureRefusal("OPT_IN_REQUIRED");
  if (environment.STOCKWISE_RUNTIME_ENV !== "test")
    throw new MailCaptureRefusal("RUNTIME_NOT_TEST");
  if (environment.STOCKWISE_EMAIL_PROVIDER !== "non_delivery")
    throw new MailCaptureRefusal("PROVIDER_NOT_NON_DELIVERY");
  if (environment.RESEND_API_KEY !== undefined)
    throw new MailCaptureRefusal("DELIVERY_CREDENTIAL_PRESENT");
  loopbackReceiptDatabase(environment);
  const file = environment.STOCKWISE_BROWSER_MAIL_CAPTURE_FILE;
  if (!file) throw new MailCaptureRefusal("CAPTURE_FILE_INVALID");
  // The file must sit in a private, marked, launcher-created capture directory.
  try {
    assertPrivateCaptureFile(file, deps);
  } catch (error) {
    if (error instanceof CaptureStoreRefusal)
      throw new MailCaptureRefusal(`CAPTURE_STORE_${error.reason}`);
    throw error;
  }
  return { file };
}

type Message = Readonly<{
  kind: string;
  recipient: string;
  url: string;
  code?: string;
}>;

// Cheap per-write guard: the admitted regular file must not have been replaced
// by a link since admission (the ACL itself is verified at admission).
function appendToPrivateFile(path: string, line: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
    throw new MailCaptureRefusal("CAPTURE_FILE_REPLACED");
  appendFileSync(path, line, { encoding: "utf8", flag: "a" });
}

export function createCaptureRecorder(
  file: string,
  append: (file: string, line: string) => void = (path, line) =>
    appendToPrivateFile(path, line),
  now: () => Date = () => new Date(),
) {
  let sequence = 0;
  return {
    record(message: Message): boolean {
      if (!SYNTHETIC_RECIPIENT.test(message.recipient)) return false;
      if (sequence >= MAX_CAPTURED_MESSAGES) {
        if (sequence === MAX_CAPTURED_MESSAGES) {
          sequence++;
          append(file, `${JSON.stringify({ overflow: true })}\n`);
        }
        return false;
      }
      sequence++;
      append(
        file,
        `${JSON.stringify({
          seq: sequence,
          at: now().toISOString(),
          kind: message.kind,
          recipient: message.recipient,
          url: message.url,
          ...(message.code === undefined ? {} : { code: message.code }),
        })}\n`,
      );
      return true;
    },
  };
}

/** Replaces only `send`; resolves like non-delivery whether or not recorded. */
export function installCapture<M extends Message>(
  provider: { send: (message: M, signal?: AbortSignal) => Promise<void> },
  recorder: ReturnType<typeof createCaptureRecorder>,
): void {
  provider.send = async (message) => {
    recorder.record(message);
  };
}

export async function activate(environment: Environment): Promise<void> {
  const { file } = admitCapture(environment);
  const { nonDeliveryEmailProvider } = await import(
    new URL(
      "../../../apps/api/src/modules/identity/email-provider.ts",
      import.meta.url,
    ).href
  );
  installCapture(nonDeliveryEmailProvider, createCaptureRecorder(file));
}

// Loaded through `node --import`; any refusal aborts API startup.
if (process.env.STOCKWISE_BROWSER_MAIL_CAPTURE_PRELOAD === "1") {
  await activate(process.env);
}
