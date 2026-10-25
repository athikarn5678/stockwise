"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { applicationContextUrl } from "@/application-context";
import {
  type AccessContext,
  fetchAccessContext,
  fetchBranches,
  type AccessibleOrganization,
  type Branch,
} from "@/branch-api-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type { TranslationKey } from "@/i18n/en";
import {
  createInvitation,
  deactivateMembership,
  fetchInvitations,
  fetchMemberships,
  type Invitation,
  type Membership,
  MembershipApiError,
  type MembershipRole,
  reactivateMembership,
  replaceMembership,
  revokeInvitation,
} from "@/membership-api-client";
import { accountDraftAuthority } from "@/providers/account-draft";
import { useLanguage } from "@/providers/language-provider";
import { currentPrivateSessionSignal } from "@/session-lifecycle";

const ALL_ROLES: MembershipRole[] = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
];
const ROLE_HELP: Record<MembershipRole, TranslationKey> = {
  OWNER: "teamRoleOwner",
  ADMIN: "teamRoleAdmin",
  BRANCH_MANAGER: "teamRoleManager",
  INVENTORY_STAFF: "teamRoleInventory",
  CASHIER: "teamRoleCashier",
};
const STATUS: Record<
  Invitation["state"] | Membership["status"],
  TranslationKey
> = {
  ACTIVE: "teamActive",
  INACTIVE: "teamInactive",
  PENDING: "teamPending",
  EXPIRED: "teamExpired",
  ACCEPTED: "teamAccepted",
  REVOKED: "teamRevoked",
  REPLACED: "teamReplaced",
};
const ERRORS: Record<MembershipApiError["kind"], TranslationKey> = {
  authentication_required: "teamErrorAuthentication",
  delivery_failed: "teamErrorDelivery",
  finalized: "teamErrorFinalized",
  forbidden: "teamErrorForbidden",
  invalid_branch_scope: "teamErrorBranch",
  invalid_invitation: "teamErrorInvitation",
  invitation_scope_invalid: "teamErrorInvitationScope",
  last_active_owner: "teamErrorOwner",
  membership_exists: "teamErrorExists",
  not_found: "teamErrorNotFound",
  stale: "teamAccessChanged",
  state_invalid: "teamErrorState",
  unavailable: "teamErrorUnavailable",
  validation: "teamErrorValidation",
};
function branchRole(role: MembershipRole) {
  return role !== "OWNER" && role !== "ADMIN";
}
function effectiveBranchIds(member: Membership) {
  return member.branchAssignments
    .filter(
      ({ branch, status }) => status === "ACTIVE" && branch.status === "ACTIVE",
    )
    .map(({ branch }) => branch.id);
}
function Failure({ error }: { error: unknown }) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (
      error instanceof MembershipApiError &&
      (error.kind === "forbidden" || error.kind === "authentication_required")
    )
      void queryClient.invalidateQueries({ queryKey: ["access-context"] });
  }, [error, queryClient]);
  return (
    <p className="form-message text-sm text-destructive" role="alert">
      {t(
        error instanceof MembershipApiError
          ? ERRORS[error.kind]
          : "teamErrorUnavailable",
      )}
    </p>
  );
}

export function MembershipManagement() {
  const { t } = useLanguage();
  const params = useSearchParams();
  const context = useQuery({
    queryKey: ["access-context"],
    queryFn: ({ signal }) => fetchAccessContext({ signal }),
    retry: false,
  });
  const organization = context.data?.organizations.find(
    ({ id }) => id === params.get("organizationId"),
  );
  if (context.isPending) return <p aria-live="polite">{t("loadingAccess")}</p>;
  if (context.isError)
    return (
      <div className="space-y-3">
        <p role="alert">{t("accessError")}</p>
        <Button onClick={() => void context.refetch()}>{t("teamRetry")}</Button>
      </div>
    );
  if (
    !organization ||
    (organization.role !== "OWNER" && organization.role !== "ADMIN")
  )
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">{t("teamUnavailable")}</h1>
        <p>{t("teamDenied")}</p>
        <Link className="underline" href="/app">
          {t("backToWorkspace")}
        </Link>
      </section>
    );
  return (
    <TeamWorkspace
      key={`${organization.id}:${accountDraftAuthority(context.data)}`}
      organization={organization}
      branchId={params.get("branchId")}
    />
  );
}

export function MembershipManagementFallback() {
  const { t } = useLanguage();
  return <p aria-live="polite">{t("teamLoadingMembers")}</p>;
}

function TeamWorkspace({
  organization,
  branchId,
}: {
  organization: AccessibleOrganization;
  branchId: string | null;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const organizationId = organization.id;
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const branchesQuery = useQuery({
    queryKey: ["branches", organizationId, false],
    queryFn: () => fetchBranches(organizationId),
    retry: false,
  });
  const membersQuery = useInfiniteQuery({
    queryKey: ["members", organizationId, includeInactive],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchMemberships(organizationId, includeInactive, pageParam),
    getNextPageParam: (page) => page.meta.nextCursor,
    retry: false,
  });
  const invitationsQuery = useInfiniteQuery({
    queryKey: ["invitations", organizationId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchInvitations(organizationId, pageParam),
    getNextPageParam: (page) => page.meta.nextCursor,
    retry: false,
  });
  const denied = [membersQuery.error, invitationsQuery.error].some(
    (error) =>
      error instanceof MembershipApiError &&
      (error.kind === "forbidden" || error.kind === "authentication_required"),
  );
  useEffect(() => {
    if (denied)
      void queryClient.invalidateQueries({ queryKey: ["access-context"] });
  }, [denied, queryClient]);
  async function refresh(message?: TranslationKey) {
    if (message) setNotice(message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["access-context"] }),
      queryClient.invalidateQueries({ queryKey: ["members", organizationId] }),
      queryClient.invalidateQueries({
        queryKey: ["invitations", organizationId],
      }),
      queryClient.invalidateQueries({ queryKey: ["branches", organizationId] }),
    ]);
  }
  const members = membersQuery.data?.pages.flatMap(({ data }) => data) ?? [];
  const invitations =
    invitationsQuery.data?.pages.flatMap(({ data }) => data) ?? [];
  const branches = branchesQuery.data ?? [];
  if (denied)
    return (
      <div className="space-y-3">
        <p role="alert">{t("teamErrorForbidden")}</p>
        <Button onClick={() => void refresh()}>{t("teamRefresh")}</Button>
      </div>
    );
  return (
    <section className="w-full min-w-0 space-y-8">
      <header className="space-y-3">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organizationId, branchId)}
        >
          {t("backToWorkspace")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t("teamTitle")}</h1>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {t("teamDescription")} {organization.name}.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={
              membersQuery.isFetching ||
              invitationsQuery.isFetching ||
              branchesQuery.isFetching
            }
            onClick={() => void refresh()}
          >
            {t("teamRefresh")}
          </Button>
        </div>
        <aside className="rounded-lg border bg-muted/30 p-4">
          <h2 className="font-semibold">{t("teamRules")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("teamRulesHelp")}
          </p>
        </aside>
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">
            {t("teamRoleGuide")}
          </summary>
          <dl className="mt-4 grid gap-4 md:grid-cols-2">
            {ALL_ROLES.map((role) => (
              <div key={role}>
                <dt className="font-medium">{t(role)}</dt>
                <dd className="mt-1 text-sm text-muted-foreground">
                  {t(ROLE_HELP[role])}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </header>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(notice)}
        </p>
      )}
      {branchesQuery.isPending && (
        <p role="status">{t("teamLoadingBranches")}</p>
      )}
      {branchesQuery.isError && (
        <div className="space-y-2">
          <p role="alert">{t("teamBranchesError")}</p>
          <Button
            variant="outline"
            onClick={() => void branchesQuery.refetch()}
          >
            {t("teamRetry")}
          </Button>
        </div>
      )}
      <InviteForm
        actorRole={organization.role}
        branches={branches}
        scopeReady={branchesQuery.isSuccess}
        organizationId={organizationId}
        onSaved={refresh}
      />
      <section className="space-y-4" aria-labelledby="organization-members">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold" id="organization-members">
            {t("teamMembers")}
          </h2>
          <Label className="flex min-h-11 items-center gap-2">
            <Checkbox
              checked={includeInactive}
              onCheckedChange={setIncludeInactive}
            />
            {t("teamIncludeInactive")}
          </Label>
        </div>
        {membersQuery.isPending && (
          <p role="status">{t("teamLoadingMembers")}</p>
        )}
        {membersQuery.isError && (
          <div className="space-y-2">
            <p role="alert">{t("teamMembersError")}</p>
            <Button onClick={() => void membersQuery.refetch()}>
              {t("teamRetry")}
            </Button>
          </div>
        )}
        {membersQuery.isSuccess && members.length === 0 && (
          <p className="text-muted-foreground">{t("teamNoMembers")}</p>
        )}
        {members.map((member) => (
          <MemberEditor
            key={member.id}
            actorRole={organization.role}
            member={member}
            branches={branches}
            scopeReady={branchesQuery.isSuccess}
            organizationId={organizationId}
            onSaved={refresh}
          />
        ))}
        {membersQuery.hasNextPage && (
          <Button
            variant="outline"
            disabled={membersQuery.isFetching}
            onClick={() => void membersQuery.fetchNextPage()}
          >
            {t("teamMoreMembers")}
          </Button>
        )}
      </section>
      <section className="space-y-4" aria-labelledby="open-invitations">
        <h2 className="text-xl font-semibold" id="open-invitations">
          {t("teamInvitations")}
        </h2>
        {invitationsQuery.isPending && (
          <p role="status">{t("teamLoadingInvitations")}</p>
        )}
        {invitationsQuery.isError && (
          <div className="space-y-2">
            <p role="alert">{t("teamInvitationsError")}</p>
            <Button onClick={() => void invitationsQuery.refetch()}>
              {t("teamRetry")}
            </Button>
          </div>
        )}
        {invitationsQuery.isSuccess && invitations.length === 0 && (
          <p className="text-muted-foreground">{t("teamNoInvitations")}</p>
        )}
        {invitations.map((invitation) => (
          <InvitationCard
            key={invitation.id}
            actorRole={organization.role}
            invitation={invitation}
            organizationId={organizationId}
            onSaved={refresh}
          />
        ))}
        {invitationsQuery.hasNextPage && (
          <Button
            variant="outline"
            disabled={invitationsQuery.isFetching}
            onClick={() => void invitationsQuery.fetchNextPage()}
          >
            {t("teamMoreInvitations")}
          </Button>
        )}
      </section>
    </section>
  );
}

type EditorProps = {
  actorRole: AccessibleOrganization["role"];
  branches: Branch[];
  scopeReady: boolean;
  organizationId: string;
  onSaved: (message?: TranslationKey) => Promise<void>;
};
type InviteSubmission = {
  authority: string | undefined;
  branchIds: string[];
  email: string;
  role: MembershipRole;
  signal: AbortSignal;
};
function InviteForm({
  actorRole,
  branches,
  scopeReady,
  organizationId,
  onSaved,
}: EditorProps) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("CASHIER");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const draft = useRef({ email, role, branchIds });
  draft.current = { email, role, branchIds };
  const submissionLocked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function currentAuthority() {
    const access = queryClient.getQueryData<AccessContext>(["access-context"]);
    return access ? accountDraftAuthority(access) : undefined;
  }
  const mutation = useMutation({
    mutationFn: async (submission: InviteSubmission) => {
      submission.signal.throwIfAborted();
      if (!mounted.current || currentAuthority() !== submission.authority)
        return null;
      const result = await createInvitation(organizationId, {
        email: submission.email,
        role: submission.role,
        branchIds: submission.branchIds,
      });
      submission.signal.throwIfAborted();
      return result;
    },
    onSuccess: async (_result, submission) => {
      if (
        !mounted.current ||
        submission.signal.aborted ||
        currentAuthority() !== submission.authority
      )
        return;
      if (
        draft.current.email === submission.email &&
        draft.current.role === submission.role &&
        draft.current.branchIds.length === submission.branchIds.length &&
        draft.current.branchIds.every(
          (id, index) => id === submission.branchIds[index],
        )
      ) {
        setEmail("");
        setBranchIds([]);
      }
      await onSaved("teamInvited");
    },
    onSettled: () => {
      submissionLocked.current = false;
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      submissionLocked.current ||
      mutation.isPending ||
      !scopeReady ||
      (branchRole(role) && !branchIds.length)
    )
      return;
    submissionLocked.current = true;
    const submission: InviteSubmission = {
      authority: currentAuthority(),
      branchIds: [...branchIds],
      email,
      role,
      signal: currentPrivateSessionSignal(),
    };
    if (
      !submission.authority ||
      submission.signal.aborted ||
      !mounted.current
    ) {
      submissionLocked.current = false;
      return;
    }
    const scope = branchRole(submission.role)
      ? branches
          .filter(({ id }) => submission.branchIds.includes(id))
          .map(({ code, name }) => `${code} — ${name}`)
          .join(", ")
      : t("teamOrganizationScope");
    const details: Record<string, string> = {
      "{email}": submission.email,
      "{role}": t(submission.role),
      "{scope}": scope,
    };
    const prompt = t("teamInviteConfirm").replace(
      /\{(?:email|role|scope)\}/g,
      (placeholder) => details[placeholder] ?? placeholder,
    );
    if (!window.confirm(prompt)) {
      submissionLocked.current = false;
      return;
    }
    if (
      !mounted.current ||
      submission.signal.aborted ||
      currentAuthority() !== submission.authority
    ) {
      submissionLocked.current = false;
      return;
    }
    mutation.mutate(submission);
  }
  return (
    <form className="rounded-lg border bg-card p-4 sm:p-5" onSubmit={submit}>
      <h2 className="text-xl font-semibold">{t("teamInvite")}</h2>
      <fieldset disabled={mutation.isPending || !scopeReady}>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Label className="form-field">
            {t("teamEmail")}
            <Input
              autoComplete="email"
              required
              type="email"
              value={email}
              onChange={(event) => {
                draft.current = { ...draft.current, email: event.target.value };
                setEmail(event.target.value);
              }}
            />
          </Label>
          <RoleSelect
            actorRole={actorRole}
            value={role}
            onChange={(next) => {
              draft.current = {
                ...draft.current,
                role: next,
                branchIds: branchRole(next) ? draft.current.branchIds : [],
              };
              setRole(next);
              if (!branchRole(next)) setBranchIds([]);
            }}
          />
        </div>
        <ScopeFields
          branches={branches}
          disabled={mutation.isPending || !scopeReady}
          role={role}
          selected={branchIds}
          onChange={(next) => {
            draft.current = { ...draft.current, branchIds: next };
            setBranchIds(next);
          }}
        />
        <Button
          className="mt-4"
          type="submit"
          disabled={
            mutation.isPending || (branchRole(role) && !branchIds.length)
          }
        >
          {t(mutation.isPending ? "teamSending" : "teamSend")}
        </Button>
      </fieldset>
      {mutation.isError && <Failure error={mutation.error} />}
    </form>
  );
}

function InvitationCard({
  actorRole,
  invitation,
  organizationId,
  onSaved,
}: {
  actorRole: AccessibleOrganization["role"];
  invitation: Invitation;
  organizationId: string;
  onSaved: EditorProps["onSaved"];
}) {
  const { t, language } = useLanguage();
  const canDelegate =
    actorRole === "OWNER" || invitation.intendedRole !== "OWNER";
  const open = invitation.state === "PENDING" || invitation.state === "EXPIRED";
  const mutation = useMutation({
    mutationFn: async (action: "revoke" | "reissue") => {
      const signal = currentPrivateSessionSignal();
      const result =
        action === "revoke"
          ? await revokeInvitation(organizationId, invitation.id)
          : await createInvitation(organizationId, {
              email: invitation.invitedEmail,
              role: invitation.intendedRole,
              branchIds: invitation.branchScopes.map(({ id }) => id),
            });
      signal.throwIfAborted();
      return result;
    },
    onSuccess: () => onSaved("teamInvitationUpdated"),
  });
  return (
    <article className="min-w-0 rounded-lg border bg-card p-4 sm:p-5">
      <h3 className="break-all font-semibold">{invitation.invitedEmail}</h3>
      <p className="mt-1 text-sm">
        {t(invitation.intendedRole)} · {t(STATUS[invitation.state])}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("teamExpires")}:{" "}
        {new Intl.DateTimeFormat(language === "th" ? "th-TH" : "en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        }).format(new Date(invitation.expiresAt))}{" "}
        UTC
      </p>
      <ConfiguredScope
        role={invitation.intendedRole}
        branches={invitation.branchScopes.map((branch) => ({
          branch,
          status: "ACTIVE",
        }))}
      />
      {canDelegate && open ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `${invitation.invitedEmail}\n${t("teamConfirmReissue")}`,
                )
              )
                mutation.mutate("reissue");
            }}
          >
            {t("teamReissue")}
          </Button>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `${invitation.invitedEmail}\n${t("teamConfirmRevoke")}`,
                )
              )
                mutation.mutate("revoke");
            }}
          >
            {t("teamRevoke")}
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {t(canDelegate ? "teamReadOnlyInvitation" : "teamInviteOwnerOnly")}
        </p>
      )}
      {mutation.isError && <Failure error={mutation.error} />}
    </article>
  );
}

function MemberEditor({
  actorRole,
  branches,
  scopeReady,
  member,
  organizationId,
  onSaved,
}: EditorProps & { member: Membership }) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  // Ordinary refetch must not silently rebase an unsaved privileged change.
  const [base, setBase] = useState(member);
  const [role, setRole] = useState<MembershipRole>(member.role);
  const [branchIds, setBranchIds] = useState(() => effectiveBranchIds(member));
  const canMutate = actorRole === "OWNER" || member.role !== "OWNER";
  const mutation = useMutation({
    mutationFn: async (action: "save" | "deactivate") => {
      const signal = currentPrivateSessionSignal();
      const input = { branchIds, role, expectedUpdatedAt: base.updatedAt };
      const updated =
        action === "deactivate"
          ? await deactivateMembership(organizationId, base)
          : base.status === "ACTIVE"
            ? await replaceMembership(organizationId, base.id, input)
            : await reactivateMembership(organizationId, base.id, input);
      signal.throwIfAborted();
      return updated;
    },
    onSuccess: async (updated) => {
      setBase(updated);
      setRole(updated.role);
      setBranchIds(effectiveBranchIds(updated));
      await onSaved("teamSaved");
    },
  });
  const stale =
    member.updatedAt !== base.updatedAt ||
    (mutation.error instanceof MembershipApiError &&
      mutation.error.kind === "stale");
  const forbidden =
    mutation.error instanceof MembershipApiError &&
    (mutation.error.kind === "forbidden" ||
      mutation.error.kind === "authentication_required");
  useEffect(() => {
    if (forbidden)
      void queryClient.invalidateQueries({ queryKey: ["access-context"] });
  }, [forbidden, queryClient]);
  const originalIds = effectiveBranchIds(base);
  const dirty =
    role !== base.role ||
    branchIds.length !== originalIds.length ||
    branchIds.some((id) => !originalIds.includes(id));
  function reset(latest: Membership) {
    setBase(latest);
    setRole(latest.role);
    setBranchIds(effectiveBranchIds(latest));
    mutation.reset();
  }
  const [reloading, setReloading] = useState(false);
  async function reload() {
    if (reloading || (dirty && !window.confirm(t("teamReloadConfirm")))) return;
    setReloading(true);
    const signal = currentPrivateSessionSignal();
    try {
      // No detail endpoint exists: find the current member in the safe list.
      let cursor: string | null = null;
      do {
        const page = await fetchMemberships(organizationId, true, cursor);
        signal.throwIfAborted();
        const latest = page.data.find(({ id }) => id === member.id);
        if (latest) {
          reset(latest);
          await onSaved();
          return;
        }
        cursor = page.meta.nextCursor;
      } while (cursor !== null);
      throw new MembershipApiError("not_found");
    } finally {
      setReloading(false);
    }
  }
  const [reloadError, setReloadError] = useState<unknown>(null);
  return (
    <article className="min-w-0 rounded-lg border bg-card p-4 sm:p-5">
      <h3 className="break-words font-semibold">
        {member.user.displayName ?? member.user.email}
      </h3>
      <p className="mt-1 break-all text-sm text-muted-foreground">
        {member.user.email}
      </p>
      <p className="mt-1 text-sm">
        {t(member.role)} · {t(STATUS[member.status])}
      </p>
      <ConfiguredScope role={member.role} branches={member.branchAssignments} />
      {canMutate ? (
        <div className="mt-4 space-y-3">
          {dirty && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("teamUnsaved")}
            </p>
          )}
          <fieldset
            className="space-y-3"
            disabled={mutation.isPending || !scopeReady || stale || forbidden}
          >
            <RoleSelect
              actorRole={actorRole}
              value={role}
              onChange={(next) => {
                setRole(next);
                if (!branchRole(next)) setBranchIds([]);
              }}
            />
            <ScopeFields
              branches={branches}
              disabled={mutation.isPending || !scopeReady || stale || forbidden}
              role={role}
              selected={branchIds}
              onChange={setBranchIds}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  (branchRole(role) && !branchIds.length) ||
                  (base.status === "ACTIVE" && !dirty)
                }
                onClick={() => {
                  if (
                    window.confirm(
                      t(
                        base.status === "ACTIVE"
                          ? "teamConfirmSave"
                          : "teamConfirmReactivate",
                      ),
                    )
                  )
                    mutation.mutate("save");
                }}
              >
                {t(
                  mutation.isPending
                    ? "teamWorking"
                    : base.status === "ACTIVE"
                      ? "teamSave"
                      : "teamReactivate",
                )}
              </Button>
              {base.status === "ACTIVE" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (window.confirm(t("teamConfirmDeactivate")))
                      mutation.mutate("deactivate");
                  }}
                >
                  {t("teamDeactivate")}
                </Button>
              )}
              {dirty && (
                <Button variant="ghost" onClick={() => reset(base)}>
                  {t("teamCancel")}
                </Button>
              )}
            </div>
          </fieldset>
          {stale && (
            <div className="space-y-2">
              <p role="alert" className="text-sm">
                {t("teamAccessChanged")}
              </p>
              <Button
                variant="outline"
                disabled={mutation.isPending || reloading}
                onClick={() => {
                  setReloadError(null);
                  void reload().catch(setReloadError);
                }}
              >
                {t("teamReload")}
              </Button>
            </div>
          )}
          {mutation.isError && !stale && <Failure error={mutation.error} />}
          {reloadError !== null && <Failure error={reloadError} />}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("teamOwnerOnly")}
        </p>
      )}
    </article>
  );
}

function ConfiguredScope({
  role,
  branches,
}: {
  role: MembershipRole;
  branches: Membership["branchAssignments"];
}) {
  const { t } = useLanguage();
  if (!branchRole(role))
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        {t("teamOrganizationScope")}
      </p>
    );
  return (
    <div className="mt-2 text-sm text-muted-foreground">
      <p>{t("teamBranchScope")}:</p>
      {branches.length ? (
        <ul className="mt-1 space-y-1">
          {branches.map(({ branch, status }) => (
            <li className="break-words" key={branch.id}>
              {branch.code} — {branch.name}
              {branch.status === "INACTIVE" || status === "INACTIVE"
                ? ` (${t("teamInactive")})`
                : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("teamNoAssignments")}</p>
      )}
    </div>
  );
}
function RoleSelect({
  actorRole,
  onChange,
  value,
}: {
  actorRole: AccessibleOrganization["role"];
  onChange: (role: MembershipRole) => void;
  value: MembershipRole;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <Label className="form-field">
        {t("teamRole")}
        <NativeSelect
          className="mt-1 w-full"
          value={value}
          onChange={(event) => {
            const next = ALL_ROLES.find((role) => role === event.target.value);
            if (next) onChange(next);
          }}
        >
          {ALL_ROLES.filter(
            (role) => actorRole === "OWNER" || role !== "OWNER",
          ).map((role) => (
            <NativeSelectOption key={role} value={role}>
              {t(role)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Label>
      <p className="text-sm text-muted-foreground">{t(ROLE_HELP[value])}</p>
    </div>
  );
}
function ScopeFields({
  branches,
  disabled,
  onChange,
  role,
  selected,
}: {
  branches: Branch[];
  onChange: (ids: string[]) => void;
  role: MembershipRole;
  selected: string[];
  disabled: boolean;
}) {
  const { t } = useLanguage();
  if (!branchRole(role))
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {t("teamOrganizationScope")}
      </p>
    );
  const active = branches.filter(({ status }) => status === "ACTIVE");
  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-medium">{t("teamScopeLegend")}</legend>
      <p className="mt-1 text-sm text-muted-foreground">{t("teamScopeHelp")}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {active.map((branch) => (
          <Label
            className="flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm"
            key={branch.id}
          >
            <Checkbox
              checked={selected.includes(branch.id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, branch.id]
                    : selected.filter((id) => id !== branch.id),
                )
              }
            />
            <span className="min-w-0 break-words">
              {branch.code} — {branch.name}
            </span>
          </Label>
        ))}
      </div>
      {!active.length ? (
        <p className="mt-2 text-sm">{t("teamNoBranches")}</p>
      ) : !selected.length ? (
        <p className="mt-2 text-sm">{t("teamSelectBranch")}</p>
      ) : null}
    </fieldset>
  );
}
