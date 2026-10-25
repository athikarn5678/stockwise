// @vitest-environment jsdom
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { SelfProfile } from "@/components/self-profile";
import { QueryProvider } from "./query-provider";
import { createAccountDraftStore } from "./account-draft";
import type { AccessContext } from "@/branch-api-client";

const replace = vi.fn();
let pathname = "/app/profile";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace }),
}));
const actorA = "30000000-0000-4000-8000-000000000001";
const actorB = "30000000-0000-4000-8000-000000000002";
let actor = actorA;
let denied = false;
const context = (id = actor): AccessContext => ({
  user: { id, email: "synthetic@example.test", displayName: "Saved name" },
  organizations: [],
  firstOrganizationOnboarding: { eligible: false },
});
const profile = () => ({
  id: actor,
  email: "synthetic@example.test",
  displayName: actor === actorA ? "Saved name" : "Other account",
  phone: null,
  updatedAt: "2026-10-25T01:00:00.000Z",
});
beforeEach(() => {
  actor = actorA;
  denied = false;
  pathname = "/app/profile";
  replace.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify({
            data: path.endsWith("access-context") ? context() : profile(),
            meta: { requestId: "synthetic-test" },
          }),
          { status: denied ? 401 : 200 },
        ),
    ),
  );
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
let accountClient: QueryClient;
function CaptureAccountClient() {
  accountClient = useQueryClient();
  return null;
}
function mount() {
  return render(
    <QueryProvider>
      <CaptureAccountClient />
      <AppShell>
        <SelfProfile />
      </AppShell>
    </QueryProvider>,
  );
}
async function draft() {
  mount();
  fireEvent.change(await screen.findByLabelText("Display name"), {
    target: { value: "Unsaved private name" },
  });
  await screen.findByText("You have unsaved changes.");
}
function resume() {
  act(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
}
it("restores a dirty profile and original version only after fresh same-actor focus revalidation", async () => {
  await draft();
  resume();
  expect(await screen.findByLabelText("Display name")).toHaveProperty(
    "value",
    "Unsaved private name",
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some((call) => {
        const init = call[1];
        return (
          init?.method === "PATCH" &&
          JSON.parse(String(init.body)).expectedUpdatedAt ===
            "2026-10-25T01:00:00.000Z"
        );
      }),
    ).toBe(true),
  );
});
it("hides private content while invisible and restores the draft only after visible revalidation", async () => {
  await draft();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.queryByLabelText("Display name")).toBeNull();
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(await screen.findByLabelText("Display name")).toHaveProperty(
    "value",
    "Unsaved private name",
  );
});
it("discards the old draft when fresh authentication belongs to another actor", async () => {
  await draft();
  actor = actorB;
  resume();
  expect(await screen.findByLabelText("Display name")).toHaveProperty(
    "value",
    "Other account",
  );
});
it.each(["stockwise:session-change", "stockwise:session-unauthorized"])(
  "clears drafts on %s before any later login",
  async (event) => {
    await draft();
    act(() => window.dispatchEvent(new Event(event)));
    if (event.endsWith("unauthorized")) {
      expect(screen.queryByLabelText("Display name")).toBeNull();
      act(() => window.dispatchEvent(new Event("stockwise:session-change")));
    }
    expect(await screen.findByLabelText("Display name")).toHaveProperty(
      "value",
      "Saved name",
    );
  },
);
it("fails closed on actual session revocation and cannot restore the draft after recovery", async () => {
  await draft();
  denied = true;
  resume();
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByLabelText("Display name")).toBeNull();
  denied = false;
  resume();
  expect(await screen.findByLabelText("Display name")).toHaveProperty(
    "value",
    "Saved name",
  );
});
it("discards a handoff on revoked membership, role change or changed branch scope", () => {
  const store = createAccountDraftStore();
  const initial: AccessContext = {
    ...context(),
    organizations: [
      {
        id: actorA,
        name: "Store",
        role: "OWNER",
        branches: [{ id: actorB, name: "Main", code: "MAIN" }],
      },
    ],
  };
  const value = {
    name: "Draft",
    savedName: "Store",
    baseUpdatedAt: "2026-10-25T01:00:00.000Z",
  };
  for (const fresh of [
    context(),
    {
      ...initial,
      organizations: [
        { ...initial.organizations[0]!, role: "CASHIER" as const },
      ],
    },
    {
      ...initial,
      organizations: [{ ...initial.organizations[0]!, branches: [] }],
    },
  ]) {
    store.write("organization:test", initial, value);
    store.reconcile(fresh);
    expect(store.read("organization:test", initial)).toBeNull();
  }
});

it("keeps same-actor drafts and private data during an ordinary background context refetch", async () => {
  await draft();
  accountClient.setQueryData(["sales", "same-actor"], {
    receipt: "Current actor",
  });
  vi.mocked(fetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify({
          data: String(path).endsWith("/access-context")
            ? {
                ...context(),
                user: {
                  ...context().user,
                  displayName: "Fresh same actor navigation",
                },
              }
            : profile(),
          meta: { requestId: "same-actor-refresh" },
        }),
      ),
  );
  await act(async () => {
    await accountClient.refetchQueries({ queryKey: ["access-context"] });
  });
  await screen.findByText("Fresh same actor navigation");
  expect(screen.getByLabelText("Display name")).toHaveProperty(
    "value",
    "Unsaved private name",
  );
  expect(accountClient.getQueryData(["sales", "same-actor"])).toEqual({
    receipt: "Current actor",
  });
});

it("ACCOUNT-F1 clears actor A caches and fences a delayed save before mounting actor B", async () => {
  const pendingSave = Promise.withResolvers<Response>();
  const pendingBProfile = Promise.withResolvers<Response>();
  const a = {
    ...profile(),
    displayName: "Private Actor A",
    email: "actor-a@example.test",
    phone: "+66 111 1111",
  };
  const b = {
    ...a,
    id: actorB,
    displayName: "Private Actor B",
    email: "actor-b@example.test",
    phone: "+66 222 2222",
  };
  let current = a;
  let saveStarted = false;
  let bProfileStarted = false;
  const envelope = (data: unknown) =>
    new Response(JSON.stringify({ data, meta: { requestId: "account-f1" } }));
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith("/access-context"))
      return envelope({
        ...context(current.id),
        user: {
          id: current.id,
          email: current.email,
          displayName: current.displayName,
        },
      });
    if (init?.method === "PATCH") {
      saveStarted = true;
      return pendingSave.promise;
    }
    if (current.id === actorB) {
      bProfileStarted = true;
      return pendingBProfile.promise;
    }
    return envelope(a);
  });
  mount();
  expect(await screen.findByLabelText("Email address")).toHaveProperty(
    "value",
    a.email,
  );
  accountClient.setQueryData(["sales", "actor-a"], {
    privateReceipt: "Actor A receipt",
  });
  await accountClient
    .getMutationCache()
    .build(accountClient, {
      mutationFn: async () => ({ privateMutation: "Actor A private mutation" }),
    })
    .execute(undefined);
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Actor A pending save" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saveStarted).toBe(true));

  current = b;
  await act(async () => {
    await accountClient.refetchQueries({ queryKey: ["access-context"] });
  });
  await waitFor(() => expect(bProfileStarted).toBe(true));
  expect(screen.queryByLabelText("Email address")).toBeNull();
  expect(screen.queryByLabelText("Display name")).toBeNull();
  expect.soft(screen.queryByDisplayValue(a.email)).toBeNull();
  expect.soft(screen.queryByDisplayValue(a.phone)).toBeNull();
  expect.soft(screen.queryByDisplayValue(a.displayName)).toBeNull();
  expect.soft(accountClient.getQueryData(["sales", "actor-a"])).toBeUndefined();
  expect.soft(accountClient.getMutationCache().getAll()).toEqual([]);

  await act(async () => {
    pendingSave.resolve(
      envelope({ ...a, displayName: "Actor A pending save" }),
    );
  });
  expect.soft(accountClient.getQueryData(["self-profile"])).toBeUndefined();
  expect(screen.queryByLabelText("Email address")).toBeNull();
  expect.soft(screen.queryByDisplayValue(a.email)).toBeNull();
  expect.soft(screen.queryByDisplayValue("Actor A pending save")).toBeNull();
  expect
    .soft(accountClient.getQueryData<AccessContext>(["access-context"])?.user)
    .toEqual({
      id: b.id,
      email: b.email,
      displayName: b.displayName,
    });
  await act(async () => pendingBProfile.resolve(envelope(b)));
  expect(await screen.findByLabelText("Email address")).toHaveProperty(
    "value",
    b.email,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Display name")).toHaveProperty(
      "value",
      b.displayName,
    ),
  );
  expect(screen.getByLabelText("Phone number (optional)")).toHaveProperty(
    "value",
    b.phone,
  );
  expect(accountClient.getQueryData(["self-profile"])).toEqual(b);
});
