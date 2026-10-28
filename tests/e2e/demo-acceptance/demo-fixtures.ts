import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { derivePassword } from "./demo-secrets.mts";

/**
 * TEST-ONLY helpers for the STOCKWISE-DEMO-E2E-01 demo acceptance suite. The
 * suite drives the real Next.js + unmodified Native API started by
 * `tests/e2e/better-auth-d5/browser-stack.mts`; mail comes only from that
 * stack's controlled capture file. Passwords, OTPs and links stay in test
 * memory: nothing here logs, prints or writes them.
 */
export const WEB_ORIGIN = "http://localhost:3202";

type StackReady = Readonly<{
  webOrigin: string;
  mailCaptureFile: string;
  authority: string;
}>;

function readStack(): StackReady {
  const file = process.env.DEMO_STACK_READY_FILE;
  if (!file) throw new Error("DEMO_STACK_READY_FILE_MISSING");
  const ready = JSON.parse(readFileSync(file, "utf8")) as StackReady;
  if (ready.webOrigin !== WEB_ORIGIN || ready.authority !== "native")
    throw new Error("DEMO_STACK_NOT_NATIVE");
  return ready;
}

// The runner supplies a per-run seed so it can scan outputs for the derived
// passwords afterwards; standalone runs fall back to a random in-memory seed.
const seed = process.env.DEMO_SECRET_SEED ?? randomBytes(32).toString("hex");
const runId = randomBytes(6).toString("hex");

export function demoPassword(label: string): string {
  return derivePassword(seed, label);
}

/** Synthetic recipients must match the capture allow-list `d5br-*@example.invalid`. */
export function demoEmail(label: string): string {
  return `d5br-demo-${runId}-${label}@example.invalid`;
}

type CapturedMessage = Readonly<{
  seq: number;
  kind: string;
  recipient: string;
  url: string;
  code?: string;
}>;

function capturedMessages(): CapturedMessage[] {
  const text = readFileSync(readStack().mailCaptureFile, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CapturedMessage | { overflow: true })
    .filter((record): record is CapturedMessage => !("overflow" in record));
}

/**
 * Returns the newest captured message of `kind` for `recipient` newer than
 * `afterSeq`. Delivery follows the HTTP response by a few milliseconds.
 */
export async function nextMail(
  recipient: string,
  kind: "verification" | "invitation",
  afterSeq = 0,
): Promise<CapturedMessage> {
  let found: CapturedMessage | undefined;
  await expect
    .poll(
      () => {
        found = capturedMessages()
          .filter(
            (message) =>
              message.recipient === recipient &&
              message.kind === kind &&
              message.seq > afterSeq,
          )
          .at(-1);
        return found !== undefined;
      },
      { message: `captured ${kind} mail`, timeout: 10_000 },
    )
    .toBe(true);
  return found!;
}

/** Records unexpected HTTP 5xx responses and uncaught page errors per context. */
export class ReliabilityMonitor {
  readonly serverErrors: string[] = [];
  readonly pageErrors: string[] = [];

  watch(context: BrowserContext): void {
    context.on("response", (response) => {
      if (response.status() >= 500)
        this.serverErrors.push(
          `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
        );
    });
    const attach = (page: Page) =>
      page.on("pageerror", (error) =>
        this.pageErrors.push(`${error.name}: ${error.message.slice(0, 160)}`),
      );
    context.pages().forEach(attach);
    context.on("page", attach);
  }

  assertClean(): void {
    expect(this.serverErrors, "unexpected HTTP 5xx").toEqual([]);
    expect(this.pageErrors, "uncaught browser errors").toEqual([]);
  }
}

export async function newDemoContext(
  browser: Browser,
  monitor: ReliabilityMonitor,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN });
  monitor.watch(context);
  const page = await context.newPage();
  await page.addInitScript(() =>
    localStorage.setItem("stockwise.language", "en"),
  );
  return { context, page };
}

export async function accessContextStatus(page: Page): Promise<number> {
  return page.evaluate(
    async () => (await fetch("/api/v1/me/access-context")).status,
  );
}

export const test = base.extend<
  { monitor: ReliabilityMonitor },
  { stack: StackReady }
>({
  stack: [
    async ({ browserName }, use) => {
      if (browserName !== "chromium")
        throw new Error("DEMO_UNSUPPORTED_BROWSER");
      await use(readStack());
    },
    { scope: "worker" },
  ],
  monitor: async ({ stack }, use) => {
    expect(stack.authority).toBe("native");
    const monitor = new ReliabilityMonitor();
    await use(monitor);
    monitor.assertClean();
  },
});

export { expect };
