import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { isOneTimeToken } from "./one-time-token.ts";

const PURPOSE = "stockwise.invitation-continuation.v2";
const MAX_ENCRYPTIONS = 2 ** 24;
const MAX_COOKIE_BYTES = 512;
const PREFIX = "__Host-stockwise_invitation_slot_";
const SLOTS = [0, 1, 2, 3] as const;
let encryptions = 0;

export interface InvitationContinuation {
  expiresAt: number;
  flowId: string;
  issuedAt: number;
  sessionDigest: string | null;
  token: string;
}

export function parseInvitationContinuationKey(
  value: string | undefined,
): Buffer {
  if (value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error(
      "STOCKWISE_INVITATION_CONTINUATION_KEY must be exactly 32 canonical base64url bytes.",
    );
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value)
    throw new Error(
      "STOCKWISE_INVITATION_CONTINUATION_KEY must be exactly 32 canonical base64url bytes.",
    );
  return key;
}

function isCanonicalBase64Url32(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

export function hashContinuationSessionCredential(
  value: string | null,
): string | null {
  return value === null
    ? null
    : createHash("sha256").update(value, "utf8").digest("base64url");
}
function decodeSessionCredential(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
export function invitationContinuationCookieName(slot: number): string {
  if (!SLOTS.includes(slot as 0 | 1 | 2 | 3))
    throw new Error("Invalid invitation continuation slot.");
  return `${PREFIX}${slot}`;
}
function aad(slot: number, flowId: string, origin: string): Buffer {
  return Buffer.from(
    `${PURPOSE}\n${invitationContinuationCookieName(slot)}\n${slot}\n${flowId}\n${origin}\n2`,
    "utf8",
  );
}

export function encryptInvitationContinuation(input: {
  continuation: InvitationContinuation;
  flowId: string;
  slot: number;
  key: Buffer;
  origin: string;
}): string {
  if (++encryptions > MAX_ENCRYPTIONS)
    throw new Error("Invitation continuation encryption limit reached.");
  if (
    !SLOTS.includes(input.slot as 0 | 1 | 2 | 3) ||
    !isCanonicalBase64Url32(input.flowId) ||
    input.continuation.flowId !== input.flowId ||
    !isOneTimeToken(input.continuation.token)
  )
    throw new Error("Invalid invitation continuation payload.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  cipher.setAAD(aad(input.slot, input.flowId, input.origin));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ v: 2, ...input.continuation }), "utf8"),
    cipher.final(),
  ]);
  const payload = Buffer.concat([
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
  const value = `2.${input.slot}.${input.flowId}.${payload}`;
  if (Buffer.byteLength(value, "ascii") > MAX_COOKIE_BYTES)
    throw new Error(
      "Invitation continuation cookie exceeds the fixed value limit.",
    );
  return value;
}

export function continuationCookieHint(
  value: string,
): { slot: number; flowId: string } | null {
  const match = /^(2)\.([0-3])\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]+)$/.exec(
    value,
  );
  if (
    !match ||
    Buffer.byteLength(value, "ascii") > MAX_COOKIE_BYTES ||
    !isCanonicalBase64Url32(match[3])
  )
    return null;
  return { slot: Number(match[2]), flowId: match[3] };
}

export function decryptInvitationContinuation(input: {
  value: string;
  flowId: string;
  slot: number;
  key: Buffer;
  origin: string;
  now?: number;
}): InvitationContinuation | null {
  if (
    !SLOTS.includes(input.slot as 0 | 1 | 2 | 3) ||
    !isCanonicalBase64Url32(input.flowId) ||
    Buffer.byteLength(input.value, "ascii") > MAX_COOKIE_BYTES
  )
    return null;
  const hint = continuationCookieHint(input.value);
  if (!hint || hint.slot !== input.slot || hint.flowId !== input.flowId)
    return null;
  const payload = input.value.split(".")[3]!;
  const envelope = Buffer.from(payload, "base64url");
  if (envelope.toString("base64url") !== payload || envelope.length < 29)
    return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      input.key,
      envelope.subarray(0, 12),
    );
    decipher.setAAD(aad(input.slot, input.flowId, input.origin));
    decipher.setAuthTag(envelope.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(envelope.subarray(28)),
      decipher.final(),
    ]);
    if (plaintext.length > 2048) return null;
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const item = parsed as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !==
        "expiresAt,flowId,issuedAt,sessionDigest,token,v" ||
      item.v !== 2 ||
      item.flowId !== input.flowId ||
      !isOneTimeToken(String(item.token)) ||
      !Number.isSafeInteger(item.issuedAt) ||
      !Number.isSafeInteger(item.expiresAt) ||
      (item.sessionDigest !== null &&
        !isCanonicalBase64Url32(item.sessionDigest))
    )
      return null;
    const now = input.now ?? Date.now();
    if (
      (item.issuedAt as number) > now ||
      (item.expiresAt as number) <= now ||
      (item.expiresAt as number) - (item.issuedAt as number) > 30 * 60_000
    )
      return null;
    return {
      expiresAt: item.expiresAt as number,
      flowId: input.flowId,
      issuedAt: item.issuedAt as number,
      sessionDigest: item.sessionDigest as string | null,
      token: item.token as string,
    };
  } catch {
    return null;
  }
}

export function serializeInvitationContinuationCookie(
  slot: number,
  value: string,
  expiresAt: number,
): string {
  const hint = continuationCookieHint(value);
  if (hint === null || hint.slot !== slot)
    throw new Error("Invalid fixed-slot invitation continuation cookie value.");
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${invitationContinuationCookieName(slot)}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}`;
}
export function clearInvitationContinuationCookie(slot: number): string {
  return `${invitationContinuationCookieName(slot)}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
export function readInvitationContinuationCookies(
  header: string | undefined,
): Map<number, string> | null {
  const cookies = new Map<number, string>();
  if (header === undefined) return cookies;
  for (const segment of header.split(";")) {
    const part = segment.trim();
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index);
    if (!name.startsWith(PREFIX)) continue;
    const suffix = name.slice(PREFIX.length);
    if (!/^[0-3]$/.test(suffix)) continue;
    const slot = Number(suffix);
    const value = part.slice(index + 1);
    if (
      !value ||
      Buffer.byteLength(value, "ascii") > MAX_COOKIE_BYTES ||
      cookies.has(slot)
    )
      return null;
    cookies.set(slot, value);
  }
  return cookies;
}
export function clearPresentedInvitationContinuationCookies(
  header: string | undefined,
  legacyOnly = false,
): string[] {
  if (header === undefined) return [];
  const slots = new Set<number>();
  const legacy: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name.startsWith(PREFIX)) {
      const s = name.slice(PREFIX.length);
      if (/^[0-3]$/.test(s)) {
        if (!legacyOnly) slots.add(Number(s));
        continue;
      }
    }
    const oldPrefix = "__Host-stockwise_invitation_";
    if (name.startsWith(oldPrefix)) {
      const flow = name.slice(oldPrefix.length);
      if (
        isCanonicalBase64Url32(flow) &&
        !legacy.includes(flow) &&
        legacy.length < 16
      )
        legacy.push(flow);
    }
  }
  return [
    ...Array.from(slots, clearInvitationContinuationCookie),
    ...legacy.map(
      (flow) =>
        `__Host-stockwise_invitation_${flow}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    ),
  ];
}
export function clearSelectedInvitationContinuationCookie(
  header: string | undefined,
  flowId: string,
  key: Buffer,
  origin: string,
): string | null {
  const cookies = readInvitationContinuationCookies(header);
  if (!cookies) return null;
  let selectedSlot: number | null = null;
  for (const [slot, value] of cookies) {
    const hint = continuationCookieHint(value);
    if (hint?.flowId !== flowId || hint.slot !== slot) continue;
    if (
      selectedSlot !== null ||
      decryptInvitationContinuation({ value, flowId, slot, key, origin }) ===
        null
    )
      return null;
    selectedSlot = slot;
  }
  return selectedSlot === null
    ? null
    : clearInvitationContinuationCookie(selectedSlot);
}
export function readContinuationSessionCredential(
  header: string | undefined,
): string | null {
  if (header === undefined) return null;
  const values: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    if (
      [
        "stockwise_session",
        "__Secure-stockwise_session",
        "stockwise_native.session_token",
        "__Secure-stockwise_native.session_token",
      ].includes(name)
    ) {
      const decoded = decodeSessionCredential(
        segment.slice(separator + 1).trim(),
      );
      if (decoded === null) return null;
      values.push(decoded);
    }
  }
  return values.length === 1 && values[0]!.length > 0 ? values[0]! : null;
}
export function loginContinuationCookies(input: {
  cookieHeader: string | undefined;
  flowHeader: string | undefined;
  key: Buffer;
  newSessionCredential: string;
  origin: string;
}): string[] {
  const all = clearPresentedInvitationContinuationCookies(input.cookieHeader);
  const cookies = readInvitationContinuationCookies(input.cookieHeader);
  const flowId = input.flowHeader;
  if (!cookies || !isCanonicalBase64Url32(flowId)) return all;

  let selected: { slot: number; value: string } | null = null;
  for (const [slot, value] of cookies) {
    const hint = continuationCookieHint(value);
    if (hint?.slot !== slot || hint.flowId !== flowId) continue;
    if (selected !== null) return all;
    selected = { slot, value };
  }
  if (selected === null) return all;

  const priorSession = readContinuationSessionCredential(input.cookieHeader);
  const continuation = decryptInvitationContinuation({
    value: selected.value,
    flowId,
    slot: selected.slot,
    key: input.key,
    origin: input.origin,
  });
  if (
    !continuation ||
    continuation.sessionDigest !==
      hashContinuationSessionCredential(priorSession)
  )
    return all;
  const nextSession = decodeSessionCredential(input.newSessionCredential);
  if (nextSession === null) return all;
  const encrypted = encryptInvitationContinuation({
    continuation: {
      ...continuation,
      sessionDigest: hashContinuationSessionCredential(nextSession),
    },
    flowId,
    slot: selected.slot,
    key: input.key,
    origin: input.origin,
  });
  return [
    ...all.filter(
      (cookie) =>
        !cookie.startsWith(
          `${invitationContinuationCookieName(selected.slot)}=`,
        ),
    ),
    serializeInvitationContinuationCookie(
      selected.slot,
      encrypted,
      continuation.expiresAt,
    ),
  ];
}
