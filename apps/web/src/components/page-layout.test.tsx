// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ListToolbar,
  PageContainer,
  PageHeader,
  PageTabs,
  StatusFilter,
} from "@/components/page-layout";
import { LanguageProvider } from "@/providers/language-provider";
import { chooseOptionByValue, expectSelectValue } from "@/test/select-helpers";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

function mount(node: React.ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

describe("PageContainer", () => {
  it("renders one centered, width-limited column", () => {
    mount(<PageContainer>content</PageContainer>);
    const container = screen.getByText("content");
    expect(container.getAttribute("data-slot")).toBe("page-container");
    expect(container.className).toContain("mx-auto");
    expect(container.className).toContain("max-w-6xl");
  });
});

describe("PageHeader", () => {
  it("shows title, description and actions", () => {
    mount(
      <PageHeader
        actions={<button type="button">Add</button>}
        description="About this page"
        title="Suppliers"
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Suppliers" }),
    ).toBeTruthy();
    expect(screen.getByText("About this page")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });
});

describe("PageTabs", () => {
  it("marks the selected tab and reports a change without any underline", () => {
    const onValueChange = vi.fn();
    mount(
      <PageTabs
        ariaLabel="Views"
        onValueChange={onValueChange}
        tabs={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ]}
        value="a"
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Alpha" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed"),
    ).toBe("false");
    const group = screen.getByRole("group", { name: "Views" });
    expect(group.className).not.toMatch(/border-b|underline/);
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onValueChange).toHaveBeenCalledWith("b");
  });
});

describe("StatusFilter", () => {
  it("offers Active, Inactive and All with default labels", async () => {
    const onValueChange = vi.fn();
    mount(<StatusFilter onValueChange={onValueChange} value="ACTIVE" />);
    const trigger = screen.getByLabelText("Status");
    expectSelectValue(trigger, "Active");
    await chooseOptionByValue(trigger, "INACTIVE");
    expect(onValueChange).toHaveBeenCalledWith("INACTIVE");
  });

  it("accepts a custom field label and option labels", () => {
    mount(
      <StatusFilter
        label="Product status"
        labels={{ active: "Active products", all: "All products" }}
        onValueChange={() => undefined}
        value="ALL"
      />,
    );
    expectSelectValue(screen.getByLabelText("Product status"), "All products");
  });
});

describe("ListToolbar", () => {
  it("combines search, status filter and refresh", () => {
    const onChange = vi.fn();
    const onRefresh = vi.fn();
    mount(
      <ListToolbar
        onRefresh={onRefresh}
        search={{ label: "Search suppliers", onChange }}
        status={<StatusFilter onValueChange={() => undefined} value="ALL" />}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search suppliers"), {
      target: { value: "tea" },
    });
    expect(onChange).toHaveBeenCalledWith("tea");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expectSelectValue(screen.getByLabelText("Status"), "All");
  });
});
