import { createHash } from "node:crypto";

const MAX_FAILURES = 5;
const WINDOW_MILLISECONDS = 15 * 60 * 1000;

interface LoginLimitEntry {
  failures: number;
  expiresAt: number;
}

export type LoginLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface LoginLimiter {
  check(canonicalEmail: string): LoginLimitResult;
  recordCredentialFailure(canonicalEmail: string): void;
  serializeByEmail<T>(
    canonicalEmail: string,
    action: () => Promise<T>,
  ): Promise<T>;
}

function limiterKey(canonicalEmail: string): string {
  return createHash("sha256").update(canonicalEmail).digest("base64url");
}

export function createLoginLimiter(now: () => number = Date.now): LoginLimiter {
  const entries = new Map<string, LoginLimitEntry>();
  const queues = new Map<string, Promise<void>>();

  function activeEntry(canonicalEmail: string): LoginLimitEntry | undefined {
    const key = limiterKey(canonicalEmail);
    const entry = entries.get(key);

    if (entry !== undefined && now() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }

    return entry;
  }

  async function serializeByEmail<T>(
    canonicalEmail: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = limiterKey(canonicalEmail);
    const previous = queues.get(key) ?? Promise.resolve();
    const { promise: current, resolve: release } =
      Promise.withResolvers<void>();
    queues.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (queues.get(key) === current) queues.delete(key);
    }
  }

  return {
    serializeByEmail,
    check(canonicalEmail) {
      const entry = activeEntry(canonicalEmail);

      if (entry === undefined || entry.failures < MAX_FAILURES) {
        return { allowed: true };
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((entry.expiresAt - now()) / 1000),
        ),
      };
    },

    recordCredentialFailure(canonicalEmail) {
      const key = limiterKey(canonicalEmail);
      const entry = activeEntry(canonicalEmail);

      if (entry === undefined) {
        entries.set(key, {
          failures: 1,
          expiresAt: now() + WINDOW_MILLISECONDS,
        });
        return;
      }

      entry.failures += 1;
    },
  };
}
