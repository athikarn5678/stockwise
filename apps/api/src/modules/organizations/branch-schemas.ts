import { z } from "zod";

const branchCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
  );

const requiredBranchNameSchema = z.string().trim().min(1).max(200);

function optionalText(maximumLength: number) {
  return z
    .string()
    .trim()
    .max(maximumLength)
    .transform((value) => (value === "" ? null : value));
}

const expectedUpdatedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .transform((value) => new Date(value));

export const organizationIdParamsSchema = z
  .object({ organizationId: z.string().uuid() })
  .strict();

export const branchIdParamsSchema = z
  .object({
    branchId: z.string().uuid(),
    organizationId: z.string().uuid(),
  })
  .strict();

export const branchListQuerySchema = z
  .object({
    includeInactive: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();

export const branchCreateRequestSchema = z
  .object({
    address: optionalText(500)
      .optional()
      .transform((value) => value ?? null),
    // A blank or omitted code asks the server to generate the next BR-NNN code.
    code: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === "" ? undefined : value))
      .pipe(branchCodeSchema.optional()),
    name: requiredBranchNameSchema,
    phone: optionalText(32)
      .optional()
      .transform((value) => value ?? null),
  })
  .strict();

export const branchUpdateRequestSchema = z
  .object({
    address: optionalText(500).optional(),
    expectedUpdatedAt: expectedUpdatedAtSchema,
    name: requiredBranchNameSchema.optional(),
    phone: optionalText(32).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.phone !== undefined ||
      input.address !== undefined,
  );

export const branchLifecycleRequestSchema = z
  .object({ expectedUpdatedAt: expectedUpdatedAtSchema })
  .strict();

export type BranchCreateInput = z.infer<typeof branchCreateRequestSchema>;
export type BranchUpdateInput = z.infer<typeof branchUpdateRequestSchema>;
