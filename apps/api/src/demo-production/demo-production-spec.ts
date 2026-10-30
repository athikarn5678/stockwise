import { createHash } from "node:crypto";

import { z } from "zod";

import { Prisma } from "../generated/prisma/client.ts";
import { DEMO_30D_ORGANIZATION } from "../demo/demo-30d-plan.ts";

/**
 * Operator-approved specification of ONE new, isolated synthetic organization
 * (ADR-043). It names every created resource by full ID and every presenter by
 * the email SHA-256 of an already verified account; it carries no secret. The
 * 16-hex digest of the parsed spec is what the owner approves after dry-run.
 */
const uuid = z.string().uuid();
const roles = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
] as const;

const memberSchema = z
  .object({
    // SHA-256 of the lowercase account email: no address travels in the ECS override.
    emailSha256: z.string().regex(/^[0-9a-f]{64}$/),
    role: z.enum(roles),
    branchCodes: z.array(z.string()).max(2),
  })
  .strict();

export const demoProductionSpecSchema = z
  .object({
    version: z.literal(1),
    // Must equal current_database() of the connection that runs the import.
    database: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(63),
    organization: z
      .object({ id: uuid, name: z.string().trim().min(3).max(200) })
      .strict(),
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seed: z.number().int().min(0).max(4_294_967_295),
    reportingTimezone: z.literal("Asia/Bangkok"),
    branches: z
      .array(
        z
          .object({
            id: uuid,
            code: z.string().regex(/^[A-Z0-9]{1,16}$/),
            name: z.string().min(1).max(200),
          })
          .strict(),
      )
      .length(2),
    supplier: z.object({ id: uuid, name: z.string().min(1).max(160) }).strict(),
    products: z
      .array(
        z
          .object({
            id: uuid,
            sku: z.string().regex(/^[A-Z0-9-]{1,64}$/),
            name: z.string().min(1).max(200),
            unit: z.literal("EA"),
            basePrice: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
          })
          .strict(),
      )
      .length(6),
    members: z.array(memberSchema).length(5),
  })
  .strict()
  .superRefine((spec, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: "custom", message });
    const ids = [
      spec.organization.id,
      spec.supplier.id,
      ...spec.branches.map((b) => b.id),
      ...spec.products.map((p) => p.id),
    ];
    if (new Set(ids).size !== ids.length) fail("Resource IDs must be unique.");
    if (new Set(spec.branches.map((b) => b.code)).size !== 2)
      fail("Branch codes must be unique.");
    if (new Set(spec.products.map((p) => p.sku)).size !== 6)
      fail("Product SKUs must be unique.");
    if (spec.products.some((p) => new Prisma.Decimal(p.basePrice).lte(0)))
      fail("Product prices must be positive.");
    if (
      spec.organization.name.toLowerCase() ===
      DEMO_30D_ORGANIZATION.toLowerCase()
    )
      fail("The new organization must not reuse the existing UAT name.");
    if (new Set(spec.members.map((m) => m.emailSha256)).size !== 5)
      fail("Member accounts must be unique.");
    for (const role of roles)
      if (spec.members.filter((m) => m.role === role).length !== 1)
        fail(`Exactly one ${role} member is required.`);
    const codes = new Set(spec.branches.map((b) => b.code));
    for (const member of spec.members) {
      const wide = member.role === "OWNER" || member.role === "ADMIN";
      if (wide && member.branchCodes.length !== 0)
        fail("OWNER and ADMIN take no branch assignments.");
      if (
        !wide &&
        (member.branchCodes.length === 0 ||
          member.branchCodes.some((c) => !codes.has(c)))
      )
        fail("Branch-scoped members need assignments from the spec branches.");
    }
  });

export type DemoProductionSpec = z.infer<typeof demoProductionSpecSchema>;

export function parseDemoProductionSpec(raw: string): {
  spec: DemoProductionSpec;
  digest: string;
  retireDigest: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("DEMOPROD_SPEC_INVALID");
  }
  const parsed = demoProductionSpecSchema.safeParse(value);
  if (!parsed.success) throw new Error("DEMOPROD_SPEC_INVALID");
  const spec = parsed.data;
  const digest = createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex")
    .slice(0, 16);
  return {
    spec,
    digest,
    // Retire must stay possible when presenter accounts changed, so it binds the spec only.
    retireDigest: createHash("sha256")
      .update(`retire:${digest}`)
      .digest("hex")
      .slice(0, 16),
  };
}
