import { z } from "zod";
import { canUseInvitationContinuationStorage } from "@/invitation-continuation";
import { withOriginCookieMutationLock } from "@/session-lifecycle";

const flowSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const envelope = z.object({ error: z.object({ code: z.string() }) });
const captureResponse = z.object({
  data: z.object({
    expiresAt: z.string().datetime({ offset: false, precision: 3 }),
  }),
});
const resumeResponse = z.object({
  data: z.object({
    status: z.literal("ready"),
    expiresAt: z.string().datetime({ offset: false, precision: 3 }),
  }),
});
const acceptResponse = z.object({
  data: z.object({
    membership: z.object({ organization: z.object({ id: z.string() }) }),
    replayed: z.boolean(),
  }),
});

export type InvitationContinuationErrorKind =
  | "invalid_invitation_continuation"
  | "invalid_invitation"
  | "continuation_limit"
  | "authentication_required"
  | "invitation_scope_invalid"
  | "unavailable";
export class InvitationContinuationApiError extends Error {
  constructor(readonly kind: InvitationContinuationErrorKind) {
    super(kind);
    this.name = "InvitationContinuationApiError";
  }
}

async function post<T>(
  path: string,
  flowId: string,
  body: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!flowSchema.safeParse(flowId).success)
    throw new InvitationContinuationApiError("invalid_invitation_continuation");
  if (!canUseInvitationContinuationStorage())
    throw new InvitationContinuationApiError("unavailable");
  try {
    return await withOriginCookieMutationLock(async () => {
      let response: Response;
      try {
        response = await fetch(`/api/v1/invitations/continuations${path}`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "X-Stockwise-Invitation-Flow": flowId,
          },
          referrerPolicy: "no-referrer",
          body: JSON.stringify(body),
        });
      } catch {
        throw new InvitationContinuationApiError("unavailable");
      }
      if (response.status === 204 && response.ok && path === "/cancel")
        return schema.parse(undefined);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new InvitationContinuationApiError("unavailable");
      }
      if (response.ok && response.status !== 200)
        throw new InvitationContinuationApiError("unavailable");
      if (!response.ok) {
        const parsed = envelope.safeParse(value);
        const code = parsed.success ? parsed.data.error.code : "";
        const kind: InvitationContinuationErrorKind =
          code === "INVALID_INVITATION_CONTINUATION"
            ? "invalid_invitation_continuation"
            : code === "INVALID_INVITATION"
              ? "invalid_invitation"
              : code === "INVITATION_CONTINUATION_LIMIT"
                ? "continuation_limit"
                : code === "AUTHENTICATION_REQUIRED"
                  ? "authentication_required"
                  : code === "INVITATION_SCOPE_INVALID"
                    ? "invitation_scope_invalid"
                    : "unavailable";
        throw new InvitationContinuationApiError(kind);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw new InvitationContinuationApiError("unavailable");
      return parsed.data;
    });
  } catch (error) {
    if (error instanceof InvitationContinuationApiError) throw error;
    throw new InvitationContinuationApiError("unavailable");
  }
}

export async function captureInvitationContinuation(
  flowId: string,
  token: string,
) {
  return post("", flowId, { token }, captureResponse);
}
export async function resumeInvitationContinuation(flowId: string) {
  return post("/resume", flowId, {}, resumeResponse);
}
export async function acceptInvitationContinuation(flowId: string) {
  return post("/accept", flowId, {}, acceptResponse);
}
export async function cancelInvitationContinuation(
  flowId: string,
): Promise<void> {
  return post("/cancel", flowId, {}, z.undefined());
}
