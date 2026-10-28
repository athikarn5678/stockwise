// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
import { LanguageProvider, useLanguage } from "@/providers/language-provider";
import { LocalizedLoading } from "./localized-loading";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function SwitchLanguage() {
  const { setLanguage } = useLanguage();
  return <button onClick={() => setLanguage("th")}>Thai</button>;
}

it("uses the saved language for loading feedback and follows language changes", () => {
  localStorage.setItem("stockwise.language", "en");
  const mount = () =>
    render(
      <LanguageProvider>
        <SwitchLanguage />
        <LocalizedLoading messageKey="uiLoadingPointOfSale" />
      </LanguageProvider>,
    );
  mount();
  expect(screen.getByText(en.uiLoadingPointOfSale)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Thai" }));
  expect(screen.getByText(th.uiLoadingPointOfSale)).toBeTruthy();
  cleanup();
  mount();
  expect(screen.getByText(th.uiLoadingPointOfSale)).toBeTruthy();
  expect(document.documentElement.lang).toBe("th");
});
