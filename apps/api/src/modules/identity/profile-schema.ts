import { z } from "zod";

const utcMillisecondTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });

export const updateProfileRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    phone: z
      .string()
      .trim()
      .max(32)
      .transform((value) => (value === "" ? null : value))
      .optional(),
    expectedUpdatedAt: utcMillisecondTimestamp,
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileRequestSchema>;
