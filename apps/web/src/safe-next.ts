/**
 * A post-login return target taken from `?next=`. Only a same-origin,
 * absolute-path URL is honoured: it must start with a single "/" and contain
 * no backslash, control character or scheme, so `//evil.test`, `/\evil.test`,
 * `https://evil.test` and `javascript:` all fall back to the default.
 * Authentication-only pages are refused so a login can never loop onto itself.
 */
const BLOCKED_PREFIXES = [
  "/login",
  "/register",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/verification-resend",
];

export function safeNextPath(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, "http://stockwise.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://stockwise.invalid") return fallback;
  const path = url.pathname;
  if (
    BLOCKED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  )
    return fallback;
  return `${path}${url.search}${url.hash}`;
}

/** `/login?next=<encoded path>`; omits `next` when the target is not safe. */
export function loginUrlWithNext(target: string): string {
  const safe = safeNextPath(target, "");
  return safe === "" || safe === "/"
    ? "/login"
    : `/login?next=${encodeURIComponent(safe)}`;
}
