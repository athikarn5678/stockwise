import { Router, type RequestHandler, type Response } from "express";

import { organizationIdParamsSchema } from "../organizations/branch-schemas.ts";
import { getTrustedAuthenticationContext } from "./authentication-context.ts";
import { createCrossSiteRequestProtection } from "./credential-lifecycle-router.ts";
import type {
  InvitationAcceptOutcome,
  InvitationRevokeOutcome,
  MembershipMutationOutcome,
} from "./membership-access-repository.ts";
import {
  invitationAcceptRequestSchema,
  invitationCreateRequestSchema,
  invitationListQuerySchema,
  managementListQuerySchema,
  membershipDeactivateRequestSchema,
  membershipReplaceRequestSchema,
  organizationInvitationParamsSchema,
  organizationMembershipParamsSchema,
} from "./membership-access-schemas.ts";
import type {
  InvitationCreateOutcome,
  MembershipAccessService,
} from "./membership-access-service.ts";

const REQUEST_ID_HEADER = "X-Request-Id";

function requestId(response: Response): string {
  const value = response.getHeader(REQUEST_ID_HEADER);
  return typeof value === "string" ? value : "unavailable";
}

function error(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: { code, message, requestId: requestId(response) },
  });
}

function authentication(response: Response) {
  const context = getTrustedAuthenticationContext(response);
  if (context === null) {
    error(
      response,
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required.",
    );
  }
  return context;
}

function sendInvitationCreate(
  response: Response,
  outcome: InvitationCreateOutcome,
): void {
  switch (outcome.kind) {
    case "success":
      response.status(201).json({
        data: outcome.invitation,
        meta: { requestId: requestId(response) },
      });
      return;
    case "forbidden":
      error(response, 403, "FORBIDDEN", "The operation is not permitted.");
      return;
    case "invalid_branch_scope":
      error(
        response,
        400,
        "INVALID_BRANCH_SCOPE",
        "The requested branch scope is invalid.",
      );
      return;
    case "membership_exists":
      if (outcome.status === "INACTIVE") {
        error(
          response,
          409,
          "MEMBERSHIP_INACTIVE_EXISTS",
          "This person was removed earlier. Reactivate the existing membership instead of inviting again.",
        );
        return;
      }
      error(
        response,
        409,
        "MEMBERSHIP_ALREADY_EXISTS",
        "A membership already exists for this organization.",
      );
      return;
    case "delivery_failed":
      error(
        response,
        503,
        "INVITATION_DELIVERY_FAILED",
        "The invitation could not be delivered.",
      );
  }
}

function sendInvitationRevoke(
  response: Response,
  outcome: InvitationRevokeOutcome,
): void {
  switch (outcome.kind) {
    case "success":
      response.status(200).json({
        data: outcome.invitation,
        meta: { requestId: requestId(response) },
      });
      return;
    case "forbidden":
      error(response, 403, "FORBIDDEN", "The operation is not permitted.");
      return;
    case "finalized":
      error(
        response,
        409,
        "INVITATION_FINALIZED",
        "The invitation has already been accepted.",
      );
  }
}

function sendInvitationAccept(
  response: Response,
  outcome: InvitationAcceptOutcome,
): void {
  switch (outcome.kind) {
    case "success":
      response.status(200).json({
        data: { membership: outcome.membership, replayed: outcome.replayed },
        meta: { requestId: requestId(response) },
      });
      return;
    case "invalid_invitation":
      error(
        response,
        400,
        "INVALID_INVITATION",
        "The invitation is invalid or expired.",
      );
      return;
    case "invalid_scope":
      error(
        response,
        409,
        "INVITATION_SCOPE_INVALID",
        "The invitation branch scope is no longer valid.",
      );
      return;
    case "membership_exists":
      error(
        response,
        409,
        "MEMBERSHIP_ALREADY_EXISTS",
        "A membership already exists for this organization.",
      );
  }
}

function sendMembershipMutation(
  response: Response,
  outcome: MembershipMutationOutcome,
): void {
  switch (outcome.kind) {
    case "success":
      response.status(200).json({
        data: outcome.membership,
        meta: { requestId: requestId(response) },
      });
      return;
    case "forbidden":
      error(response, 403, "FORBIDDEN", "The operation is not permitted.");
      return;
    case "not_found":
      error(
        response,
        404,
        "MEMBERSHIP_NOT_FOUND",
        "The membership was not found.",
      );
      return;
    case "inactive":
    case "already_active":
      error(
        response,
        409,
        "MEMBERSHIP_STATE_INVALID",
        "The membership is not in the required state.",
      );
      return;
    case "invalid_branch_scope":
      error(
        response,
        400,
        "INVALID_BRANCH_SCOPE",
        "The requested branch scope is invalid.",
      );
      return;
    case "stale":
      error(
        response,
        409,
        "MEMBERSHIP_STALE",
        "The membership changed. Refresh and try again.",
      );
      return;
    case "last_active_owner":
      error(
        response,
        409,
        "LAST_ACTIVE_OWNER",
        "An organization must retain at least one active owner.",
      );
      return;
    case "self_modification":
      error(
        response,
        403,
        "SELF_MODIFICATION_FORBIDDEN",
        "You cannot change or deactivate your own membership.",
      );
  }
}

export function createMembershipAccessRouter({
  authenticationMiddleware,
  membershipAccessService,
  publicWebOrigin,
}: {
  authenticationMiddleware: RequestHandler;
  membershipAccessService: MembershipAccessService;
  publicWebOrigin: string;
}): Router {
  const router = Router();
  const protectMutation = createCrossSiteRequestProtection(publicWebOrigin);

  router.get(
    "/organizations/:organizationId/members",
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationIdParamsSchema.safeParse(request.params);
      const query = managementListQuerySchema.safeParse(request.query);
      if (context === null) return;
      if (!params.success || !query.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        const outcome = await membershipAccessService.listMemberships({
          actorUserId: context.actor.id,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
          includeInactive: query.data.includeInactive,
          limit: query.data.limit,
          organizationId: params.data.organizationId,
        });
        if (outcome.kind === "forbidden") {
          error(response, 403, "FORBIDDEN", "The operation is not permitted.");
          return;
        }
        if (outcome.kind === "invalid_cursor") {
          error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
          return;
        }
        response.status(200).json({
          data: outcome.page.items,
          meta: {
            nextCursor: outcome.page.nextCursor,
            requestId: requestId(response),
          },
        });
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/invitations",
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationIdParamsSchema.safeParse(request.params);
      const query = invitationListQuerySchema.safeParse(request.query);
      if (context === null) return;
      if (!params.success || !query.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        const outcome = await membershipAccessService.listInvitations({
          actorUserId: context.actor.id,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
          limit: query.data.limit,
          organizationId: params.data.organizationId,
        });
        if (outcome.kind === "forbidden") {
          error(response, 403, "FORBIDDEN", "The operation is not permitted.");
          return;
        }
        if (outcome.kind === "invalid_cursor") {
          error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
          return;
        }
        response.status(200).json({
          data: outcome.page.items,
          meta: {
            nextCursor: outcome.page.nextCursor,
            requestId: requestId(response),
          },
        });
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/invitations",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationIdParamsSchema.safeParse(request.params);
      const body = invitationCreateRequestSchema.safeParse(request.body);
      if (context === null) return;
      if (!params.success || !body.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendInvitationCreate(
          response,
          await membershipAccessService.createInvitation({
            actorUserId: context.actor.id,
            invitation: body.data,
            organizationId: params.data.organizationId,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/invitations/:invitationId/revoke",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationInvitationParamsSchema.safeParse(
        request.params,
      );
      if (context === null) return;
      if (!params.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendInvitationRevoke(
          response,
          await membershipAccessService.revokeInvitation({
            actorUserId: context.actor.id,
            invitationId: params.data.invitationId,
            organizationId: params.data.organizationId,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/invitations/accept",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const body = invitationAcceptRequestSchema.safeParse(request.body);
      if (context === null) return;
      if (!body.success) {
        error(
          response,
          400,
          "INVALID_INVITATION",
          "The invitation is invalid or expired.",
        );
        return;
      }
      try {
        sendInvitationAccept(
          response,
          await membershipAccessService.acceptInvitation({
            actorEmail: context.actor.email,
            actorUserId: context.actor.id,
            rawToken: body.data.token,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.patch(
    "/organizations/:organizationId/members/:membershipId",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationMembershipParamsSchema.safeParse(
        request.params,
      );
      const body = membershipReplaceRequestSchema.safeParse(request.body);
      if (context === null) return;
      if (!params.success || !body.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendMembershipMutation(
          response,
          await membershipAccessService.replaceMembership({
            actorUserId: context.actor.id,
            membershipId: params.data.membershipId,
            organizationId: params.data.organizationId,
            replacement: body.data,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/members/:membershipId/deactivate",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationMembershipParamsSchema.safeParse(
        request.params,
      );
      const body = membershipDeactivateRequestSchema.safeParse(request.body);
      if (context === null) return;
      if (!params.success || !body.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendMembershipMutation(
          response,
          await membershipAccessService.deactivateMembership({
            actorUserId: context.actor.id,
            expectedUpdatedAt: body.data.expectedUpdatedAt,
            membershipId: params.data.membershipId,
            organizationId: params.data.organizationId,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/members/:membershipId/reactivate",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = authentication(response);
      const params = organizationMembershipParamsSchema.safeParse(
        request.params,
      );
      const body = membershipReplaceRequestSchema.safeParse(request.body);
      if (context === null) return;
      if (!params.success || !body.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendMembershipMutation(
          response,
          await membershipAccessService.reactivateMembership({
            actorUserId: context.actor.id,
            membershipId: params.data.membershipId,
            organizationId: params.data.organizationId,
            replacement: body.data,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  return router;
}
