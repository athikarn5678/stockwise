import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const roleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
]);

const accessBranchSchema = z.object({
  code: z.string(),
  id: z.string().uuid(),
  name: z.string(),
});

const accessContextResponseSchema = z.object({
  data: z.object({
    firstOrganizationOnboarding: z.object({ eligible: z.boolean() }),
    organizations: z.array(
      z.object({
        branches: z.array(accessBranchSchema),
        id: z.string().uuid(),
        name: z.string(),
        role: roleSchema,
      }),
    ),
    user: z.object({
      displayName: z.string().nullable(),
      email: z.string().email(),
      id: z.string().uuid(),
    }),
  }),
});

const branchSchema = accessBranchSchema.extend({
  address: z.string().nullable(),
  organizationId: z.string().uuid(),
  phone: z.string().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  updatedAt: z.string().datetime({ offset: false, precision: 3 }),
});

const branchResponseSchema = z.object({ data: branchSchema });
const branchListResponseSchema = z.object({ data: z.array(branchSchema) });
const apiErrorSchema = z.object({ error: z.object({ code: z.string() }) });

export type AccessContext = z.infer<typeof accessContextResponseSchema>["data"];
export type AccessibleOrganization = AccessContext["organizations"][number];
export type Branch = z.infer<typeof branchSchema>;

export type BranchApiErrorKind =
  | "authentication_required"
  | "code_conflict"
  | "forbidden"
  | "last_active_branch"
  | "not_found"
  | "stale"
  | "validation"
  | "unavailable";

export class BranchApiError extends Error {
  constructor(readonly kind: BranchApiErrorKind) {
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
    throw new BranchApiError("unavailable");
  }

  if (response.status === 401)
    throw new BranchApiError("authentication_required");
  if (response.status === 403) throw new BranchApiError("forbidden");
  let body: unknown;
  try {
    body = await readPrivateJson(response);
  } catch {
    throw new BranchApiError("unavailable");
  }
  if (!response.ok) {
    const code = apiErrorSchema.safeParse(body);
    const kinds: Record<string, BranchApiErrorKind> = {
      AUTHENTICATION_REQUIRED:
        response.status === 401 ? "authentication_required" : "unavailable",
      BRANCH_CODE_CONFLICT: "code_conflict",
      BRANCH_NOT_FOUND: "not_found",
      BRANCH_STALE: "stale",
      FORBIDDEN: "forbidden",
      LAST_ACTIVE_BRANCH: "last_active_branch",
      VALIDATION_ERROR: "validation",
    };
    throw new BranchApiError(
      code.success
        ? (kinds[code.data.error.code] ?? "unavailable")
        : "unavailable",
    );
  }
  return body;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BranchApiError("unavailable");
  return result.data;
}

export async function fetchAccessContext(options?: {
  signal?: AbortSignal;
}): Promise<AccessContext> {
  return parse(
    accessContextResponseSchema,
    await request(
      "me/access-context",
      options?.signal ? { signal: options.signal } : undefined,
    ),
  ).data;
}

export async function fetchBranches(
  organizationId: string,
  includeInactive = false,
): Promise<Branch[]> {
  const query = includeInactive ? "?includeInactive=true" : "";
  return parse(
    branchListResponseSchema,
    await request(`organizations/${organizationId}/branches${query}`),
  ).data;
}

export async function createBranch(
  organizationId: string,
  input: { address: string; code: string; name: string; phone: string },
): Promise<Branch> {
  return parse(
    branchResponseSchema,
    await request(`organizations/${organizationId}/branches`, {
      body: JSON.stringify(input),
      method: "POST",
    }),
  ).data;
}

export async function updateBranch(
  organizationId: string,
  branchId: string,
  input: {
    address: string;
    expectedUpdatedAt: string;
    name: string;
    phone: string;
  },
): Promise<Branch> {
  return parse(
    branchResponseSchema,
    await request(`organizations/${organizationId}/branches/${branchId}`, {
      body: JSON.stringify(input),
      method: "PATCH",
    }),
  ).data;
}

export async function changeBranchLifecycle(
  organizationId: string,
  branch: Pick<Branch, "id" | "status" | "updatedAt">,
): Promise<Branch> {
  const action = branch.status === "ACTIVE" ? "deactivate" : "reactivate";
  return parse(
    branchResponseSchema,
    await request(
      `organizations/${organizationId}/branches/${branch.id}/${action}`,
      {
        body: JSON.stringify({ expectedUpdatedAt: branch.updatedAt }),
        method: "POST",
      },
    ),
  ).data;
}
