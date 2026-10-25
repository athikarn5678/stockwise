import type { QueryClient } from "@tanstack/react-query";
import { clearContinuation } from "@/verification-continuation-browser";

export const SESSION_CHANGE_EVENT = "stockwise:session-change";
export const SESSION_UNAUTHORIZED_EVENT = "stockwise:session-unauthorized";
export const SESSION_CHANNEL = "stockwise.session-change";
export interface SessionChangeHint {
  version: 1;
  type: "session-change";
  id: string;
}

let privateRequests: AbortController | undefined;
const responseSignals = new WeakMap<Response, AbortSignal>();

export function discardPrivateSession(client: QueryClient) {
  privateRequests?.abort();
  privateRequests = undefined;
  // Cancellation is synchronous; a fetch ignoring AbortSignal cannot refill
  // a removed query. No private cache allowlist can silently miss a new module.
  void client.cancelQueries();
  client.clear();
}

export function notifySessionChange(client: QueryClient) {
  discardPrivateSession(client);
  clearContinuation();
  window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
}

export function isSessionChangeHint(
  value: unknown,
): value is SessionChangeHint {
  if (typeof value !== "object" || value === null) return false;
  return (
    Object.keys(value).length === 3 &&
    "version" in value &&
    value.version === 1 &&
    "type" in value &&
    value.type === "session-change" &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 80
  );
}

export function currentPrivateSessionSignal(): AbortSignal {
  privateRequests ??= new AbortController();
  return privateRequests.signal;
}

export async function privateFetch(path: string, init?: RequestInit) {
  const generationSignal = currentPrivateSessionSignal();
  const signal = init?.signal
    ? AbortSignal.any([init.signal, generationSignal])
    : generationSignal;
  const response = await fetch(path, { ...init, signal });
  // Fetch stubs and already-completed responses need the same generation guard.
  signal.throwIfAborted();
  responseSignals.set(response, signal);
  if (
    typeof window !== "undefined" &&
    response.status === 401 &&
    path !== "/api/v1/me/access-context" &&
    // Anonymous recipients may open an invitation link before signing in.
    // Preserve its explicit recovery UI instead of globally unmounting it.
    path !== "/api/v1/invitations/accept"
  ) {
    window.dispatchEvent(new Event(SESSION_UNAUTHORIZED_EVENT));
  }
  return response;
}

export async function readPrivateJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  // A body parse can finish after cancellation, including in mock transports.
  responseSignals.get(response)?.throwIfAborted();
  return body;
}
