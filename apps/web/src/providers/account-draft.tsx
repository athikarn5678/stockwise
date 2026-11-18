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

// Route-owned unsaved forms, one entry per scope (the Settings page holds the
// profile and the organization form at once). Not a private-query cache. Only a
// soft revalidation may hand an entry to a new component after fresh authority
// matches.
export function createAccountDraftStore(): AccountDraftStore {
  const entries = new Map<string, { authority: string; value: AccountDraft }>();
  return {
    clear() {
      entries.clear();
    },
    reconcile(context: AccessContext | null) {
      if (!context) {
        entries.clear();
        return;
      }
      const authority = accountDraftAuthority(context);
      for (const [scope, entry] of entries)
        if (entry.authority !== authority) entries.delete(scope);
    },
    read(
      scope: string,
      context: AccessContext | undefined,
    ): AccountDraft | null {
      const entry = entries.get(scope);
      if (!context || entry === undefined) return null;
      if (entry.authority !== accountDraftAuthority(context)) {
        entries.delete(scope);
        return null;
      }
      return entry.value;
    },
    write(
      scope: string,
      context: AccessContext | undefined,
      value: AccountDraft | null,
    ) {
      // Without a cached context only this scope's entry is dropped: another
      // form on the same page (Settings) keeps its own draft.
      if (!context || !value) {
        entries.delete(scope);
        return;
      }
      entries.set(scope, { authority: accountDraftAuthority(context), value });
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
