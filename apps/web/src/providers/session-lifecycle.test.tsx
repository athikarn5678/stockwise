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
import { QueryProvider } from "./query-provider";

const replace = vi.fn();
let pathname = "/app";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace }),
}));
const context = (name = "Actor A") => ({
  firstOrganizationOnboarding: { eligible: false },
  organizations: [],
  user: {
    displayName: name,
    email: "private@example.test",
    id: "30000000-0000-4000-8000-000000000001",
  },
});
const response = (name = "Actor A") =>
  new Response(JSON.stringify({ data: context(name) }));
let client: QueryClient;
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
beforeEach(() => {
  pathname = "/app";
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
    vi.fn(async () => response()),
  );
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("removes private query and mutation data and resets drafts before pageshow revalidation", async () => {
  mount();
  fireEvent.change(await screen.findByLabelText("Private draft"), {
    target: { value: "private cart" },
  });
  client.setQueryData(["members", "private"], {
    email: "private@example.test",
  });
  await client
    .getMutationCache()
    .build(client, { mutationFn: async () => "private sale" })
    .execute(undefined);
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  expect(client.getQueryData(["members", "private"])).toBeUndefined();
  expect(client.getMutationCache().getAll()).toEqual([]);
  pending.resolve(response("Actor B"));
  expect(
    ((await screen.findByLabelText("Private draft")) as HTMLInputElement).value,
  ).toBe("");
  expect(client.getQueryData(["access-context"])).toEqual(context("Actor B"));
});
it("hides a private form on pagehide until restored session validation", async () => {
  mount();
  await screen.findByLabelText("Private draft");
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByLabelText("Private draft")).toBeNull();
});
it("treats another tab notification as a hint, clears private data and revalidates instead of granting authority", async () => {
  mount();
  await screen.findByLabelText("Private draft");
  client.setQueryData(["sales"], "private receipt");
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "stockwise.session-change",
        newValue: JSON.stringify({
          version: 1,
          type: "session-change",
          id: "other-tab-1",
        }),
      }),
    ),
  );
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(client.getQueryData(["sales"])).toBeUndefined();
  expect(screen.queryByLabelText("Private draft")).toBeNull();
});
it.each([403, 503, "network"])(
  "fails closed without sign-out redirect on %s",
  async (status) => {
    if (status === "network")
      vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    else
      vi.mocked(fetch).mockResolvedValue(
        new Response("{}", { status: Number(status) }),
      );
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Private draft")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  },
);
it("redirects protected 401 once without mounting private content", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));
  mount();
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  expect(replace).toHaveBeenCalledTimes(1);
});
it("coalesces visibility, pageshow and focus into one revalidation", async () => {
  mount();
  await screen.findByLabelText("Private draft");
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValue(pending.promise);
  act(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  pending.resolve(response());
  await screen.findByLabelText("Private draft");
});
it("only ever probes the access context on marketing, including after lifecycle notifications", async () => {
  pathname = "/";
  mount();
  // The public header decides guest vs signed-in from the access context.
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  act(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    window.dispatchEvent(new Event("focus"));
  });
  for (const [url] of vi.mocked(fetch).mock.calls)
    expect(String(url)).toBe("/api/v1/me/access-context");
});
it("ignores a superseded access request when a second tab changes actor during reconciliation", async () => {
  mount();
  await screen.findByLabelText("Private draft");
  const old = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(old.promise);
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  vi.mocked(fetch).mockResolvedValueOnce(response("Actor B"));
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "stockwise.session-change",
        newValue: JSON.stringify({
          version: 1,
          type: "session-change",
          id: "actor-switch",
        }),
      }),
    ),
  );
  await screen.findByLabelText("Private draft");
  await act(async () => old.resolve(response("Old actor")));
  expect(client.getQueryData(["access-context"])).toEqual(context("Actor B"));
});
it("keeps a hidden private document mounted and revalidates on return", async () => {
  mount();
  fireEvent.change(await screen.findByLabelText("Private draft"), {
    target: { value: "unsent cart" },
  });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(
    (screen.getByLabelText("Private draft") as HTMLInputElement).value,
  ).toBe("unsent cart");
  expect(fetch).toHaveBeenCalledTimes(1);
  // Simulate a later return so the burst coalescing window does not apply.
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 1000);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    (screen.getByLabelText("Private draft") as HTMLInputElement).value,
  ).toBe("unsent cart");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "stockwise.session-change",
        newValue: JSON.stringify({
          version: 1,
          type: "session-change",
          id: "hidden-tab",
        }),
      }),
    ),
  );
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);
  pending.resolve(response());
  vi.restoreAllMocks();
});
it("ignores malformed notifications without resetting an active private draft", async () => {
  mount();
  fireEvent.change(await screen.findByLabelText("Private draft"), {
    target: { value: "private draft" },
  });
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
  expect(
    (screen.getByLabelText("Private draft") as HTMLInputElement).value,
  ).toBe("private draft");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not retry an initial failed access-context probe merely from initial focus", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 503 }));
  mount();
  await screen.findByRole("alert");
  act(() => window.dispatchEvent(new Event("focus")));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("reconciles after a real blur-to-focus actor switch even when the old access query is still pending", async () => {
  mount();
  await screen.findByLabelText("Private draft");
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockReturnValueOnce(pending.promise);
  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  vi.mocked(fetch).mockResolvedValueOnce(response("Actor B"));
  act(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(client.getQueryData(["access-context"])).toEqual(context("Actor B")),
  );
  await act(async () => pending.resolve(response("Actor A")));
  expect(client.getQueryData(["access-context"])).toEqual(context("Actor B"));
});
