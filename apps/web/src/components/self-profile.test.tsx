// @vitest-environment jsdom

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/providers/language-provider";
import {
  ProfileApiError,
  fetchSelfProfile,
  updateSelfProfile,
} from "@/profile-api-client";
import { SelfProfile } from "./self-profile";

vi.mock("@/profile-api-client", () => ({
  ProfileApiError: class ProfileApiError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  },
  fetchSelfProfile: vi.fn(),
  updateSelfProfile: vi.fn(),
}));

const profile = {
  id: "30000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
  displayName: "Owner",
  phone: null,
  updatedAt: "2026-10-25T10:20:30.123Z",
};

function AccessContextObserver() {
  useQuery({
    queryKey: ["access-context"],
    queryFn: () => new Promise(() => {}),
    retry: false,
    staleTime: Infinity,
  });
  return null;
}
function renderProfile() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <SelfProfile />
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("self profile", () => {
  it("loads read-only account email and keeps edits until cancelled", async () => {
    vi.mocked(fetchSelfProfile).mockResolvedValue(profile);
    renderProfile();
    const name = await screen.findByLabelText("Display name");
    expect(screen.getByLabelText("Email address")).toHaveProperty(
      "readOnly",
      true,
    );
    fireEvent.change(name, { target: { value: "  New Name " } });
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(name).toHaveProperty("value", "Owner");
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("saves a trimmed profile while shared access context refreshes in the background", async () => {
    vi.mocked(fetchSelfProfile).mockResolvedValue(profile);
    const updated = {
      ...profile,
      displayName: "New Name",
      updatedAt: "2026-10-25T10:20:31.123Z",
    };
    vi.mocked(updateSelfProfile).mockResolvedValue(updated);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["access-context"], {
      user: { id: profile.id, email: profile.email, displayName: "Owner" },
      organizations: [],
      firstOrganizationOnboarding: { eligible: false },
    });
    render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <AccessContextObserver />
          <SelfProfile />
        </LanguageProvider>
      </QueryClientProvider>,
    );
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: " New Name " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Your profile has been saved.");
    expect(updateSelfProfile).toHaveBeenCalledWith({
      displayName: "New Name",
      phone: "",
      expectedUpdatedAt: profile.updatedAt,
    });
    await waitFor(() =>
      expect(client.getQueryState(["access-context"])?.fetchStatus).toBe(
        "fetching",
      ),
    );
    expect(client.getQueryData(["access-context"])).toMatchObject({
      user: { displayName: "New Name" },
    });
  });

  it("preserves a dirty draft's base version across profile refetch and handles stale saves", async () => {
    vi.mocked(fetchSelfProfile).mockResolvedValue(profile);
    vi.mocked(updateSelfProfile).mockRejectedValue(
      new ProfileApiError("stale"),
    );
    const client = renderProfile();
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "Changed" } });
    client.setQueryData(["self-profile"], {
      ...profile,
      displayName: "Changed elsewhere",
      updatedAt: "2026-10-25T10:25:30.123Z",
    });
    expect(name).toHaveProperty("value", "Changed");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        "Your profile changed elsewhere. Reload it before saving again.",
      ),
    ).toBeTruthy();
    expect(updateSelfProfile).toHaveBeenCalledWith({
      displayName: "Changed",
      phone: "",
      expectedUpdatedAt: profile.updatedAt,
    });
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Enter a display name/)).toBeTruthy();
    expect(updateSelfProfile).toHaveBeenCalledTimes(1);
  });

  it("recovers from a failed profile load through retry", async () => {
    vi.mocked(fetchSelfProfile)
      .mockRejectedValueOnce(new ProfileApiError("unavailable"))
      .mockResolvedValue(profile);
    renderProfile();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Display name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Display name")).toHaveProperty(
      "value",
      "Owner",
    );
  });

  it("keeps the draft after a save failure and permits retry", async () => {
    vi.mocked(fetchSelfProfile).mockResolvedValue(profile);
    vi.mocked(updateSelfProfile)
      .mockRejectedValueOnce(new ProfileApiError("unavailable"))
      .mockResolvedValue({ ...profile, displayName: "Retry draft" });
    renderProfile();
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "Retry draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    expect(name).toHaveProperty("value", "Retry draft");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("status");
    expect(name).toHaveProperty("value", "Retry draft");
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("warns before leaving while edits are unsaved", async () => {
    vi.mocked(fetchSelfProfile).mockResolvedValue(profile);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderProfile();
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "Changed" } });
    const link = document.createElement("a");
    link.href = "/app";
    document.body.append(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(confirm).toHaveBeenCalledWith(
      "You have unsaved changes. Leave this page?",
    );
    expect(event.defaultPrevented).toBe(true);
    link.remove();
  });
});
