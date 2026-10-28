// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

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

function Harness() {
  const [value, setValue] = useState("");
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
