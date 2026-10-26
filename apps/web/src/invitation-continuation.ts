import { z } from "zod";

const KEY = "stockwise_invitation_continuation";
const RECOVERY_KEY = "stockwise_invitation_recovery";
const FLOW_ID = /^[A-Za-z0-9_-]{43}$/;
const recordSchema = z
  .object({
    version: z.literal(1),
    flowId: z.string().regex(FLOW_ID),
    expiresAt: z.string().datetime({ offset: false, precision: 3 }),
  })
  .strict();

export interface InvitationContinuation {
  version: 1;
  flowId: string;
  expiresAt: string;
}

export type InvitationContinuationState =
  | { status: "ready"; continuation: InvitationContinuation }
  | { status: "missing" | "unavailable" | "invalid" | "expired" };
let invitationRecoveryRequired = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function canUseInvitationContinuationStorage(): boolean {
  const target = storage();
  if (!target) return false;
  try {
    target.getItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadInvitationContinuation(
  now = Date.now(),
): InvitationContinuationState {
  const target = storage();
  if (!target) return { status: "unavailable" };
  let raw: string | null;
  try {
    raw = target.getItem(KEY);
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null) return { status: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    markInvitationRecoveryRequired();
    removeStoredContinuation(target);
    return { status: "invalid" };
  }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    markInvitationRecoveryRequired();
    removeStoredContinuation(target);
    return { status: "invalid" };
  }
  if (Date.parse(parsed.data.expiresAt) <= now) {
    markInvitationRecoveryRequired();
    removeStoredContinuation(target);
    return { status: "expired" };
  }
  return { status: "ready", continuation: parsed.data };
}

function removeStoredContinuation(target: Storage): void {
  try {
    target.removeItem(KEY);
  } catch {
    /* Recovery remains in document memory. */
  }
}

export function isInvitationRecoveryRequired(): boolean {
  try {
    return (
      invitationRecoveryRequired || storage()?.getItem(RECOVERY_KEY) === "1"
    );
  } catch {
    return invitationRecoveryRequired;
  }
}

export function clearInvitationRecoveryRequired(): void {
  invitationRecoveryRequired = false;
  try {
    storage()?.removeItem(RECOVERY_KEY);
  } catch {
    /* Document state remains usable. */
  }
}
export function markInvitationRecoveryRequired(): void {
  invitationRecoveryRequired = true;
  try {
    storage()?.setItem(RECOVERY_KEY, "1");
  } catch {
    /* No credential is retained. */
  }
}

export function saveInvitationContinuation(
  value: InvitationContinuation,
): boolean {
  const target = storage();
  if (
    !target ||
    !recordSchema.safeParse(value).success ||
    Date.parse(value.expiresAt) <= Date.now()
  )
    return false;
  try {
    target.setItem(KEY, JSON.stringify(value));
    clearInvitationRecoveryRequired();
    return true;
  } catch {
    return false;
  }
}

export function clearInvitationContinuation(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* Fail closed on next load. */
  }
  releaseInvitationFlowLock();
}
export function clearInvitationContinuationForFlow(flowId: string): boolean {
  const selected = loadInvitationContinuation();
  if (selected.status !== "ready" || selected.continuation.flowId !== flowId)
    return false;
  markInvitationRecoveryRequired();
  const target = storage();
  if (target) removeStoredContinuation(target);
  if (activeFlowLock?.flowId === flowId || pendingFlowId === flowId)
    releaseInvitationFlowLock();
  return true;
}

export function createInvitationFlowId(): string | null {
  try {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch {
    return null;
  }
}

export interface InvitationFlowLock {
  flowId: string;
  release(): void;
}

let activeFlowLock: InvitationFlowLock | null = null;
let pendingFlowId: string | null = null;
let pendingAcquire: Promise<InvitationFlowLock | null> | null = null;
let lockEpoch = 0;

export function releaseInvitationFlowLock(): void {
  lockEpoch++;
  pendingFlowId = null;
  pendingAcquire = null;
  activeFlowLock?.release();
}

export async function acquireInvitationFlowLock(
  flowId: string,
): Promise<InvitationFlowLock | null> {
  if (activeFlowLock?.flowId === flowId) return activeFlowLock;
  if (pendingFlowId === flowId && pendingAcquire) return pendingAcquire;
  releaseInvitationFlowLock();
  if (
    !FLOW_ID.test(flowId) ||
    typeof navigator === "undefined" ||
    !navigator.locks
  )
    return null;

  const epoch = lockEpoch;
  const { promise: acquired, resolve } =
    Promise.withResolvers<InvitationFlowLock | null>();
  pendingFlowId = flowId;
  pendingAcquire = acquired;
  try {
    void navigator.locks
      .request(
        `stockwise-invitation-${flowId}`,
        { mode: "exclusive", ifAvailable: true },
        async (browserLock) => {
          if (!browserLock || epoch !== lockEpoch || pendingFlowId !== flowId) {
            resolve(null);
            return;
          }
          let releaseHold!: () => void;
          const hold = new Promise<void>((resume) => {
            releaseHold = resume;
          });
          const owner: InvitationFlowLock = {
            flowId,
            release() {
              if (activeFlowLock === owner) activeFlowLock = null;
              releaseHold();
            },
          };
          activeFlowLock = owner;
          resolve(owner);
          await hold;
        },
      )
      .catch(() => resolve(null));
  } catch {
    resolve(null);
  }

  const result = await acquired;
  if (pendingAcquire === acquired) {
    pendingFlowId = null;
    pendingAcquire = null;
  }
  return epoch === lockEpoch ? result : null;
}

if (typeof window !== "undefined") {
  let hadPageHide = false;
  const restoreLock = () => {
    const selected = loadInvitationContinuation();
    if (selected.status !== "ready" || activeFlowLock) return;
    const flowId = selected.continuation.flowId;
    void acquireInvitationFlowLock(flowId).then((held) => {
      if (held) return;
      clearInvitationContinuationForFlow(flowId);
    });
  };
  window.addEventListener("pagehide", () => {
    hadPageHide = true;
    releaseInvitationFlowLock();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted && !hadPageHide) return;
    hadPageHide = false;
    restoreLock();
  });
  restoreLock();
}
