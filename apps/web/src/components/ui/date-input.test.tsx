// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "@/providers/language-provider";

import { DateInput, formatIsoDate, parseIsoDate } from "./date-input";

describe("calendar date handling", () => {
  it("round-trips ISO dates without timezone shifts", () => {
    for (const value of [
      "2026-01-01",
      "2026-03-29",
      "2026-10-25",
      "2028-02-29",
    ]) {
      const date = parseIsoDate(value);
      expect(date).toBeDefined();
      expect(formatIsoDate(date!)).toBe(value);
    }
  });

  it("rejects impossible or malformed dates", () => {
    for (const value of [
      "",
      "2026-02-30",
      "2026-13-01",
      "26-01-01",
      "2026/01/01",
    ]) {
      expect(parseIsoDate(value)).toBeUndefined();
    }
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Harness({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <label>
      Order date
      <DateInput
        onChange={(event) => setValue(event.target.value)}
        value={value}
      />
    </label>
  );
}

describe("DateInput", () => {
  it.each(["en", "th"] as const)(
    "selects an ISO date and preserves calendar keyboard focus in %s",
    async (language) => {
      localStorage.setItem("stockwise.language", language);
      render(
        <LanguageProvider>
          <Harness initialValue="2026-10-15" />
        </LanguageProvider>,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: language === "th" ? "เลือกวันที่" : "Choose date",
        }),
      );
      const grid = await screen.findByRole("grid");
      expect(
        screen.getByRole("button", {
          name: language === "th" ? "เดือนถัดไป" : "Next month",
        }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: language === "th" ? "เดือนก่อนหน้า" : "Previous month",
        }),
      ).toBeTruthy();
      expect(grid.getAttribute("aria-label")).toContain(
        language === "th" ? "ตุลาคม" : "October",
      );
      await waitFor(() =>
        expect(document.activeElement?.textContent).toBe("15"),
      );
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
      await waitFor(() =>
        expect(document.activeElement?.textContent).toBe("16"),
      );
      fireEvent.click(document.activeElement!);
      expect(
        (screen.getByLabelText("Order date") as HTMLInputElement).value,
      ).toBe("2026-10-16");
      await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
    },
  );

  it("keeps a disabled date field and calendar trigger unavailable", () => {
    render(
      <DateInput aria-label="Disabled date" disabled value="2026-10-15" />,
    );
    expect(
      (screen.getByLabelText("Disabled date") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Choose date" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("accepts typed ISO text, flags invalid text and offers a calendar button", () => {
    render(<Harness />);
    const field = screen.getByLabelText("Order date") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2026-10-15" } });
    expect(field.value).toBe("2026-10-15");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(field, { target: { value: "2026-02-30" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "Choose date" })).toBeTruthy();
  });
});
