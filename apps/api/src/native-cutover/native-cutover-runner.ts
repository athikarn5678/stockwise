import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  assertNativeCutoverReady,
  hasCrossedAccountIdentity,
  hasNativeDestination,
  nativeDestinationRefused,
} from "../modules/identity/better-auth-cutover-preflight.ts";
import { createNativeAuthTransition } from "../modules/identity/native-auth-transition.ts";

export type NativeCutoverEvent = Record<string, string | number | boolean>;

export interface NativeCutoverSummary {
  outcome: "SEALED_NATIVE" | "ALREADY_NATIVE";
  runId: string | null;
  users: number;
  verificationReconciled: number;
  enrolled: number;
  replayed: number;
  ineligible: number;
}

function countReasons(users: { reason: string }[]): NativeCutoverEvent {
  const counts: NativeCutoverEvent = {};
  for (const { reason } of users)
    counts[reason] = Number(counts[reason] ?? 0) + 1;
  return counts;
}

/**
 * Operator-run Legacy-to-Native transition for one explicitly confirmed
 * database. It reuses the accepted D5-P3 writer and ends with the accepted
 * D5-P4 startup preflight. The API must be stopped first: quiesce takes
 * ACCESS EXCLUSIVE locks and revokes all Legacy authority. Reports carry only
 * counts and reasons, never user identifiers, emails or credentials.
 */
export async function runNativeCutover(input: {
  prisma: PrismaClient;
  confirmDatabase: string;
  resume: boolean;
  report: (event: NativeCutoverEvent) => void | Promise<void>;
}): Promise<NativeCutoverSummary> {
  const { prisma, confirmDatabase, resume, report } = input;
  const target = await prisma.$queryRaw<
    { name: string }[]
  >`SELECT current_database() AS name`;
  if (target[0]?.name !== confirmDatabase)
    throw new Error("NATIVE_CUTOVER_TARGET_MISMATCH");
  const gate = await prisma.$queryRaw<
    { state: string; run_id: string | null }[]
  >`SELECT state, run_id FROM native_auth_transition WHERE id = true`;
  const state = gate[0]?.state;
  if (state === undefined) throw new Error("NATIVE_CUTOVER_FENCE_MISSING");

  if (state === "NATIVE") {
    await assertNativeCutoverReady(prisma);
    await report({ event: "already_native" });
    return {
      outcome: "ALREADY_NATIVE",
      runId: gate[0]?.run_id ?? null,
      users: 0,
      verificationReconciled: 0,
      enrolled: 0,
      replayed: 0,
      ineligible: 0,
    };
  }
  let runId: string;
  if (state === "QUIESCED") {
    // A previous run stopped after quiescing. Only an explicit resume may
    // continue it; a new run id would be refused by the fence anyway.
    if (!resume || !gate[0]?.run_id)
      throw new Error("NATIVE_CUTOVER_RESUME_REQUIRED");
    runId = gate[0].run_id;
  } else if (state === "LEGACY") {
    if (resume) throw new Error("NATIVE_CUTOVER_NOTHING_TO_RESUME");
    runId = randomUUID();
  } else {
    throw new Error("NATIVE_CUTOVER_FENCE_INVALID");
  }

  // Mirrors the D5-P4 readiness refusals for identities without a Native
  // destination: invalid time/credential version, and a verification flag
  // mismatch the writer cannot reconcile (only ACTIVE, enabled users can be).
  async function assertResolvableIdentities(
    users: { reason: string }[],
    anyMismatch = false,
  ): Promise<void> {
    if (
      users.some((user) =>
        ["INVALID_TIME", "INVALID_CREDENTIAL_VERSION"].includes(user.reason),
      )
    )
      throw new Error("NATIVE_CUTOVER_UNRESOLVED_IDENTITIES");
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM public.users
      WHERE native_registration_completed_at IS NULL
        AND better_auth_email_verified <> (email_verified_at IS NOT NULL)
        AND (${anyMismatch} OR status <> 'ACTIVE' OR disabled_at IS NOT NULL)`;
    if (rows[0]?.count !== 0n)
      throw new Error("NATIVE_CUTOVER_UNRESOLVED_IDENTITIES");
  }

  // Existing Native destination records (a Better Auth account, a Native
  // registration mark, or enrollment) are judged by the accepted D5-P4
  // provenance rules themselves, never by a copy: the readiness check's shared
  // predicate runs here against the state sealing would produce. Enrollment rows
  // exist only for the active run, so a destination that predates this run
  // cannot become valid, and the writer skips or conflicts on it. Refusing it
  // before quiesce leaves LEGACY editable; refusing again before the seal
  // prevents an irreversibly sealed database whose API cannot start. Absence
  // from the writer's "remaining eligible" count proves nothing: it excludes
  // every user that already has a destination.
  async function assertDestinationRecordsResolved(): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const gateRows = await tx.$queryRaw<{ quiesced_at: Date | null }[]>`
          SELECT quiesced_at FROM public.native_auth_transition WHERE id = true`;
        const nowRows = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT clock_timestamp() AS now`;
        const now = nowRows[0]?.now;
        if (gateRows.length !== 1 || !now)
          throw new Error("NATIVE_CUTOVER_FENCE_INVALID");
        const users = await tx.user.findMany({
          include: { betterAuthAccounts: true, nativeAuthEnrollment: true },
          orderBy: { id: "asc" },
        });
        if (
          await hasCrossedAccountIdentity(
            tx,
            users.map((user) => user.id),
          )
        )
          throw new Error("NATIVE_CUTOVER_UNRESOLVED_IDENTITIES");
        const gate = {
          runId,
          quiescedAt: gateRows[0]?.quiesced_at ?? now,
          sealedAt: now,
          sealPending: true,
        };
        for (const user of users)
          if (
            hasNativeDestination(user) &&
            nativeDestinationRefused(user, gate, now)
          )
            throw new Error("NATIVE_CUTOVER_UNRESOLVED_IDENTITIES");
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  const transition = await createNativeAuthTransition({
    prisma,
    runId,
    async assertTarget(tx) {
      const rows = await tx.$queryRaw<
        { name: string }[]
      >`SELECT current_database() AS name`;
      if (rows[0]?.name !== confirmDatabase)
        throw new Error("TRANSITION_TARGET_MISMATCH");
    },
  });

  const before = await transition.preflight();
  await report({
    event: "preflight",
    mode: before.mode,
    users: before.users.length,
    ...countReasons(before.users),
  });
  // Refuse while the database is still editable LEGACY data: identities the
  // accepted readiness check would reject can no longer be repaired after
  // quiesce, and sealing them would leave a NATIVE database that cannot start.
  if (before.mode === "LEGACY") await assertResolvableIdentities(before.users);
  await assertDestinationRecordsResolved();
  await report({
    event: "quiesced",
    runId,
    mode: (await transition.quiesce()).mode,
  });

  let snapshot = await transition.preflight();
  let verificationReconciled = 0;
  for (const user of snapshot.users) {
    // Eligibility reports only the first issue: a Legacy-verified user whose
    // Better Auth flag was never set appears as UNVERIFIED_USER. The writer
    // returns UNCHANGED when there is nothing to reconcile.
    if (
      user.reason !== "VERIFICATION_MISMATCH" &&
      user.reason !== "UNVERIFIED_USER"
    )
      continue;
    const result = await transition.reconcileVerification(
      user.userId,
      user,
      "LEGACY_EMAIL_VERIFIED_AT",
    );
    if (result.outcome === "CONFLICT")
      throw new Error("NATIVE_CUTOVER_VERIFICATION_CONFLICT");
    if (result.outcome === "RECONCILED") verificationReconciled++;
  }
  if (verificationReconciled > 0) snapshot = await transition.preflight();

  let enrolled = 0;
  let replayed = 0;
  let ineligible = 0;
  for (const user of snapshot.users) {
    // Resumed runs report enrolled users as EXISTING_DESTINATION; an exact
    // replay through the writer confirms their provenance before sealing.
    if (!user.eligible && user.reason !== "EXISTING_DESTINATION") {
      ineligible++;
      continue;
    }
    const result = await transition.transitionUser(user.userId, user);
    if (result.outcome === "TRANSITIONED") enrolled++;
    else if (result.outcome === "REPLAY") replayed++;
    else if (result.outcome === "INELIGIBLE") ineligible++;
    else throw new Error("NATIVE_CUTOVER_ENROLLMENT_CONFLICT");
  }
  await report({
    event: "enrollment",
    users: snapshot.users.length,
    verificationReconciled,
    enrolled,
    replayed,
    ineligible,
  });

  const reconciliation = await transition.reconcile();
  await report({ event: "reconciliation", ...reconciliation });
  if (
    !reconciliation.identityPreserved ||
    reconciliation.legacyAuthorityRemaining !== 0 ||
    reconciliation.remainingEligible !== 0
  )
    throw new Error("NATIVE_CUTOVER_RECONCILIATION_FAILED");
  // Defense in depth: never seal identities the readiness check would reject.
  await assertResolvableIdentities((await transition.preflight()).users, true);
  await assertDestinationRecordsResolved();
  await report({ event: "sealed", mode: (await transition.seal()).mode });
  await assertNativeCutoverReady(prisma);
  await report({ event: "native_ready" });
  return {
    outcome: "SEALED_NATIVE",
    runId,
    users: snapshot.users.length,
    verificationReconciled,
    enrolled,
    replayed,
    ineligible,
  };
}
