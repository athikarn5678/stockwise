import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const profileSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().nullable(),
    phone: z.string().nullable(),
    updatedAt: z.string().datetime({ offset: false, precision: 3 }),
  })
  .strict();
const profileResponseSchema = z
  .object({
    data: profileSchema,
    meta: z.object({ requestId: z.string() }),
  })
  .strict();
const errorResponseSchema = z.object({ error: z.object({ code: z.string() }) });

export type SelfProfile = z.infer<typeof profileSchema>;
export type ProfileApiErrorKind = "stale" | "validation" | "unavailable";

export class ProfileApiError extends Error {
  constructor(readonly kind: ProfileApiErrorKind) {
    super(kind);
  }
}

async function request(path: string, init?: RequestInit): Promise<SelfProfile> {
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
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProfileApiError("unavailable");
  }
  let body: unknown;
  try {
    body = await readPrivateJson(response);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProfileApiError("unavailable");
  }
  if (!response.ok) {
    const result = errorResponseSchema.safeParse(body);
    const code = result.success ? result.data.error.code : "";
    if (response.status === 409 && code === "PROFILE_STALE")
      throw new ProfileApiError("stale");
    if (response.status === 400 && code === "VALIDATION_ERROR")
      throw new ProfileApiError("validation");
    throw new ProfileApiError("unavailable");
  }
  const result = profileResponseSchema.safeParse(body);
  if (!result.success) throw new ProfileApiError("unavailable");
  return result.data.data;
}

export async function fetchSelfProfile(options?: {
  signal?: AbortSignal;
}): Promise<SelfProfile> {
  return request(
    "me",
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export async function updateSelfProfile(input: {
  displayName: string;
  phone?: string;
  expectedUpdatedAt: string;
}): Promise<SelfProfile> {
  return request("me/profile", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
