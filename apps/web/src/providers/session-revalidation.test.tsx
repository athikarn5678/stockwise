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
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import type { AccessContext } from "@/branch-api-client";
import { discardPrivateSession } from "@/session-lifecycle";
import { QueryProvider } from "./query-provider";
import {
  REVALIDATION_TIMEOUT_MS,
  UNCONFIRMED_HIDDEN_LIMIT_MS,
} from "./session-lifecycle-provider";

const replace = vi.fn();
let pathname = "/app";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace }),
}));

const ORG = "10000000-0000-4000-8000-000000000001";
const BRANCH = "20000000-0000-4000-8000-000000000001";
const BRANCH_B = "20000000-0000-4000-8000-000000000002";
const ACTOR_A = "30000000-0000-4000-8000-000000000001";
const ACTOR_B = "30000000-0000-4000-8000-000000000002";

interface Authority {
  userId: string;
  displayName: string;
  role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";
  branches: string[];
}
let authority: Authority;
const context = (): AccessContext => ({
  firstOrganizationOnboarding: { eligible: false },
  organizations: [
    {
      id: ORG,
      name: "Store A",
      role: authority.role,
      branches: authority.branches.map((id) => ({
        id,
        code: "MAIN",
        name: "Main",
      })),
    },
  ],
  user: {
    id: authority.userId,
    email: "private@example.test",
    displayName: authority.displayName,
  },
});
const response = (value = context()) =>
  new Response(JSON.stringify({ data: value }));
/** 0 simulates a network failure; 200 the same authority. */
let status = 200;
let client: QueryClient;
let clock = 0;

function advance(ms = 1_000) {
  clock += ms;
  vi.spyOn(performance, "now").mockReturnValue(clock);
}
function hide() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
function show() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
function blurToFocus() {
  act(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
}
function hint(id = "other-tab") {
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "stockwise.session-change",
        newValue: JSON.stringify({ version: 1, type: "session-change", id }),
      }),
    ),
  );
}
function PrivateForm() {
  client = useQueryClient();
  const [draft, setDraft] = useState("");
  return (
    <input
      aria-label="Private draft"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}
function mount() {
  return render(
    <QueryProvider>
      <AppShell>
        <PrivateForm />
      </AppShell>
    </QueryProvider>,
  );
}
async function draftAndHold() {
  mount();
  const field = (await screen.findByLabelText(
    "Private draft",
  )) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "unsent cart" } });
  client.setQueryData(["sales", "private"], "private receipt");
  return field;
}
const loadingAccess = () => screen.queryByText(/Loading access/);

beforeEach(() => {
  pathname = "/app";
  status = 200;
  replace.mockReset();
  authority = {
    userId: ACTOR_A,
    displayName: "Actor A",
    role: "OWNER",
    branches: [BRANCH],
  };
  clock = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(clock);
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
    vi.fn(async () => {
      if (status === 0) throw new Error("offline");
      return new Response(JSON.stringify({ data: context() }), { status });
    }),
  );
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the same draft node through hidden→visible and blur→focus with one request per burst", async () => {
  const field = await draftAndHold();
  expect(fetch).toHaveBeenCalledTimes(1);

  hide();
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(loadingAccess()).toBeNull();

  advance();
  show();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(loadingAccess()).toBeNull();

  // A blur → focus burst that overlaps the visible revalidation stays one request.
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  advance();
  act(() => {
    window.dispatchEvent(new Event("blur"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(loadingAccess()).toBeNull();
  await act(async () => pending.resolve(response()));
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
});

it("keeps the draft and refreshes presentation data when the authority is unchanged", async () => {
  const field = await draftAndHold();
  authority.displayName = "Renamed Actor";
  advance();
  show();
  await waitFor(() =>
    expect(
      client.getQueryData<AccessContext>(["access-context"])?.user.displayName,
    ).toBe("Renamed Actor"),
  );
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(client.getQueryData(["sales", "private"])).toBe("private receipt");
  expect(loadingAccess()).toBeNull();
});

it.each([
  [
    "the actor",
    () => {
      authority.userId = ACTOR_B;
    },
  ],
  [
    "the role",
    () => {
      authority.role = "CASHIER";
    },
  ],
  [
    "the branch scope",
    () => {
      authority.branches = [];
    },
  ],
  [
    "a reassigned branch",
    () => {
      authority.branches = [BRANCH_B];
    },
  ],
] as const)(
  "purges the draft and the cache when %s changed during a hidden→visible resume",
  async (_change, change) => {
    const field = await draftAndHold();
    change();
    advance();
    show();
    await waitFor(() =>
      expect(client.getQueryData(["sales", "private"])).toBeUndefined(),
    );
    await waitFor(() =>
      expect(client.getQueryData<AccessContext>(["access-context"])).toEqual(
        context(),
      ),
    );
    expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
    expect(screen.queryByLabelText("Private draft")).not.toBe(field);
  },
);

it("resets and redirects to /login when revalidation returns 401", async () => {
  await draftAndHold();
  status = 401;
  advance();
  show();
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
});

it("resets without a sign-out redirect when revalidation returns 403", async () => {
  await draftAndHold();
  status = 403;
  advance();
  show();
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(replace).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
});

it("keeps the draft through a 503 and retries on the next resume", async () => {
  const field = await draftAndHold();
  status = 503;
  advance();
  show();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(loadingAccess()).toBeNull();
  expect(replace).not.toHaveBeenCalled();
  status = 200;
  advance();
  blurToFocus();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(client.getQueryData(["sales", "private"])).toBe("private receipt");
});

it("keeps the draft through a network error and retries on the online event", async () => {
  const field = await draftAndHold();
  status = 0;
  advance();
  show();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  status = 200;
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(client.getQueryData<AccessContext>(["access-context"])).toEqual(
    context(),
  );
});

it("fails closed when the unconfirmed absence exceeds the limit and revalidation still fails", async () => {
  const dateSpy = vi.spyOn(Date, "now");
  const base = Date.now();
  dateSpy.mockReturnValue(base);
  const field = await draftAndHold();
  status = 503;
  advance();
  hide();
  show();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");

  dateSpy.mockReturnValue(base + UNCONFIRMED_HIDDEN_LIMIT_MS + 1);
  advance();
  blurToFocus();
  await waitFor(() =>
    expect(screen.queryByDisplayValue("unsent cart")).toBeNull(),
  );
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
  expect(replace).not.toHaveBeenCalled();
});

it("purges immediately when a valid session-change hint arrives while hidden", async () => {
  await draftAndHold();
  hide();
  hint("hidden-tab-logout");
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
  expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
});

it("ignores malformed session-change hints", async () => {
  const field = await draftAndHold();
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "stockwise.session-change",
        newValue: JSON.stringify({
          version: 1,
          type: "session-change",
          id: "untrusted",
          actor: "forged",
        }),
      }),
    ),
  );
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(["sales", "private"])).toBe("private receipt");
});

it("ignores a revalidation response that arrives after a reset", async () => {
  const field = await draftAndHold();
  const previousActor = response();
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  advance();
  show();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  authority.userId = ACTOR_B;
  authority.displayName = "Actor B";
  hint("actor-switch");
  await waitFor(() =>
    expect(
      client.getQueryData<AccessContext>(["access-context"])?.user.id,
    ).toBe(ACTOR_B),
  );
  expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
  await act(async () => pending.resolve(previousActor));
  expect(client.getQueryData<AccessContext>(["access-context"])?.user.id).toBe(
    ACTOR_B,
  );
  expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
  expect(screen.queryByLabelText("Private draft")).not.toBe(field);
});

it("still removes the tree on pagehide and fully resets on persisted pageshow", async () => {
  await draftAndHold();
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  expect(loadingAccess()).toBeTruthy();
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
  advance();
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  const restored = (await screen.findByLabelText(
    "Private draft",
  )) as HTMLInputElement;
  expect(restored.value).toBe("");
});

it("makes no access-context request on marketing lifecycle transitions", async () => {
  pathname = "/";
  mount();
  advance();
  blurToFocus();
  advance();
  hide();
  show();
  advance();
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
});

/** A request that only ends when its signal aborts, like a stalled network. */
function hangingFetch() {
  vi.mocked(fetch).mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
}
const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it("bounds a hung revalidation, releases the guard, retries on the next resume and fails closed after the limit", async () => {
  const field = await draftAndHold();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  hangingFetch();
  advance();
  hide();
  show();
  expect(fetch).toHaveBeenCalledTimes(2);
  // The guard is held while the request is in flight: no second request.
  advance();
  blurToFocus();
  expect(fetch).toHaveBeenCalledTimes(2);

  await elapse(REVALIDATION_TIMEOUT_MS);
  // Timeout = unconfirmed: the short absence keeps the screen.
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(loadingAccess()).toBeNull();
  expect(replace).not.toHaveBeenCalled();

  // The guard was released, so the next resume starts a new check.
  advance();
  blurToFocus();
  expect(fetch).toHaveBeenCalledTimes(3);
  await elapse(REVALIDATION_TIMEOUT_MS);
  expect(screen.getByLabelText("Private draft")).toBe(field);

  // After more than the limit away, an unconfirmed result resets.
  await elapse(UNCONFIRMED_HIDDEN_LIMIT_MS);
  advance();
  blurToFocus();
  expect(fetch).toHaveBeenCalledTimes(4);
  await elapse(REVALIDATION_TIMEOUT_MS);
  expect(screen.queryByDisplayValue("unsent cart")).toBeNull();
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
  expect(replace).not.toHaveBeenCalled();
});

it("does not treat a session-discard abort of an in-flight revalidation as unconfirmed", async () => {
  const field = await draftAndHold();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  hangingFetch();
  advance();
  // leftAt is recorded, so an unconfirmed result would be judged by the limit.
  hide();
  show();
  expect(fetch).toHaveBeenCalledTimes(2);
  // The absence now exceeds the limit without firing the request timeout.
  vi.setSystemTime(Date.now() + UNCONFIRMED_HIDDEN_LIMIT_MS + 1_000);
  // Discard the private session without a lifecycle reset (no epoch change),
  // exactly what an actor reconciliation does. The aborted request must be
  // dropped, not treated as "cannot confirm" (which would now fail closed).
  act(() => discardPrivateSession(client));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);
  expect(field.value).toBe("unsent cart");
  expect(loadingAccess()).toBeNull();
  expect(replace).not.toHaveBeenCalled();
});

it("fails closed when the clock moved backwards while the authority cannot be confirmed", async () => {
  const dateSpy = vi.spyOn(Date, "now");
  const base = Date.now();
  dateSpy.mockReturnValue(base);
  const field = await draftAndHold();
  status = 503;
  advance();
  hide();
  show();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.getByLabelText("Private draft")).toBe(field);

  // The system clock is set back past the moment the window was left.
  dateSpy.mockReturnValue(base - 60_000);
  advance();
  blurToFocus();
  await waitFor(() =>
    expect(screen.queryByDisplayValue("unsent cart")).toBeNull(),
  );
  expect(client.getQueryData(["sales", "private"])).toBeUndefined();
});
