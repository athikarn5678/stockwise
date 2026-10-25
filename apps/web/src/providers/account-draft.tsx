"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import type { AccessContext } from "@/branch-api-client";

export interface ProfileDraft {
  displayName: string;
  phone: string;
  saved: { displayName: string; phone: string };
  baseUpdatedAt: string | null;
}
export interface OrganizationDraft {
  name: string;
  savedName: string;
  baseUpdatedAt: string | null;
}
type AccountDraft = ProfileDraft | OrganizationDraft;

export function accountDraftAuthority(context: AccessContext): string {
  return JSON.stringify([
    context.user.id,
    context.organizations
      .map((organization) => [
        organization.id,
        organization.role,
        organization.branches.map((branch) => branch.id).sort(),
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
}
export interface AccountDraftStore {
  clear(): void;
  reconcile(context: AccessContext | null): void;
  read(scope: string, context: AccessContext | undefined): AccountDraft | null;
  write(
    scope: string,
    context: AccessContext | undefined,
    value: AccountDraft | null,
  ): void;
}

// One route-owned unsaved form, not a private-query cache. Only a soft
// revalidation may hand it to a new component after fresh authority matches.
export function createAccountDraftStore(): AccountDraftStore {
  let entry: { scope: string; authority: string; value: AccountDraft } | null =
    null;
  return {
    clear() {
      entry = null;
    },
    reconcile(context: AccessContext | null) {
      if (
        !context ||
        (entry && entry.authority !== accountDraftAuthority(context))
      )
        entry = null;
    },
    read(
      scope: string,
      context: AccessContext | undefined,
    ): AccountDraft | null {
      if (!context || entry?.scope !== scope) return null;
      if (entry.authority !== accountDraftAuthority(context)) {
        entry = null;
        return null;
      }
      return entry.value;
    },
    write(
      scope: string,
      context: AccessContext | undefined,
      value: AccountDraft | null,
    ) {
      if (!context || !value) {
        entry = null;
        return;
      }
      entry = { scope, authority: accountDraftAuthority(context), value };
    },
  };
}
export const AccountDraftContext = createContext<AccountDraftStore | null>(
  null,
);

export function useAccountDraft(scope: string) {
  const store = useContext(AccountDraftContext);
  const client = useQueryClient();
  const [restored] = useState(() =>
    store?.read(scope, client.getQueryData<AccessContext>(["access-context"])),
  );
  return {
    restored: restored ?? null,
    remember(value: AccountDraft | null) {
      store?.write(
        scope,
        client.getQueryData<AccessContext>(["access-context"]),
        value,
      );
    },
  };
}
