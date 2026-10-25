// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAccessContext, fetchBranches } from "@/branch-api-client";
import {
  createInvitation,
  deactivateMembership,
  fetchInvitations,
  fetchMemberships,
  MembershipApiError,
  reactivateMembership,
  replaceMembership,
  revokeInvitation,
} from "@/membership-api-client";
import { LanguageProvider } from "@/providers/language-provider";
import { notifySessionChange } from "@/session-lifecycle";
import { th } from "@/i18n/th";

import { MembershipManagement } from "./membership-management";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const MEMBER_ID = "30000000-0000-4000-8000-000000000001";
const INVITATION_ID = "40000000-0000-4000-8000-000000000001";
let requestedOrganizationId = ORGANIZATION_ID;

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams({
      branchId: BRANCH_ID,
      organizationId: requestedOrganizationId,
    }),
}));

vi.mock("@/branch-api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/branch-api-client")>();
  return {
    ...original,
    fetchAccessContext: vi.fn(),
    fetchBranches: vi.fn(),
  };
});

vi.mock("@/membership-api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/membership-api-client")>();
  return {
    ...original,
    createInvitation: vi.fn(),
    deactivateMembership: vi.fn(),
    fetchInvitations: vi.fn(),
    fetchMemberships: vi.fn(),
    reactivateMembership: vi.fn(),
    replaceMembership: vi.fn(),
    revokeInvitation: vi.fn(),
  };
});

const branch = {
  address: null,
  code: "MAIN",
  id: BRANCH_ID,
  name: "Main",
  organizationId: ORGANIZATION_ID,
  phone: null,
  status: "ACTIVE" as const,
  updatedAt: "2026-08-24T12:00:00.000Z",
};
const membership = {
  branchAssignments: [
    {
      branch: {
        code: branch.code,
        id: branch.id,
        name: branch.name,
        status: branch.status,
      },
      status: "ACTIVE" as const,
    },
  ],
  createdAt: "2026-08-24T12:00:00.000Z",
  id: MEMBER_ID,
  organization: { id: ORGANIZATION_ID, name: "Store" },
  role: "CASHIER" as const,
  status: "ACTIVE" as const,
  updatedAt: "2026-08-24T12:00:00.000Z",
  user: {
    displayName: "Cashier",
    email: "cashier@example.com",
    id: "50000000-0000-4000-8000-000000000001",
  },
};
const invitation = {
  branchScopes: [
    {
      code: branch.code,
      id: branch.id,
      name: branch.name,
      status: branch.status,
    },
  ],
  createdAt: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-31T12:00:00.000Z",
  id: INVITATION_ID,
  intendedRole: "CASHIER" as const,
  invitedEmail: "invitee@example.com",
  state: "PENDING" as const,
};

function context(role: "OWNER" | "ADMIN" | "CASHIER" = "OWNER") {
  return {
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        branches: [{ code: branch.code, id: branch.id, name: branch.name }],
        id: ORGANIZATION_ID,
        name: "Store",
        role,
      },
    ],
    user: {
      displayName: "Owner",
      email: "owner@example.com",
      id: "60000000-0000-4000-8000-000000000001",
    },
  };
}

function renderManagement() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <MembershipManagement />
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  requestedOrganizationId = ORGANIZATION_ID;
  localStorage.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(fetchAccessContext).mockResolvedValue(context());
  vi.mocked(fetchBranches).mockResolvedValue([branch]);
  vi.mocked(fetchMemberships).mockResolvedValue({
    data: [membership],
    meta: { nextCursor: null },
  });
  vi.mocked(fetchInvitations).mockResolvedValue({
    data: [invitation],
    meta: { nextCursor: null },
  });
  vi.mocked(createInvitation).mockResolvedValue(invitation);
  vi.mocked(revokeInvitation).mockResolvedValue(invitation);
  vi.mocked(replaceMembership).mockResolvedValue(membership);
  vi.mocked(deactivateMembership).mockResolvedValue({
    ...membership,
    status: "INACTIVE",
  });
  vi.mocked(reactivateMembership).mockResolvedValue(membership);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("membership management UI", () => {
  it.each(["BRANCH_MANAGER", "INVENTORY_STAFF", "CASHIER"] as const)(
    "denies %s without loading management resources",
    async (role) => {
      vi.mocked(fetchAccessContext).mockResolvedValue({
        ...context(),
        organizations: [{ ...context().organizations[0]!, role }],
      });
      renderManagement();
      await screen.findByRole("heading", {
        name: "Member management unavailable",
      });
      expect(fetchMemberships).not.toHaveBeenCalled();
      expect(fetchInvitations).not.toHaveBeenCalled();
      expect(fetchBranches).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit branch before inviting and clears the sent address", async () => {
    renderManagement();
    const send = await screen.findByRole("button", { name: "Send invitation" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(send);
    await waitFor(() =>
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    expect(createInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, {
      branchIds: [BRANCH_ID],
      email: "new@example.com",
      role: "CASHIER",
    });
  });
  it.each([
    ["new", "new@example.com", false],
    ["visible existing", invitation.invitedEmail, true],
    ["unloaded existing", "later-page@example.com", false],
  ])(
    "cancelling an invite for a %s address makes no create request",
    async (_description, address, visible) => {
      if (visible) {
        vi.mocked(fetchInvitations).mockResolvedValue({
          data: [invitation],
          meta: { nextCursor: null },
        });
      } else {
        vi.mocked(fetchInvitations).mockResolvedValue({
          data: [],
          meta: { nextCursor: "next-page" },
        });
      }
      vi.mocked(window.confirm).mockReturnValue(false);
      renderManagement();
      fireEvent.change(await screen.findByLabelText("Email"), {
        target: { value: address },
      });
      fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(createInvitation).not.toHaveBeenCalled();
    },
  );

  it("confirms the actual invite details including branch scope", async () => {
    renderManagement();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "specific@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() =>
      expect(createInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, {
        branchIds: [BRANCH_ID],
        email: "specific@example.com",
        role: "CASHIER",
      }),
    );
    expect(window.confirm).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(window.confirm).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("specific@example.com");
    expect(prompt).toContain("CASHIER");
    expect(prompt).toContain("MAIN");
    expect(prompt).toMatch(/replace|invalidat/i);
  });

  it.each(["OWNER", "ADMIN"] as const)(
    "%s may invite with organization-wide scope",
    async (role) => {
      vi.mocked(fetchAccessContext).mockResolvedValue(context(role));
      renderManagement();
      fireEvent.change(await screen.findByLabelText("Email"), {
        target: { value: "wide@example.com" },
      });
      await screen.findAllByLabelText("MAIN — Main");
      fireEvent.change(screen.getAllByLabelText("Role")[0]!, {
        target: { value: "ADMIN" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
      await waitFor(() =>
        expect(createInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, {
          branchIds: [],
          email: "wide@example.com",
          role: "ADMIN",
        }),
      );
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(vi.mocked(window.confirm).mock.calls[0]?.[0]).toMatch(
        /organization-wide/i,
      );
    },
  );

  it("blocks duplicate submit while confirmation is open and submits its captured draft", async () => {
    vi.mocked(window.confirm).mockImplementation(() => {
      fireEvent.submit(screen.getByLabelText("Email").closest("form")!);
      expect(createInvitation).not.toHaveBeenCalled();
      return true;
    });
    renderManagement();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "captured@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() =>
      expect(createInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, {
        branchIds: [BRANCH_ID],
        email: "captured@example.com",
        role: "CASHIER",
      }),
    );
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it("keeps a changed unsent draft when the confirmed snapshot succeeds", async () => {
    vi.mocked(window.confirm).mockImplementation(() => {
      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "later@example.com" },
      });
      fireEvent.change(screen.getAllByLabelText("Role")[0]!, {
        target: { value: "ADMIN" },
      });
      return true;
    });
    renderManagement();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "confirmed@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() =>
      expect(createInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, {
        branchIds: [BRANCH_ID],
        email: "confirmed@example.com",
        role: "CASHIER",
      }),
    );
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
      "later@example.com",
    );
    expect(
      (screen.getAllByLabelText("Role")[0] as HTMLSelectElement).value,
    ).toBe("ADMIN");
  });

  it("does not send the confirmed invite after actor authority changes during confirmation", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    vi.mocked(window.confirm).mockImplementation(() => {
      client.setQueryData(["access-context"], context("CASHIER"));
      return true;
    });
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "stale-authority@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByRole("heading", {
      name: "Member management unavailable",
    });
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("does not send the confirmed invite after the private session changes", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    vi.mocked(window.confirm).mockImplementation(() => {
      notifySessionChange(client);
      return true;
    });
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "stale-session@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("does not send the confirmed invite after the organization changes", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
    vi.mocked(window.confirm).mockImplementation(() => {
      requestedOrganizationId = otherOrganizationId;
      client.setQueryData(["access-context"], {
        ...context(),
        organizations: [
          ...context().organizations,
          { ...context().organizations[0]!, id: otherOrganizationId },
        ],
      });
      return true;
    });
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "stale-organization@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("does not send after the actor switches while confirmation is open", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    vi.mocked(window.confirm).mockImplementation(() => {
      client.setQueryData(["access-context"], {
        ...context(),
        user: { ...context().user, id: "60000000-0000-4000-8000-000000000002" },
      });
      return true;
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "old-actor@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("shows retained inactive invitation branch scope", async () => {
    vi.mocked(fetchInvitations).mockResolvedValue({
      data: [
        {
          ...invitation,
          branchScopes: [
            {
              ...invitation.branchScopes[0]!,
              code: "OTHER",
              name: "Other retained branch",
              status: "INACTIVE" as const,
            },
          ],
        },
      ],
      meta: { nextCursor: null },
    });
    renderManagement();
    const card = await screen.findByRole("heading", {
      name: invitation.invitedEmail,
    });
    expect(card.closest("article")?.textContent).toContain(
      "OTHER — Other retained branch",
    );
    expect(card.closest("article")?.textContent).not.toContain("MAIN — Main");
    expect(card.closest("article")?.textContent).toContain("Inactive");
  });

  it.each(["OWNER", "ADMIN"] as const)(
    "shows %s invitation organization-wide scope",
    async (role) => {
      vi.mocked(fetchInvitations).mockResolvedValue({
        data: [{ ...invitation, intendedRole: role, branchScopes: [] }],
        meta: { nextCursor: null },
      });
      renderManagement();
      const card = await screen.findByRole("heading", {
        name: invitation.invitedEmail,
      });
      expect(card.closest("article")?.textContent).toContain(
        "Organization-wide scope",
      );
    },
  );

  it("shows backend forbidden feedback and permits retrying the invite", async () => {
    vi.mocked(createInvitation).mockRejectedValueOnce(
      new MembershipApiError("forbidden"),
    );
    renderManagement();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "retry@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You do not have permission",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(createInvitation).toHaveBeenCalledTimes(2));
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps invite scope controls disabled while creation is pending", async () => {
    const { promise, resolve } = Promise.withResolvers<typeof invitation>();
    vi.mocked(createInvitation).mockReturnValueOnce(promise);
    renderManagement();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "pending@example.com" },
    });
    const scope = (await screen.findAllByLabelText("MAIN — Main"))[0]!;
    fireEvent.click(scope);
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByRole("button", { name: "Sending…" });
    expect(scope.getAttribute("aria-disabled")).toBe("true");
    const form = screen.getByLabelText("Email").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createInvitation).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    resolve(invitation);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sending…" })).toBeNull(),
    );
  });

  it("localizes invite confirmation details into Thai", async () => {
    localStorage.setItem("stockwise.language", "th");
    renderManagement();
    await screen.findByRole("heading", { name: th.teamTitle });
    fireEvent.change(screen.getByLabelText(th.teamEmail), {
      target: { value: "thai@example.com" },
    });
    fireEvent.click((await screen.findAllByLabelText("MAIN — Main"))[0]!);
    fireEvent.click(screen.getByRole("button", { name: th.teamSend }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(window.confirm).mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("thai@example.com");
    expect(prompt).toContain(th.CASHIER);
    expect(prompt).toContain("MAIN — Main");
    expect(prompt).toContain("หากมีคำเชิญ");
    expect(prompt).toContain("ลิงก์เดิมจะใช้ไม่ได้");
  });

  it("keeps owner membership and owner invitations read-only for administrators", async () => {
    vi.mocked(fetchAccessContext).mockResolvedValue(context("ADMIN"));
    vi.mocked(fetchMemberships).mockResolvedValue({
      data: [{ ...membership, role: "OWNER", branchAssignments: [] }],
      meta: { nextCursor: null },
    });
    vi.mocked(fetchInvitations).mockResolvedValue({
      data: [{ ...invitation, intendedRole: "OWNER", branchScopes: [] }],
      meta: { nextCursor: null },
    });
    renderManagement();
    await screen.findByText("Only an owner may change owner access.");
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reissue" })).toBeNull();
    for (const select of screen.getAllByLabelText("Role"))
      expect(
        within(select).queryByRole("option", { name: "OWNER" }),
      ).toBeNull();
  });

  it("does not mutate when a consequential change is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    renderManagement();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Reissue" }));
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "ADMIN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    expect(revokeInvitation).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
    expect(deactivateMembership).not.toHaveBeenCalled();
    expect(replaceMembership).not.toHaveBeenCalled();
  });

  it("submits a confirmed full replacement with the original optimistic version", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "ADMIN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() =>
      expect(replaceMembership).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        MEMBER_ID,
        {
          branchIds: [],
          role: "ADMIN",
          expectedUpdatedAt: membership.updatedAt,
        },
      ),
    );
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["access-context"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["members", ORGANIZATION_ID],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["invitations", ORGANIZATION_ID],
    });
  });

  it("preserves a draft on background update and requires explicit reload before rebasing", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "ADMIN" },
    });
    const latest = {
      ...membership,
      role: "BRANCH_MANAGER" as const,
      updatedAt: "2026-08-24T13:00:00.000Z",
    };
    client.setQueryData(["members", ORGANIZATION_ID, false], {
      pages: [{ data: [latest], meta: { nextCursor: null } }],
      pageParams: [null],
    });
    await screen.findByRole("button", { name: "Reload latest access" });
    expect(
      (screen.getAllByLabelText("Role")[1] as HTMLSelectElement).value,
    ).toBe("ADMIN");
    expect(
      (
        screen.getByRole("button", { name: "Save access" }) as HTMLButtonElement
      ).matches(":disabled"),
    ).toBe(true);
    expect(replaceMembership).not.toHaveBeenCalled();
    vi.mocked(fetchMemberships).mockResolvedValue({
      data: [latest],
      meta: { nextCursor: null },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reload latest access" }),
    );
    await waitFor(() =>
      expect(
        (screen.getAllByLabelText("Role")[1] as HTMLSelectElement).value,
      ).toBe("BRANCH_MANAGER"),
    );
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "ADMIN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() =>
      expect(replaceMembership).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        MEMBER_ID,
        { branchIds: [], role: "ADMIN", expectedUpdatedAt: latest.updatedAt },
      ),
    );
  });

  it("blocks repeat stale writes and keeps last-owner rejection visible", async () => {
    vi.mocked(deactivateMembership).mockRejectedValueOnce(
      new MembershipApiError("stale"),
    );
    renderManagement();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await screen.findByRole("button", { name: "Reload latest access" });
    expect(
      (
        screen.getByRole("button", { name: "Deactivate" }) as HTMLButtonElement
      ).matches(":disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Reload latest access" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Reload latest access" }),
      ).toBeNull(),
    );
    vi.mocked(deactivateMembership).mockRejectedValueOnce(
      new MembershipApiError("last_active_owner"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await screen.findByRole("alert");
    expect(deactivateMembership).toHaveBeenCalledTimes(2);
  });

  it("reactivates inactive members only after confirming explicit desired access", async () => {
    vi.mocked(fetchMemberships).mockResolvedValue({
      data: [{ ...membership, status: "INACTIVE" }],
      meta: { nextCursor: null },
    });
    renderManagement();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Reactivate with this access",
      }),
    );
    await waitFor(() =>
      expect(reactivateMembership).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        MEMBER_ID,
        {
          branchIds: [BRANCH_ID],
          role: "CASHIER",
          expectedUpdatedAt: membership.updatedAt,
        },
      ),
    );
  });

  it("locks member mutations while a request is pending", async () => {
    const { promise, resolve: finish } =
      Promise.withResolvers<typeof membership>();
    vi.mocked(replaceMembership).mockReturnValueOnce(promise);
    renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "INVENTORY_STAFF" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByRole("button", { name: "Saving…" });
    expect(
      screen.getByRole("button", { name: "Deactivate" }).matches(":disabled"),
    ).toBe(true);
    expect(screen.getAllByLabelText("Role")[1]!.matches(":disabled")).toBe(
      true,
    );
    const card = screen
      .getByRole("heading", { name: "Cashier" })
      .closest("article")!;
    const scope = within(card).getByRole("checkbox");
    expect(scope.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(scope);
    expect(scope.getAttribute("aria-checked")).toBe("true");
    finish(membership);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull(),
    );
  });

  it("reissues using persisted invitation branches rather than workspace selection", async () => {
    const otherId = "20000000-0000-4000-8000-000000000002";
    vi.mocked(fetchInvitations).mockResolvedValue({
      data: [
        {
          ...invitation,
          branchScopes: [
            {
              ...invitation.branchScopes[0]!,
              id: otherId,
              code: "OTHER",
              name: "Other branch",
            },
          ],
        },
      ],
      meta: { nextCursor: null },
    });
    renderManagement();
    fireEvent.click(await screen.findByRole("button", { name: "Reissue" }));
    await waitFor(() =>
      expect(createInvitation).toHaveBeenCalledWith(ORGANIZATION_ID, {
        branchIds: [otherId],
        email: invitation.invitedEmail,
        role: "CASHIER",
      }),
    );
  });

  it("removes a privileged draft when actor or authority changes", async () => {
    const client = renderManagement();
    await screen.findByRole("button", { name: "Deactivate" });
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "ADMIN" },
    });
    client.setQueryData(["access-context"], {
      ...context(),
      user: { ...context().user, id: "60000000-0000-4000-8000-000000000002" },
    });
    await waitFor(() =>
      expect(
        (screen.getAllByLabelText("Role")[1] as HTMLSelectElement).value,
      ).toBe("CASHIER"),
    );
    fireEvent.change(screen.getAllByLabelText("Role")[1]!, {
      target: { value: "ADMIN" },
    });
    client.setQueryData(["access-context"], context("CASHIER"));
    await screen.findByRole("heading", {
      name: "Member management unavailable",
    });
    expect(screen.queryByLabelText("Role")).toBeNull();
    expect(replaceMembership).not.toHaveBeenCalled();
  });

  it("localizes interactive team controls into Thai", async () => {
    localStorage.setItem("stockwise.language", "th");
    renderManagement();
    await screen.findByRole("heading", { name: th.teamTitle });
    await screen.findByRole("heading", { name: "Cashier" });
    fireEvent.change(screen.getAllByLabelText(th.teamRole)[1]!, {
      target: { value: "ADMIN" },
    });
    fireEvent.click(screen.getByRole("button", { name: th.teamSave }));
    await waitFor(() =>
      expect(window.confirm).toHaveBeenCalledWith(th.teamConfirmSave),
    );
  });

  it("recovers from a failed list request without showing an empty-success state", async () => {
    vi.mocked(fetchMemberships).mockRejectedValueOnce(
      new MembershipApiError("unavailable"),
    );
    renderManagement();
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("could not be loaded");
    expect(screen.queryByText("No members match this view.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Cashier" });
  });
  it("does not carry an invitation draft across organizations for the same actor", async () => {
    const client = renderManagement();
    await screen.findByRole("heading", { name: "Cashier" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "private-draft@example.test" },
    });
    requestedOrganizationId = "10000000-0000-4000-8000-000000000002";
    const next = {
      ...context(),
      organizations: [
        ...context().organizations,
        {
          ...context().organizations[0]!,
          id: requestedOrganizationId,
          name: "Other Store",
        },
      ],
    };
    client.setQueryData(["access-context"], next);
    await waitFor(() =>
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    expect(createInvitation).not.toHaveBeenCalled();
  });
});
