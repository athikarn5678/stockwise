import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const organizationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    updatedAt: z.string().datetime({ offset: false, precision: 3 }),
  })
  .strict();
const responseSchema = z
  .object({
    data: organizationSchema,
    meta: z.object({ requestId: z.string() }),
  })
  .strict();
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export type OrganizationSettings = z.infer<typeof organizationSchema>;
export type OrganizationApiErrorKind =
  "stale" | "validation" | "forbidden" | "unavailable";

export class OrganizationApiError extends Error {
  constructor(readonly kind: OrganizationApiErrorKind) {
    super(kind);
  }
}

async function request(
  organizationId: string,
  init?: RequestInit,
): Promise<OrganizationSettings> {
  let response: Response;
  try {
    response = await privateFetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
      {
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(init?.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...init,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new OrganizationApiError("unavailable");
  }
  let body: unknown;
  try {
    body = await readPrivateJson(response);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new OrganizationApiError("unavailable");
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : "";
    if (response.status === 409 && code === "ORGANIZATION_STALE")
      throw new OrganizationApiError("stale");
    if (response.status === 400 && code === "VALIDATION_ERROR")
      throw new OrganizationApiError("validation");
    if (response.status === 403) throw new OrganizationApiError("forbidden");
    throw new OrganizationApiError("unavailable");
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new OrganizationApiError("unavailable");
  return parsed.data.data;
}

export function fetchOrganizationSettings(
  organizationId: string,
  options?: { signal?: AbortSignal },
): Promise<OrganizationSettings> {
  return request(
    organizationId,
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export function updateOrganizationSettings(
  organizationId: string,
  input: { name: string; expectedUpdatedAt: string },
): Promise<OrganizationSettings> {
  return request(organizationId, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
