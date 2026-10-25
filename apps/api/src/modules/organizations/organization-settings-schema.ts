import { z } from "zod";

const exactTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  })
  .transform((value) => new Date(value));
export const organizationIdParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

export const organizationNameUpdateSchema = z
  .object({
    expectedUpdatedAt: exactTimestampSchema,
    name: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1)
          .refine((value) => Array.from(value).length <= 200),
      ),
  })
  .strict();

export type OrganizationNameUpdate = z.infer<
  typeof organizationNameUpdateSchema
>;
