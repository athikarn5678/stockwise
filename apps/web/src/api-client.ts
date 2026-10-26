import {
  privateFetch,
  readPrivateJson,
  withOriginCookieMutationLock,
} from "@/session-lifecycle";
import { z } from "zod";

import { API_HEALTH_PATH } from "./api-proxy";

const apiHealthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type ApiHealthResponse = z.infer<typeof apiHealthResponseSchema>;

export async function fetchApiHealth(): Promise<ApiHealthResponse> {
  const response = await fetch(API_HEALTH_PATH, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("The API health check was unavailable.");
  }

  return apiHealthResponseSchema.parse(await response.json());
}

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
  }),
});

const safeApiErrorCodes = new Set([
  "ALREADY_HAS_ORGANIZATION_ACCESS",
  "ALREADY_ONBOARDED",
  "INVALID_CREDENTIALS",
  "INVALID_TOKEN",
  "INVALID_VERIFICATION_CODE",
  "RATE_LIMITED",
  "VALIDATION_ERROR",
  "VERIFICATION_PASSWORD_PROOF_REQUIRED",
]);
export type AuthApiErrorKind =
  | "already_has_organization_access"
  | "already_onboarded"
  | "invalid_credentials"
  | "invalid_token"
  | "invalid_verification_code"
  | "rate_limited"
  | "validation"
  | "unavailable"
  | "verification_password_proof_required";

export class AuthApiError extends Error {
  readonly kind: AuthApiErrorKind;
  readonly retryAfterSeconds: number | null;

  constructor(kind: AuthApiErrorKind, retryAfterSeconds: number | null = null) {
    super(kind);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 86_400
    ? parsed
    : null;
}

function authErrorFromResponse(
  response: Response,
  body: unknown,
): AuthApiError {
  const parsed = apiErrorSchema.safeParse(body);
  const code =
    parsed.success && safeApiErrorCodes.has(parsed.data.error.code)
      ? parsed.data.error.code
      : undefined;

  if (response.status === 429 || code === "RATE_LIMITED") {
    return new AuthApiError(
      "rate_limited",
      retryAfterSeconds(response.headers.get("Retry-After")),
    );
  }

  if (code === "INVALID_CREDENTIALS") {
    return new AuthApiError("invalid_credentials");
  }

  if (code === "INVALID_TOKEN") {
    return new AuthApiError("invalid_token");
  }

  if (code === "INVALID_VERIFICATION_CODE") {
    return new AuthApiError("invalid_verification_code");
  }

  if (
    response.status === 401 &&
    code === "VERIFICATION_PASSWORD_PROOF_REQUIRED"
  ) {
    return new AuthApiError("verification_password_proof_required");
  }

  if (code === "ALREADY_ONBOARDED") {
    return new AuthApiError("already_onboarded");
  }

  if (code === "ALREADY_HAS_ORGANIZATION_ACCESS") {
    return new AuthApiError("already_has_organization_access");
  }

  if (response.status === 400 || code === "VALIDATION_ERROR") {
    return new AuthApiError("validation");
  }

  return new AuthApiError("unavailable");
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await readPrivateJson(response);
  } catch {
    return undefined;
  }
}

async function postAuth(
  path: string,
  body: Record<string, string> | undefined = undefined,
  signal?: AbortSignal,
  invitationFlowId?: string,
): Promise<{ status: number; body: unknown }> {
  const send = async (): Promise<{ status: number; body: unknown }> => {
    let response: Response;

    try {
      response = await fetch(`/api/v1/auth/${path}`, {
        credentials: "same-origin",
        headers: {
          ...(body === undefined
            ? { accept: "application/json" }
            : {
                accept: "application/json",
                "content-type": "application/json",
              }),
          ...(invitationFlowId === undefined
            ? {}
            : { "X-Stockwise-Invitation-Flow": invitationFlowId }),
        },
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new AuthApiError("unavailable");
    }

    if (response.status === 204) {
      return { status: 204, body: undefined };
    }

    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      throw authErrorFromResponse(response, responseBody);
    }

    return { status: response.status, body: responseBody };
  };
  return send();
}

async function postAuthBody(
  path: string,
  input: Record<string, string>,
  status: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await postAuth(path, input, signal);
  if (response.status !== status) throw new AuthApiError("unavailable");
  return response.body;
}

const acceptedResponseSchema = z.object({
  data: z.object({ status: z.literal("accepted") }),
});
const challengeSelectorSchema = z.object({
  challengeId: z.uuid(),
});
const registrationResponseSchema = z.object({
  data: z.object({
    nextStep: z.literal("verify_email"),
    status: z.literal("accepted"),
    verification: challengeSelectorSchema,
  }),
});
const loginUserSchema = z.object({
  displayName: z.string().nullable(),
  email: z.string().email(),
  id: z.string(),
});
const loginVerifiedResponseSchema = z.object({
  data: z.object({ user: loginUserSchema }).strict(),
});
const loginUnverifiedResponseSchema = z.object({
  data: z
    .object({
      nextStep: z.literal("verify_email"),
      status: z.literal("verification_required"),
      verification: z.object({ challengeId: z.uuid().nullable() }),
    })
    .strict(),
});
const verificationResponseSchema = z.object({
  data: z.object({ status: z.enum(["verified", "already_verified"]) }),
});
const resendVerificationResponseSchema = z.object({
  data: z.object({
    status: z.literal("accepted"),
    verification: challengeSelectorSchema,
  }),
});
const resetResponseSchema = z.object({
  data: z.object({ status: z.literal("password_reset") }),
});
const firstOrganizationOnboardingResponseSchema = z.object({
  data: z.object({
    user: z.object({
      id: z.string(),
      displayName: z.string(),
      phone: z.string().nullable(),
    }),
    organization: z.object({ id: z.string(), name: z.string() }),
    branch: z.object({
      id: z.string(),
      name: z.string(),
      code: z.literal("MAIN"),
      phone: z.string().nullable(),
      address: z.string().nullable(),
    }),
    role: z.literal("OWNER"),
    nextStep: z.literal("app"),
  }),
});

function parseSuccess<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AuthApiError("unavailable");
  }

  return parsed.data;
}

export type LoginResult =
  | ({ outcome: "authenticated" } & z.infer<
      typeof loginVerifiedResponseSchema
    >["data"])
  | ({ outcome: "verification_required" } & z.infer<
      typeof loginUnverifiedResponseSchema
    >["data"]);

export async function register(input: { email: string; password: string }) {
  return parseSuccess(
    registrationResponseSchema,
    await postAuthBody("register", input, 202),
  );
}

export async function login(input: {
  email: string;
  password: string;
  invitationFlowId?: string;
}): Promise<LoginResult> {
  return withOriginCookieMutationLock(async () => {
    const response = await postAuth(
      "login",
      {
        email: input.email,
        password: input.password,
      },
      undefined,
      input.invitationFlowId,
    );
    const verified = loginVerifiedResponseSchema.safeParse(response.body);
    if (response.status === 200 && verified.success) {
      return { outcome: "authenticated", ...verified.data.data };
    }
    const unverified = loginUnverifiedResponseSchema.safeParse(response.body);
    if (response.status === 202 && unverified.success) {
      return { outcome: "verification_required", ...unverified.data.data };
    }
    throw new AuthApiError("unavailable");
  }, true);
}

export async function resendVerification(
  input: { email: string },
  options?: { signal?: AbortSignal },
) {
  return parseSuccess(
    resendVerificationResponseSchema,
    await postAuthBody("verification-resend", input, 202, options?.signal),
  );
}

export async function verifyEmail(
  input: { token: string },
  options?: { signal?: AbortSignal },
) {
  return parseSuccess(
    verificationResponseSchema,
    await postAuthBody("verify-email", input, 200, options?.signal),
  );
}

export async function verifyEmailCode(
  input: {
    challengeId: string;
    code: string;
    email: string;
  },
  options?: { signal?: AbortSignal },
) {
  return parseSuccess(
    verificationResponseSchema,
    await postAuthBody("verify-email-code", input, 200, options?.signal),
  );
}

export async function verificationPasswordProof(
  input: {
    email: string;
    password: string;
  },
  options?: { signal?: AbortSignal },
) {
  return parseSuccess(
    acceptedResponseSchema,
    await postAuthBody(
      "verification-password-proof",
      input,
      202,
      options?.signal,
    ),
  );
}

export async function forgotPassword(input: { email: string }) {
  return parseSuccess(
    acceptedResponseSchema,
    await postAuthBody("forgot-password", input, 202),
  );
}

export async function resetPassword(input: {
  newPassword: string;
  token: string;
}) {
  return parseSuccess(
    resetResponseSchema,
    await postAuthBody("reset-password", input, 200),
  );
}

export async function logout() {
  return withOriginCookieMutationLock(async () => {
    const response = await postAuth("logout", {});
    if (response.status !== 204) throw new AuthApiError("unavailable");
  }, true);
}

export interface FirstOrganizationOnboardingRequest {
  branchAddress?: string;
  branchName: string;
  branchPhone?: string;
  displayName: string;
  organizationName: string;
  phone?: string;
}

export async function completeFirstOrganizationOnboarding(
  input: FirstOrganizationOnboardingRequest,
) {
  let response: Response;

  try {
    response = await privateFetch("/api/v1/organizations", {
      body: JSON.stringify(input),
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    });
  } catch {
    throw new AuthApiError("unavailable");
  }

  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    throw authErrorFromResponse(response, responseBody);
  }

  return parseSuccess(firstOrganizationOnboardingResponseSchema, responseBody);
}
