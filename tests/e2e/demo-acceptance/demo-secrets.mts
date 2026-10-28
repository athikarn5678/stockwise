import { createHmac } from "node:crypto";

/**
 * Derives a synthetic demo password from a per-run seed. Shared by the suite
 * and its runner so the runner can scan retained outputs for leaks without the
 * password ever being written anywhere.
 */
export function derivePassword(secretSeed: string, label: string): string {
  return createHmac("sha256", secretSeed)
    .update(`demo-password:${label}`)
    .digest("base64url");
}
