import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const roleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
]);
const statusSchema = z.enum(["ACTIVE", "INACTIVE"]);
const timestampSchema = z.string().datetime({ offset: false, precision: 3 });

const branchSummarySchema = z.object({
  code: z.string(),
  id: z.string().uuid(),
  name: z.string(),
  status: statusSchema,
});

const membershipSchema = z.object({
  branchAssignments: z.array(
    z.object({ branch: branchSummarySchema, status: statusSchema }),
  ),
  createdAt: timestampSchema,
  id: z.string().uuid(),
  organization: z.object({ id: z.string().uuid(), name: z.string() }),
  role: roleSchema,
  status: statusSchema,
  updatedAt: timestampSchema,
  user: z.object({
    displayName: z.string().nullable(),
    email: z.string().email(),
    id: z.string().uuid(),
  }),
});

const invitationSchema = z.object({
  branchScopes: z.array(branchSummarySchema),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  id: z.string().uuid(),
  intendedRole: roleSchema,
  invitedEmail: z.string().email(),
  state: z.enum(["PENDING", "EXPIRED", "ACCEPTED", "REVOKED", "REPLACED"]),
});

const pageMetaSchema = z.object({ nextCursor: z.string().nullable() });
const membershipResponseSchema = z.object({ data: membershipSchema });
const membershipListResponseSchema = z.object({
  data: z.array(membershipSchema),
  meta: pageMetaSchema,
});
const invitationResponseSchema = z.object({ data: invitationSchema });
const invitationListResponseSchema = z.object({
  data: z.array(invitationSchema),
  meta: pageMetaSchema,
});
const acceptanceResponseSchema = z.object({
  data: z.object({ membership: membershipSchema, replayed: z.boolean() }),
});
const apiErrorSchema = z.object({ error: z.object({ code: z.string() }) });

export type MembershipRole = z.infer<typeof roleSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Invitation = z.infer<typeof invitationSchema>;

export type MembershipApiErrorKind =
  | "authentication_required"
  | "delivery_failed"
  | "finalized"
  | "forbidden"
  | "invalid_branch_scope"
  | "invalid_invitation"
  | "invitation_scope_invalid"
  | "last_active_owner"
  | "membership_exists"
  | "membership_inactive_exists"
  | "self_modification"
  | "not_found"
  | "stale"
  | "state_invalid"
  | "unavailable"
  | "validation";

export class MembershipApiError extends Error {
  constructor(readonly kind: MembershipApiErrorKind) {
    super(kind);
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await privateFetch(`/api/v1/${path}`, {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...init,
    });
  } catch {
    throw new MembershipApiError("unavailable");
  }
  let body: unknown;
  try {
    body = await readPrivateJson(response);
  } catch {
    throw new MembershipApiError("unavailable");
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    const kinds: Record<string, MembershipApiErrorKind> = {
      AUTHENTICATION_REQUIRED: "authentication_required",
      FORBIDDEN: "forbidden",
      INVALID_BRANCH_SCOPE: "invalid_branch_scope",
      INVALID_INVITATION: "invalid_invitation",
      INVITATION_DELIVERY_FAILED: "delivery_failed",
      INVITATION_FINALIZED: "finalized",
      INVITATION_SCOPE_INVALID: "invitation_scope_invalid",
      LAST_ACTIVE_OWNER: "last_active_owner",
      MEMBERSHIP_ALREADY_EXISTS: "membership_exists",
      MEMBERSHIP_INACTIVE_EXISTS: "membership_inactive_exists",
      SELF_MODIFICATION_FORBIDDEN: "self_modification",
      MEMBERSHIP_NOT_FOUND: "not_found",
      MEMBERSHIP_STALE: "stale",
      MEMBERSHIP_STATE_INVALID: "state_invalid",
      VALIDATION_ERROR: "validation",
    };
    throw new MembershipApiError(
      parsed.success
        ? (kinds[parsed.data.error.code] ?? "unavailable")
        : "unavailable",
    );
  }
  return body;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MembershipApiError("unavailable");
  return parsed.data;
}

export async function fetchMemberships(
  organizationId: string,
  includeInactive: boolean,
  cursor: string | null = null,
) {
  const query = new URLSearchParams();
  if (includeInactive) query.set("includeInactive", "true");
  if (cursor !== null) query.set("cursor", cursor);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return parse(
    membershipListResponseSchema,
    await request(`organizations/${organizationId}/members${suffix}`),
  );
}

export async function fetchInvitations(
  organizationId: string,
  cursor: string | null = null,
) {
  const suffix = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return parse(
    invitationListResponseSchema,
    await request(`organizations/${organizationId}/invitations${suffix}`),
  );
}

export async function createInvitation(
  organizationId: string,
  input: { branchIds: string[]; email: string; role: MembershipRole },
) {
  return parse(
    invitationResponseSchema,
    await request(`organizations/${organizationId}/invitations`, {
      body: JSON.stringify(input),
      method: "POST",
    }),
  ).data;
}

export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
) {
  return parse(
    invitationResponseSchema,
    await request(
      `organizations/${organizationId}/invitations/${invitationId}/revoke`,
      { method: "POST" },
    ),
  ).data;
}

export async function replaceMembership(
  organizationId: string,
  membershipId: string,
  input: {
    branchIds: string[];
    expectedUpdatedAt: string;
    role: MembershipRole;
  },
) {
  return parse(
    membershipResponseSchema,
    await request(`organizations/${organizationId}/members/${membershipId}`, {
      body: JSON.stringify(input),
      method: "PATCH",
    }),
  ).data;
}

export async function deactivateMembership(
  organizationId: string,
  membership: Pick<Membership, "id" | "updatedAt">,
) {
  return parse(
    membershipResponseSchema,
    await request(
      `organizations/${organizationId}/members/${membership.id}/deactivate`,
      {
        body: JSON.stringify({ expectedUpdatedAt: membership.updatedAt }),
        method: "POST",
      },
    ),
  ).data;
}

export async function reactivateMembership(
  organizationId: string,
  membershipId: string,
  input: {
    branchIds: string[];
    expectedUpdatedAt: string;
    role: MembershipRole;
  },
) {
  return parse(
    membershipResponseSchema,
    await request(
      `organizations/${organizationId}/members/${membershipId}/reactivate`,
      { body: JSON.stringify(input), method: "POST" },
    ),
  ).data;
}

export async function acceptInvitation(token: string) {
  return parse(
    acceptanceResponseSchema,
    await request("invitations/accept", {
      body: JSON.stringify({ token }),
      method: "POST",
    }),
  ).data;
}
