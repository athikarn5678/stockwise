// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OptionSelect, type OptionSelectOption } from "./option-select";
import { Label } from "./ui/label";
import {
  chooseOption,
  chooseOptionByValue,
  expectSelectValue,
} from "@/test/select-helpers";

const branches = [
  { label: "A — Alpha", value: "branch-a" },
  { label: "B — Beta", value: "branch-b" },
] as const;

const filters = [
  { label: "All products", value: "" },
  { label: "Active products", value: "ACTIVE" },
] as const;

afterEach(cleanup);

function Controlled({
  initialValue,
  name,
  options = branches,
}: {
  initialValue: string;
  name?: string | undefined;
  options?: ReadonlyArray<OptionSelectOption>;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <form aria-label="Filter form">
      <Label htmlFor="branch">Branch</Label>
      <OptionSelect
        id="branch"
        name={name}
        onValueChange={setValue}
        options={options}
        value={value}
      />
    </form>
  );
}

describe("OptionSelect", () => {
  it("associates an explicit label with the trigger", () => {
    render(<Controlled initialValue="branch-a" />);

    const trigger = screen.getByRole("combobox");
    expect(screen.getByLabelText("Branch")).toBe(trigger);
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("is reachable through a wrapping label", () => {
    render(
      <Label>
        Product status
        <OptionSelect
          onValueChange={() => {}}
          options={filters}
          value="ACTIVE"
        />
      </Label>,
    );

    expect(screen.getByLabelText("Product status").textContent).toContain(
      "Active products",
    );
  });

  it("shows the option label rather than the raw value", () => {
    render(<Controlled initialValue="branch-b" />);

    expectSelectValue(screen.getByRole("combobox"), "B — Beta");
  });

  it("reports the chosen value and keeps showing its label", async () => {
    const onValueChange = vi.fn();
    function Tracked() {
      const [value, setValue] = useState("branch-a");
      return (
        <>
          <Label htmlFor="branch">Branch</Label>
          <OptionSelect
            id="branch"
            onValueChange={(next) => {
              onValueChange(next);
              setValue(next);
            }}
            options={branches}
            value={value}
          />
        </>
      );
    }
    render(<Tracked />);

    await chooseOption(screen.getByLabelText("Branch"), "B — Beta");

    expect(onValueChange).toHaveBeenCalledWith("branch-b");
    expectSelectValue(screen.getByLabelText("Branch"), "B — Beta");
  });

  it("treats an empty string as an ordinary option value", async () => {
    const onValueChange = vi.fn();
    function Tracked() {
      const [value, setValue] = useState("ACTIVE");
      return (
        <OptionSelect
          id="status"
          name="status"
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
          options={filters}
          value={value}
        />
      );
    }
    render(
      <form aria-label="Filter form">
        <Label htmlFor="status">Status</Label>
        <Tracked />
      </form>,
    );

    await chooseOptionByValue(screen.getByLabelText("Status"), "");

    expect(onValueChange).toHaveBeenCalledWith("");
    expectSelectValue(screen.getByLabelText("Status"), "All products");
    const form = screen.getByRole("form", { name: "Filter form" });
    expect(new FormData(form as HTMLFormElement).get("status")).toBe("");
  });

  it("submits the selected value through the hidden named input", async () => {
    render(<Controlled initialValue="branch-a" name="branch" />);

    const form = screen.getByRole("form", { name: "Filter form" });
    expect(new FormData(form as HTMLFormElement).get("branch")).toBe(
      "branch-a",
    );

    await chooseOptionByValue(screen.getByLabelText("Branch"), "branch-b");

    expect(new FormData(form as HTMLFormElement).get("branch")).toBe(
      "branch-b",
    );
  });

  it("renders an unmatched value blank and falls back to the placeholder", () => {
    const { unmount } = render(<Controlled initialValue="unknown" />);
    expect(screen.getByLabelText("Branch").textContent).toBe("");
    unmount();

    render(
      <>
        <Label htmlFor="branch">Branch</Label>
        <OptionSelect
          id="branch"
          onValueChange={() => {}}
          options={branches}
          placeholder="Pick a branch"
          value="unknown"
        />
      </>,
    );
    expectSelectValue(screen.getByLabelText("Branch"), "Pick a branch");
  });

  it("does not open while disabled", async () => {
    render(
      <>
        <Label htmlFor="branch">Branch</Label>
        <OptionSelect
          disabled
          id="branch"
          onValueChange={() => {}}
          options={branches}
          value="branch-a"
        />
      </>,
    );

    const trigger = screen.getByLabelText("Branch");
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
