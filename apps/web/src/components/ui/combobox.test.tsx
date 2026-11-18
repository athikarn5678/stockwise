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
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxLoadMore,
} from "./combobox";

type Framework = { value: string; label: string };

const frameworks: Framework[] = [
  { value: "react", label: "React" },
  { value: "vue", label: "Vue" },
  { value: "svelte", label: "Svelte" },
];

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

beforeEach(() => {
  // jsdom has no layout; Base UI's list scrolling and positioning need a stub.
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

function ClientCombobox({
  onValueChange,
  onInputValueChange,
  onLoadMore,
  loading = false,
}: {
  onValueChange?: (value: Framework | null) => void;
  onInputValueChange?: (value: string) => void;
  onLoadMore?: () => void;
  loading?: boolean;
}) {
  return (
    <form aria-label="Framework form">
      <Label htmlFor="framework">Framework</Label>
      <Combobox
        items={frameworks}
        name="framework"
        defaultValue={frameworks[1]}
        itemToStringValue={(item: Framework) => item.value}
        onValueChange={(next) => onValueChange?.(next)}
        onInputValueChange={(next) => onInputValueChange?.(next)}
      >
        <ComboboxInput id="framework" placeholder="Search frameworks" />
        <ComboboxContent>
          <ComboboxEmpty>No matches</ComboboxEmpty>
          <ComboboxList>
            {(item: Framework) => (
              <ComboboxItem key={item.value} value={item}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
          {onLoadMore ? (
            <ComboboxLoadMore loading={loading} onClick={onLoadMore}>
              Load more
            </ComboboxLoadMore>
          ) : null}
        </ComboboxContent>
      </Combobox>
    </form>
  );
}

describe("Combobox", () => {
  it("associates the label with the text input", () => {
    render(<ClientCombobox />);

    const input = screen.getByLabelText("Framework");
    expect(input.tagName).toBe("INPUT");
    expect(input).toBe(screen.getByPlaceholderText("Search frameworks"));
  });

  it("shows the selected item's label in the input", () => {
    render(<ClientCombobox />);

    const input = screen.getByLabelText("Framework") as HTMLInputElement;
    expect(input.value).toBe("Vue");
  });

  it("filters items as the user types and shows the empty state", async () => {
    const onInputValueChange = vi.fn();
    render(<ClientCombobox onInputValueChange={onInputValueChange} />);

    const input = screen.getByLabelText("Framework") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    await screen.findByRole("listbox");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    fireEvent.change(input, { target: { value: "sv" } });

    expect(onInputValueChange).toHaveBeenCalled();
    expect(onInputValueChange.mock.calls.at(-1)?.[0]).toBe("sv");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(screen.getByRole("option", { name: "Svelte" })).toBeDefined();

    fireEvent.change(input, { target: { value: "zzz" } });

    const empty = await screen.findByText("No matches");
    expect(empty).toBeDefined();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("selects an item with a click", async () => {
    const onValueChange = vi.fn();
    render(<ClientCombobox onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Framework") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    await screen.findByRole("listbox");

    const option = screen.getByRole("option", { name: "Svelte" });
    // Base UI arms pointer selection on pointerdown; a bare jsdom `click` is
    // treated as a stale mouse click and ignored.
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalled();
    });
    const selected = onValueChange.mock.calls[0]?.[0] as Framework;
    expect(selected.value).toBe("svelte");
    await waitFor(() => {
      expect(input.value).toBe("Svelte");
    });
  });

  it("opens and selects with the keyboard", async () => {
    const onValueChange = vi.fn();
    render(<ClientCombobox onValueChange={onValueChange} />);

    const input = screen.getByLabelText("Framework") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");

    await waitFor(() => {
      expect(
        listbox.querySelector("[data-highlighted]")?.textContent,
      ).toContain("Vue");
    });

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(listbox.querySelector("[data-highlighted]")?.textContent).toContain(
      "Svelte",
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalled();
    });
    const selected = onValueChange.mock.calls[0]?.[0] as Framework;
    expect(selected.value).toBe("svelte");
    await waitFor(() => {
      expect(input.value).toBe("Svelte");
    });
  });

  it("closes on Escape", async () => {
    render(<ClientCombobox />);

    const input = screen.getByLabelText("Framework");
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    await screen.findByRole("listbox");

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  it("submits the selected value through native form data", () => {
    render(<ClientCombobox />);

    const form = screen.getByRole("form", { name: "Framework form" });
    const formData = new FormData(form as HTMLFormElement);

    expect(formData.get("framework")).toBe("vue");
  });

  it("keeps the popup open while loading more and disables it while loading", async () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<ClientCombobox onLoadMore={onLoadMore} />);

    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    await screen.findByRole("listbox");

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeNull();

    rerender(<ClientCombobox onLoadMore={onLoadMore} loading />);

    const busyButton = screen.getByRole("button", { name: "Load more" });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    expect(busyButton.getAttribute("aria-busy")).toBe("true");
  });

  it("replaces items on each input value change for server-side search", async () => {
    const fetchItems = vi.fn(async (query: string): Promise<Framework[]> =>
      frameworks.filter((framework) =>
        framework.label.toLowerCase().includes(query.toLowerCase()),
      ),
    );

    function ServerCombobox() {
      const [query, setQuery] = React.useState("");
      const [items, setItems] = React.useState<Framework[]>(frameworks);

      React.useEffect(() => {
        let cancelled = false;
        void fetchItems(query).then((next) => {
          if (!cancelled) {
            setItems(next);
          }
        });
        return () => {
          cancelled = true;
        };
      }, [query]);

      return (
        <Combobox
          items={items}
          filter={null}
          inputValue={query}
          onInputValueChange={setQuery}
        >
          <ComboboxInput aria-label="Server framework" />
          <ComboboxContent>
            <ComboboxEmpty>No matches</ComboboxEmpty>
            <ComboboxList>
              {items.map((item) => (
                <ComboboxItem key={item.value} value={item}>
                  {item.label}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      );
    }

    render(<ServerCombobox />);

    const input = screen.getByLabelText("Server framework");
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await screen.findByRole("listbox");

    fireEvent.change(input, { target: { value: "v" } });
    expect(fetchItems).toHaveBeenLastCalledWith("v");

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(screen.getByRole("option", { name: "Vue" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Svelte" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "React" })).toBeNull();

    fireEvent.change(input, { target: { value: "vu" } });
    expect(fetchItems).toHaveBeenLastCalledWith("vu");

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(screen.getByRole("option", { name: "Vue" })).toBeDefined();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText("No matches")).toBeDefined();
  });
});
