// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "@/app/page";
import PricingPage from "@/app/pricing/page";
import { MarketingShell } from "./marketing-shell";
import { LanguageProvider } from "@/providers/language-provider";
import { PreferenceControls } from "@/components/preference-controls";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
vi.mock("next/navigation", () => ({ usePathname: () => "/pricing" }));
afterEach(cleanup);
beforeEach(() => localStorage.clear());
describe("public marketing", () => {
  it("uses real navigation and labels the illustrative product data", () => {
    render(
      <MarketingShell>
        <HomePage />
      </MarketingShell>,
    );
    const nav = within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    );
    for (const [name, href] of [
      ["Features", "/#features"],
      ["Pricing", "/pricing"],
      ["Sign in", "/login"],
      ["Get started", "/register"],
    ] as const) {
      expect(nav.getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
    expect(
      screen.getByRole("heading", { name: "Run your inventory with clarity." }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("heading", { name: "The essentials, connected." })
        .closest("section")?.id,
    ).toBe("features");
  });
  it("switches billing amounts without selecting a subscription or payment", () => {
    render(<PricingPage />);
    const plans = within(
      screen.getByRole("region", { name: "Proposed plans" }),
    );
    for (const [name, monthly, yearly, branches, users] of [
      ["Starter", "199", "1,990", "1 branch", "3 users"],
      ["Growth", "499", "4,990", "3 branches", "10 users"],
      ["Business", "999", "9,990", "10 branches", "30 users"],
    ] as const) {
      const card = within(
        plans.getByRole("heading", { name }).closest("article")!,
      );
      expect(card.getByText(`THB ${monthly}`, { exact: true })).toBeTruthy();
      expect(card.getByText(branches, { exact: true })).toBeTruthy();
      expect(card.getByText(users, { exact: true })).toBeTruthy();
      expect(card.getByRole("link").getAttribute("href")).toBe("/register");
      fireEvent.click(screen.getByRole("button", { name: "Yearly" }));
      expect(card.getByText(`THB ${yearly}`, { exact: true })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    }
    const enterprise = within(
      plans.getByRole("heading", { name: "Enterprise" }).closest("article")!,
    );
    expect(enterprise.queryByRole("link")).toBeNull();
    expect(enterprise.queryByRole("button")).toBeNull();
    expect(screen.getByText(/does not select a plan/)).toBeTruthy();
  });
  it("updates home and pricing in place while preserving the billing selection", () => {
    render(
      <LanguageProvider>
        <PreferenceControls />
        <HomePage />
        <PricingPage />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yearly" }));
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    expect(
      screen.getByRole("heading", { name: th.marketingHeroTitle }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: en.marketingHeroTitle }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: th.pricingTitle })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: th.pricingYearly })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("THB 1,990")).toBeTruthy();
    expect(localStorage.getItem("stockwise.language")).toBe("th");
    fireEvent.click(screen.getByRole("button", { name: "ภาษา" }));
    expect(
      screen.getByRole("heading", { name: en.marketingHeroTitle }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: en.pricingYearly })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("uses an accessible official Sheet and closes after navigation", async () => {
    render(
      <MarketingShell>
        <p>Public content</p>
      </MarketingShell>,
    );
    const trigger = screen.getByRole("button", { name: "Menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    const pricing = within(dialog).getByRole("link", { name: "Pricing" });
    expect(pricing.getAttribute("aria-current")).toBe("page");
    fireEvent.click(pricing);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});
