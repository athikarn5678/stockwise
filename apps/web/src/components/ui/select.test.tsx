// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Label } from "./label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

const fruits = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
] as const;

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

beforeEach(() => {
  // jsdom implements no layout, so Base UI's scroll-into-view helper needs a stub.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  if (originalScrollIntoView) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

function BasicSelect({
  disabled = false,
  onValueChange,
  defaultValue = "apple",
  value,
}: {
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  defaultValue?: string;
  value?: string;
}) {
  return (
    <form aria-label="Fruit form">
      <Label htmlFor="fruit">Fruit</Label>
      <Select
        id="fruit"
        name="fruit"
        items={fruits}
        defaultValue={value === undefined ? defaultValue : undefined}
        value={value}
        onValueChange={(next) => onValueChange?.(next as string)}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Pick a fruit" />
        </SelectTrigger>
        <SelectContent>
          {fruits.map((fruit) => (
            <SelectItem key={fruit.value} value={fruit.value}>
              {fruit.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </form>
  );
}

describe("Select", () => {
  it("associates the label with the trigger", () => {
    render(<BasicSelect />);

    const trigger = screen.getByRole("combobox");
    expect(screen.getByLabelText("Fruit")).toBe(trigger);
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("renders the selected item's label before the popup ever opens", () => {
    render(<BasicSelect />);

    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("Apple");
    expect(trigger.textContent).not.toContain("apple");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens the popup and selects an item with a click", async () => {
    const onValueChange = vi.fn();
    render(<BasicSelect onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeDefined();

    const option = screen.getByRole("option", { name: "Banana" });
    // Base UI arms pointer selection on pointerdown; jsdom's `click` alone is
    // treated as a stale mouse click and ignored.
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);

    await waitFor(() => {
      expect(screen.getByRole("combobox").textContent).toContain("Banana");
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls[0]?.[0]).toBe("banana");
  });

  it("highlights the matching option when typing a letter (typeahead)", async () => {
    render(<BasicSelect />);

    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const listbox = await screen.findByRole("listbox");
    await waitFor(() => {
      expect(listbox.querySelector("[data-highlighted]")).not.toBeNull();
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "c" });

    await waitFor(() => {
      expect(
        listbox.querySelector("[data-highlighted]")?.textContent,
      ).toContain("Cherry");
    });
  });

  it("opens and selects with the keyboard", async () => {
    const onValueChange = vi.fn();
    render(<BasicSelect onValueChange={onValueChange} />);

    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const listbox = await screen.findByRole("listbox");
    await waitFor(() => {
      expect(listbox.querySelector("[data-highlighted]")).not.toBeNull();
    });

    // Once open, Base UI moves focus onto the highlighted option.
    const activeOption = document.activeElement as HTMLElement;
    fireEvent.keyDown(activeOption, { key: "ArrowDown" });
    const highlighted = listbox.querySelector("[data-highlighted]");
    expect(highlighted?.textContent).toContain("Banana");

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalled();
    });
    expect(onValueChange.mock.calls[0]?.[0]).toBe("banana");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  it("closes on Escape without changing the value", async () => {
    const onValueChange = vi.fn();
    render(<BasicSelect onValueChange={onValueChange} />);

    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    await screen.findByRole("listbox");

    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox").textContent).toContain("Apple");
  });

  it("supports controlled values", async () => {
    function Controlled() {
      const [value, setValue] = React.useState("apple");
      return <BasicSelect value={value} onValueChange={setValue} />;
    }
    render(<Controlled />);

    fireEvent.click(screen.getByRole("combobox"));
    await screen.findByRole("listbox");
    const option = screen.getByRole("option", { name: "Cherry" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);

    await waitFor(() => {
      expect(screen.getByRole("combobox").textContent).toContain("Cherry");
    });
  });

  it("submits the selected value through native form data", () => {
    render(<BasicSelect defaultValue="banana" />);

    const form = screen.getByRole("form", { name: "Fruit form" });
    const formData = new FormData(form as HTMLFormElement);

    expect(formData.get("fruit")).toBe("banana");
  });

  it("does not open while disabled", () => {
    render(<BasicSelect disabled />);

    const trigger = screen.getByRole("combobox");
    expect((trigger as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(trigger);

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders grouped items with labels and separators", async () => {
    render(
      <Select id="grouped" items={fruits} defaultValue="apple">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Pomes</SelectLabel>
            <SelectItem value="apple">Apple</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Berries</SelectLabel>
            <SelectItem value="banana">Banana</SelectItem>
            <SelectItem value="cherry">Cherry</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    fireEvent.click(screen.getByRole("combobox"));
    await screen.findByRole("listbox");

    expect(screen.getByText("Pomes")).toBeDefined();
    expect(screen.getByText("Berries")).toBeDefined();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
