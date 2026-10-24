import { DUMMY_PASSWORD_HASH } from "./password-hasher.ts";

const NATIVE_DUMMY =
  "$argon2id$v=19$m=65536,p=4,t=3$MELWslgkJzw87Me69Wz1tw$l9XoBv1UBhpmS40M2xzT5cHzqoSubftPd1Md5u/ZmvQ";

function legacyPasswordIdentity(value: string): string | null {
  const match =
    /^\$argon2id\$v=19\$m=65536,(?:t=3,p=4|p=4,t=3)\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/.exec(
      value,
    );
  if (
    !match ||
    ![match[1], match[2]].every(
      (part) =>
        part !== undefined &&
        Buffer.from(part, "base64").toString("base64").replace(/=+$/, "") ===
          part,
    )
  )
    return null;
  // Comparison only: transferred credential bytes are never normalized.
  return `$argon2id$v=19$m=65536,t=3,p=4$${match[1]}$${match[2]}`;
}

const publicDummyIdentities = new Set(
  [DUMMY_PASSWORD_HASH, NATIVE_DUMMY].map(legacyPasswordIdentity),
);

/** Shared by the disposable transition and read-only application preflight. */
export function isTransferableLegacyPassword(value: string): boolean {
  const identity = legacyPasswordIdentity(value);
  return identity !== null && !publicDummyIdentities.has(identity);
}
