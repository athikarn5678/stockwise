import { createHash } from "node:crypto";

import { type PrismaClient } from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedBranchScope,
  createTrustedOrganizationScope,
  PERMISSIONS,
  type ResolvedAuthorizationState,
} from "../identity/authorization-policy.ts";
import type {
  SupplierCreateInput,
  SupplierListInput,
  SupplierUpdateInput,
} from "./supplier-schemas.ts";

export interface SafeSupplier {
  address: string | null;
  contactName: string | null;
  createdAt: string;
  email: string | null;
  id: string;
  name: string;
  organizationId: string;
  phone: string | null;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: string;
}

type Outcome =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "success"; supplier: SafeSupplier };
export type SupplierListOutcome =
  | { kind: "forbidden" }
  | { kind: "invalid_cursor" }
  | { kind: "success"; suppliers: SafeSupplier[]; nextCursor: string | null };

export interface SupplierRepository {
  createSupplier(input: {
    actorUserId: string;
    organizationId: string;
    supplier: SupplierCreateInput;
  }): Promise<Outcome>;
  getSupplier(input: {
    actorUserId: string;
    organizationId: string;
    supplierId: string;
  }): Promise<Outcome>;
  listSuppliers(input: {
    actorUserId: string;
    organizationId: string;
    query: SupplierListInput;
  }): Promise<SupplierListOutcome>;
  updateSupplier(input: {
    actorUserId: string;
    organizationId: string;
    supplierId: string;
    supplier: SupplierUpdateInput;
  }): Promise<Outcome>;
  setSupplierLifecycle(input: {
    actorUserId: string;
    organizationId: string;
    supplierId: string;
    status: "ACTIVE" | "INACTIVE";
  }): Promise<Outcome>;
}

const supplierSelection = {
  id: true,
  organizationId: true,
  name: true,
  contactName: true,
  email: true,
  phone: true,
  address: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
function safeSupplier(supplier: {
  id: string;
  organizationId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Date;
  updatedAt: Date;
}): SafeSupplier {
  return {
    ...supplier,
    createdAt: supplier.createdAt.toISOString(),
    updatedAt: supplier.updatedAt.toISOString(),
  };
}
function filterHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
type Cursor = { createdAt: string; filterHash: string; id: string; version: 1 };
function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value: string, expected: string): Cursor | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return null;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const cursor = parsed as Partial<Cursor>;
    return cursor.version === 1 &&
      typeof cursor.createdAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt) &&
      !Number.isNaN(Date.parse(cursor.createdAt)) &&
      typeof cursor.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(cursor.id) &&
      cursor.filterHash === expected
      ? (cursor as Cursor)
      : null;
  } catch {
    return null;
  }
}
function definedFields(input: SupplierUpdateInput) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

async function authorize(
  prisma: PrismaClient,
  input: {
    actorUserId: string;
    organizationId: string;
    permission:
      "SUPPLIER_VIEW" | "SUPPLIER_CREATE_EDIT" | "SUPPLIER_DEACTIVATE";
  },
): Promise<boolean> {
  const membership = await prisma.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.actorUserId,
      },
    },
    select: {
      organizationId: true,
      userId: true,
      role: true,
      status: true,
      user: { select: { id: true, status: true } },
      organization: { select: { status: true } },
      branchAssignments: {
        where: { status: "ACTIVE", branch: { status: "ACTIVE" } },
        select: {
          organizationId: true,
          userId: true,
          branchId: true,
          status: true,
        },
      },
    },
  });
  if (membership === null || membership.organization.status !== "ACTIVE")
    return false;
  const state: ResolvedAuthorizationState = {
    actor: membership.user,
    membership: {
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
    },
    branchAssignments: membership.branchAssignments,
  };
  const context = createTrustedAuthorizationContext(state);
  const scope = createTrustedOrganizationScope(input.organizationId);
  if (context === null || scope === null) return false;
  if (context.role === "OWNER" || context.role === "ADMIN")
    return can(context, PERMISSIONS[input.permission], scope);
  return context.activeAssignedBranchIds.some((branchId) =>
    can(
      context,
      PERMISSIONS[input.permission],
      createTrustedBranchScope({
        branchId,
        branchOrganizationId: input.organizationId,
        organizationId: input.organizationId,
      }),
    ),
  );
}

export function createPrismaSupplierRepository(
  prisma: PrismaClient,
): SupplierRepository {
  return {
    async createSupplier(input) {
      if (
        !(await authorize(prisma, {
          ...input,
          permission: "SUPPLIER_CREATE_EDIT",
        }))
      )
        return { kind: "forbidden" };
      const supplier = await prisma.supplier.create({
        data: { organizationId: input.organizationId, ...input.supplier },
        select: supplierSelection,
      });
      return { kind: "success", supplier: safeSupplier(supplier) };
    },
    async getSupplier(input) {
      if (!(await authorize(prisma, { ...input, permission: "SUPPLIER_VIEW" })))
        return { kind: "forbidden" };
      const supplier = await prisma.supplier.findFirst({
        where: { id: input.supplierId, organizationId: input.organizationId },
        select: supplierSelection,
      });
      return supplier === null
        ? { kind: "not_found" }
        : { kind: "success", supplier: safeSupplier(supplier) };
    },
    async listSuppliers(input) {
      if (!(await authorize(prisma, { ...input, permission: "SUPPLIER_VIEW" })))
        return { kind: "forbidden" };
      const hash = filterHash({
        organizationId: input.organizationId,
        q: input.query.q,
        status: input.query.status,
        resource: "supplier",
      });
      const cursor =
        input.query.cursor === undefined
          ? null
          : decodeCursor(input.query.cursor, hash);
      if (input.query.cursor !== undefined && cursor === null)
        return { kind: "invalid_cursor" };
      const createdAt = cursor === null ? null : new Date(cursor.createdAt);
      const rows = await prisma.supplier.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.query.limit + 1,
        where: {
          organizationId: input.organizationId,
          ...(input.query.status === "all"
            ? {}
            : {
                status: input.query.status === "active" ? "ACTIVE" : "INACTIVE",
              }),
          ...(input.query.q === ""
            ? {}
            : {
                OR: [
                  { name: { contains: input.query.q, mode: "insensitive" } },
                  {
                    contactName: {
                      contains: input.query.q,
                      mode: "insensitive",
                    },
                  },
                  { email: { contains: input.query.q, mode: "insensitive" } },
                  { phone: { contains: input.query.q, mode: "insensitive" } },
                ],
              }),
          ...(cursor === null || createdAt === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: createdAt } },
                  { createdAt, id: { lt: cursor.id } },
                ],
              }),
        },
        select: supplierSelection,
      });
      const hasMore = rows.length > input.query.limit;
      const page = hasMore ? rows.slice(0, input.query.limit) : rows;
      const last = page.at(-1);
      return {
        kind: "success",
        suppliers: page.map(safeSupplier),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({
                version: 1,
                createdAt: last.createdAt.toISOString(),
                id: last.id,
                filterHash: hash,
              })
            : null,
      };
    },
    async updateSupplier(input) {
      if (
        !(await authorize(prisma, {
          ...input,
          permission: "SUPPLIER_CREATE_EDIT",
        }))
      )
        return { kind: "forbidden" };
      const current = await prisma.supplier.findFirst({
        where: { id: input.supplierId, organizationId: input.organizationId },
        select: supplierSelection,
      });
      if (current === null) return { kind: "not_found" };
      const supplier = await prisma.supplier.update({
        where: { id: current.id },
        data: definedFields(input.supplier),
        select: supplierSelection,
      });
      return { kind: "success", supplier: safeSupplier(supplier) };
    },
    async setSupplierLifecycle(input) {
      if (
        !(await authorize(prisma, {
          ...input,
          permission: "SUPPLIER_DEACTIVATE",
        }))
      )
        return { kind: "forbidden" };
      const current = await prisma.supplier.findFirst({
        where: { id: input.supplierId, organizationId: input.organizationId },
        select: supplierSelection,
      });
      if (current === null) return { kind: "not_found" };
      if (current.status === input.status)
        return { kind: "success", supplier: safeSupplier(current) };
      const supplier = await prisma.supplier.update({
        where: { id: current.id },
        data: { status: input.status },
        select: supplierSelection,
      });
      return { kind: "success", supplier: safeSupplier(supplier) };
    },
  };
}
