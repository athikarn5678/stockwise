import { z } from "zod";

import { canonicalEmailSchema, passwordSchema } from "./credential-schemas.ts";

export const loginRequestSchema = z
  .object({
    email: canonicalEmailSchema,
    password: passwordSchema,
  })
  .strict();
