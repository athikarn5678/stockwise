import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { InvitationContinuationRepository } from "./invitation-continuation-repository.ts";
import { createCrossSiteRequestProtection } from "./credential-lifecycle-router.ts";
import { getTrustedAuthenticationContext } from "./authentication-context.ts";
import type { MembershipAccessService } from "./membership-access-service.ts";
import { isOneTimeToken } from "./one-time-token.ts";
import {
  type InvitationContinuation,
  clearPresentedInvitationContinuationCookies,
  clearSelectedInvitationContinuationCookie,
  continuationCookieHint,
  readContinuationSessionCredential,
  decryptInvitationContinuation,
  encryptInvitationContinuation,
  hashContinuationSessionCredential,
  parseInvitationContinuationKey,
  readInvitationContinuationCookies,
  serializeInvitationContinuationCookie,
} from "./invitation-continuation-cookie.ts";

const FLOW_HEADER = "X-Stockwise-Invitation-Flow";
const FLOW_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_HEADER = "X-Request-Id";
const MAX_AGE = 30 * 60_000;

function requestId(response: Response): string {
  return String(response.getHeader(REQUEST_ID_HEADER) ?? "unavailable");
}

function error(response: Response, status: number, code: string): void {
  response.status(status).json({
    error: {
      code,
      message:
        code === "AUTHENTICATION_REQUIRED"
          ? "Authentication is required."
          : "The invitation continuation is invalid or expired.",
      requestId: requestId(response),
    },
  });
}

function getFlowId(request: Request): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (
      request.rawHeaders[index]?.toLowerCase() === FLOW_HEADER.toLowerCase()
    ) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length !== 1 || !FLOW_PATTERN.test(values[0] ?? "")) return null;
  const bytes = Buffer.from(values[0]!, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === values[0]
    ? values[0]!
    : null;
}

function isEmptyObject(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  );
}

export function createInvitationContinuationRouter(input: {
  repository: InvitationContinuationRepository;
  key: string;
  publicWebOrigin: string;
  authenticationMiddleware: RequestHandler;
  membershipAccessService: MembershipAccessService;
}): Router {
  const router = Router();
  const key = parseInvitationContinuationKey(input.key);
  const protect = createCrossSiteRequestProtection(input.publicWebOrigin, true);

  function readSelected(request: Request, flowId: string) {
    const cookies = readInvitationContinuationCookies(request.headers.cookie);
    if (cookies === null) return null;
    let selected: InvitationContinuation | null = null;
    for (const [slot, value] of cookies) {
      const hint = continuationCookieHint(value);
      if (hint?.slot !== slot || hint.flowId !== flowId) continue;
      if (selected !== null) return null;
      selected = decryptInvitationContinuation({
        value,
        flowId,
        slot,
        key,
        origin: input.publicWebOrigin,
      });
      if (selected === null) return null;
    }
    return selected;
  }
  router.post(
    "/invitations/continuations",
    protect,
    async (request, response, next) => {
      const flowId = getFlowId(request);
      const body = request.body as Record<string, unknown> | null;
      if (
        flowId === null ||
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.token !== "string" ||
        !isOneTimeToken(body.token)
      ) {
        error(response, 400, "INVALID_INVITATION");
        return;
      }
      try {
        // Drain invalidated v1 cookies without clearing independent fixed-slot flows.
        for (const clear of clearPresentedInvitationContinuationCookies(
          request.headers.cookie,
          true,
        ))
          response.append("Set-Cookie", clear);
        const cookies = readInvitationContinuationCookies(
          request.headers.cookie,
        );
        if (cookies === null) {
          error(response, 400, "INVALID_INVITATION");
          return;
        }
        const now = Date.now();
        const invitation = await input.repository.findForToken(body.token);
        if (
          !invitation ||
          invitation.consumedAt !== null ||
          invitation.replacedAt !== null ||
          invitation.revokedAt !== null ||
          invitation.expiresAt.getTime() <= now
        ) {
          error(response, 400, "INVALID_INVITATION");
          return;
        }
        let slot: number | undefined;
        let selectedCount = 0;
        const sessionDigest = hashContinuationSessionCredential(
          readContinuationSessionCredential(request.headers.cookie),
        );
        for (const [presentedSlot, value] of cookies) {
          const hint = continuationCookieHint(value);
          if (hint?.slot !== presentedSlot || hint.flowId !== flowId) continue;
          if (++selectedCount > 1) {
            error(response, 400, "INVALID_INVITATION");
            return;
          }
          const previous = decryptInvitationContinuation({
            value,
            flowId,
            slot: presentedSlot,
            key,
            origin: input.publicWebOrigin,
          });
          if (previous === null) {
            error(response, 400, "INVALID_INVITATION");
            return;
          }
          if (
            previous.token !== body.token ||
            previous.sessionDigest !== sessionDigest
          ) {
            error(response, 409, "INVITATION_CONTINUATION_LIMIT");
            return;
          }
          slot = presentedSlot;
        }
        if (slot === undefined)
          slot = [0, 1, 2, 3].find((candidate) => !cookies.has(candidate));
        if (slot === undefined) {
          error(response, 409, "INVITATION_CONTINUATION_LIMIT");
          return;
        }
        const expiresAt = Math.min(
          now + MAX_AGE,
          invitation.expiresAt.getTime(),
        );
        const session = readContinuationSessionCredential(
          request.headers.cookie,
        );
        const encrypted = encryptInvitationContinuation({
          continuation: {
            expiresAt,
            flowId,
            issuedAt: now,
            sessionDigest: hashContinuationSessionCredential(session),
            token: body.token,
          },
          flowId,
          slot,
          key,
          origin: input.publicWebOrigin,
        });
        response.append(
          "Set-Cookie",
          serializeInvitationContinuationCookie(slot, encrypted, expiresAt),
        );
        response.status(200).json({
          data: { expiresAt: new Date(expiresAt).toISOString() },
          meta: { requestId: requestId(response) },
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.post(
    "/invitations/continuations/resume",
    protect,
    input.authenticationMiddleware,
    async (request, response, next) => {
      const flowId = getFlowId(request);
      const auth = getTrustedAuthenticationContext(response);
      if (!isEmptyObject(request.body)) {
        error(response, 400, "INVALID_INVITATION_CONTINUATION");
        return;
      }
      if (auth === null) {
        error(response, 401, "AUTHENTICATION_REQUIRED");
        return;
      }
      try {
        const continuation =
          flowId === null ? null : readSelected(request, flowId);
        const session = readContinuationSessionCredential(
          request.headers.cookie,
        );
        if (
          continuation === null ||
          session === null ||
          continuation.sessionDigest !==
            hashContinuationSessionCredential(session)
        ) {
          if (flowId !== null) {
            const selectedClear = clearSelectedInvitationContinuationCookie(
              request.headers.cookie,
              flowId,
              key,
              input.publicWebOrigin,
            );
            if (selectedClear !== null)
              response.append("Set-Cookie", selectedClear);
          }
          error(response, 400, "INVALID_INVITATION_CONTINUATION");
          return;
        }
        const invitation = await input.repository.findForToken(
          continuation.token,
        );
        if (
          !invitation ||
          invitation.consumedAt !== null ||
          invitation.replacedAt !== null ||
          invitation.revokedAt !== null ||
          invitation.expiresAt.getTime() <= Date.now() ||
          invitation.invitedEmail !== auth.actor.email
        ) {
          const selectedClear = clearSelectedInvitationContinuationCookie(
            request.headers.cookie,
            flowId!,
            key,
            input.publicWebOrigin,
          );
          if (selectedClear !== null)
            response.append("Set-Cookie", selectedClear);
          error(response, 400, "INVALID_INVITATION");
          return;
        }
        response.status(200).json({
          data: {
            status: "ready",
            expiresAt: new Date(continuation.expiresAt).toISOString(),
          },
          meta: { requestId: requestId(response) },
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.post(
    "/invitations/continuations/accept",
    protect,
    input.authenticationMiddleware,
    async (request, response, next) => {
      const flowId = getFlowId(request);
      const auth = getTrustedAuthenticationContext(response);
      if (!isEmptyObject(request.body)) {
        error(response, 400, "INVALID_INVITATION_CONTINUATION");
        return;
      }
      if (auth === null) {
        error(response, 401, "AUTHENTICATION_REQUIRED");
        return;
      }
      try {
        const continuation =
          flowId === null ? null : readSelected(request, flowId);
        const session = readContinuationSessionCredential(
          request.headers.cookie,
        );
        if (
          continuation === null ||
          session === null ||
          continuation.sessionDigest !==
            hashContinuationSessionCredential(session)
        ) {
          error(response, 400, "INVALID_INVITATION_CONTINUATION");
          return;
        }
        const outcome = await input.membershipAccessService.acceptInvitation({
          actorEmail: auth.actor.email,
          actorUserId: auth.actor.id,
          rawToken: continuation.token,
        });
        if (outcome.kind === "success") {
          const selectedClear = clearSelectedInvitationContinuationCookie(
            request.headers.cookie,
            flowId!,
            key,
            input.publicWebOrigin,
          );
          if (selectedClear !== null)
            response.append("Set-Cookie", selectedClear);
          response.status(200).json({
            data: {
              membership: outcome.membership,
              replayed: outcome.replayed,
            },
            meta: { requestId: requestId(response) },
          });
          return;
        }
        if (
          outcome.kind === "invalid_invitation" ||
          outcome.kind === "membership_exists"
        ) {
          const selectedClear = clearSelectedInvitationContinuationCookie(
            request.headers.cookie,
            flowId!,
            key,
            input.publicWebOrigin,
          );
          if (selectedClear !== null)
            response.append("Set-Cookie", selectedClear);
        }
        if (outcome.kind === "invalid_scope") {
          response.status(409).json({
            error: {
              code: "INVITATION_SCOPE_INVALID",
              message: "The invitation branch scope is no longer valid.",
              requestId: requestId(response),
            },
          });
          return;
        }
        const duplicate = outcome.kind === "membership_exists";
        response.status(duplicate ? 409 : 400).json({
          error: {
            code: duplicate
              ? "MEMBERSHIP_ALREADY_EXISTS"
              : "INVALID_INVITATION",
            message: duplicate
              ? "A membership already exists for this organization."
              : "The invitation is invalid or expired.",
            requestId: requestId(response),
          },
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.post(
    "/invitations/continuations/cancel",
    protect,
    (request, response) => {
      const flowId = getFlowId(request);
      if (flowId === null || !isEmptyObject(request.body)) {
        error(response, 400, "INVALID_INVITATION_CONTINUATION");
        return;
      }
      const selectedClear = clearSelectedInvitationContinuationCookie(
        request.headers.cookie,
        flowId,
        key,
        input.publicWebOrigin,
      );
      if (selectedClear !== null) response.append("Set-Cookie", selectedClear);
      response.status(204).end();
    },
  );
  return router;
}
