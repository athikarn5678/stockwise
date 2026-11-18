// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnalyticsApiError,
  type AnalyticsForecast,
  type AnalyticsReorder,
  getAnalyticsForecast,
  getAnalyticsReorder,
} from "@/analytics-api-client";
import { listProducts, type CatalogProduct } from "@/catalog-api-client";
import type { AccessibleOrganization } from "@/branch-api-client";
import { LanguageProvider } from "@/providers/language-provider";
import {
  chooseOption,
  chooseOptionByValue,
  readSelectOptionLabels,
} from "@/test/select-helpers";
import { ForecastReorderView } from "./forecast-reorder-view";

vi.mock("@/analytics-api-client", async (load) => {
  const real = await load<typeof import("@/analytics-api-client")>();
  return {
    ...real,
    getAnalyticsForecast: vi.fn(),
    getAnalyticsReorder: vi.fn(),
  };
});
vi.mock("@/catalog-api-client", async (load) => {
  const real = await load<typeof import("@/catalog-api-client")>();
  return { ...real, listProducts: vi.fn() };
});

const forecastMock = vi.mocked(getAnalyticsForecast);
const reorderMock = vi.mocked(getAnalyticsReorder);
const productMock = vi.mocked(listProducts);
const org = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Store",
  role: "OWNER" as const,
  branches: [
    { id: "20000000-0000-4000-8000-000000000001", code: "A", name: "Alpha" },
    { id: "20000000-0000-4000-8000-000000000002", code: "B", name: "Beta" },
  ],
};
const product: CatalogProduct = {
  id: "30000000-0000-4000-8000-000000000001",
  organizationId: org.id,
  sku: "ONE",
  name: "One",
  status: "ACTIVE",
  unit: "EA",
  barcode: null,
  basePrice: "1.0000",
  categoryId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  description: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const secondProduct: CatalogProduct = {
  ...product,
  id: "30000000-0000-4000-8000-000000000002",
  sku: "TWO",
  name: "Two",
};
const day = {
  localDate: "2026-09-25",
  bucketStartInclusive: "2026-09-24T17:00:00.000Z",
  bucketEndExclusive: "2026-09-25T17:00:00.000Z",
  quantity: "0.0000",
};
const availableForecast: AnalyticsForecast = {
  organizationId: org.id,
  branchId: org.branches[0]!.id,
  productId: product.id,
  unit: "EA",
  forecastVersion: "forecast-sale-mean-28d-v1",
  generatedAt: day.bucketStartInclusive,
  sourceCutoff: day.bucketStartInclusive,
  reportingTimezone: "Asia/Bangkok",
  trainingStartInclusive: "2026-08-28T17:00:00.000Z",
  trainingEndExclusive: day.bucketStartInclusive,
  historyStartAt: "2026-08-01T00:00:00.000Z",
  horizonDays: 7,
  horizonStartInclusive: day.bucketStartInclusive,
  horizonEndExclusive: "2026-10-01T17:00:00.000Z",
  status: "AVAILABLE",
  reason: null,
  days: [day],
  horizonTotal: "0.0000",
};
const availableReorder: AnalyticsReorder = {
  branchId: org.branches[0]!.id,
  productId: product.id,
  unit: "EA",
  forecastVersion: "forecast-sale-mean-28d-v1",
  reorderVersion: "reorder-v1",
  sourceCutoff: day.bucketStartInclusive,
  leadTimeDays: 7,
  dailyForecast: [day],
  onHand: "0.0000",
  status: "AVAILABLE",
  reason: null,
  leadTimeDemand: "0.0000",
  rawNeed: "0.0000",
  recommendedQuantity: "0.0000",
};

function mount(
  organization: AccessibleOrganization = org,
  language?: "en" | "th",
) {
  if (language !== undefined)
    localStorage.setItem("stockwise.language", language);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <ForecastReorderView organization={organization} />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}
let productLabel = "Product";
let showProductOptionsLabel = "Show product options";

function productInput(): HTMLInputElement {
  return screen.getByLabelText(productLabel, {
    exact: true,
  }) as HTMLInputElement;
}

async function openProductCombobox() {
  if (screen.queryByRole("listbox") === null) {
    // jsdom has no layout and Base UI only auto-opens on a real input event, so
    // open the popup through its trigger before typing.
    fireEvent.click(
      screen.getByRole("button", { name: showProductOptionsLabel }),
    );
    await screen.findByRole("listbox");
  }
}

async function chooseProduct(
  labels: { product: string; showOptions: string } = {
    product: "Product",
    showOptions: "Show product options",
  },
) {
  productLabel = labels.product;
  showProductOptionsLabel = labels.showOptions;
  await openProductCombobox();
  fireEvent.change(productInput(), { target: { value: "one" } });
  await waitFor(() =>
    expect(productMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ q: "one" }),
    ),
  );
  const option = await screen.findByRole("option", { name: "ONE — One" });
  // Base UI arms pointer selection on pointerdown; a bare `click` is ignored.
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(productInput().value).toBe("ONE — One"));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  productMock.mockResolvedValue({
    data: { products: [product] },
    meta: { nextCursor: null },
  });
  forecastMock.mockResolvedValue({
    data: { forecast: availableForecast },
  } as Awaited<ReturnType<typeof getAnalyticsForecast>>);
  reorderMock.mockResolvedValue({
    data: { recommendation: availableReorder },
  } as Awaited<ReturnType<typeof getAnalyticsReorder>>);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("Forecast and reorder view", () => {
  it.each(["INVENTORY_STAFF", "CASHIER"] as const)(
    "denies direct forecast view for %s without reading products or forecasts",
    async (role) => {
      mount({ ...org, role });
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(productMock).not.toHaveBeenCalled();
      expect(forecastMock).not.toHaveBeenCalled();
      expect(reorderMock).not.toHaveBeenCalled();
    },
  );
  it("requires a Product, shows zero as available, and explains advisory limitations", async () => {
    mount();
    expect(
      screen.getByText(
        "Choose a Product to see its forecast and reorder status.",
      ),
    ).toBeTruthy();
    await chooseProduct();
    expect(await screen.findByText("0.0000 EA total")).toBeTruthy();
    expect(await screen.findByText("Recommend 0.0000 EA")).toBeTruthy();
    expect(screen.getByText(/advisory only/)).toBeTruthy();
    expect(screen.queryByText("How to interpret these estimates")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /purchase|order/i }),
    ).toBeNull();
    await chooseOption(screen.getByLabelText("Planning lead time"), "7 days");
    await waitFor(() =>
      expect(reorderMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ leadTimeDays: 7 }),
        expect.anything(),
      ),
    );
  });

  it("offers exactly 7 and 30 day lead times and explains the planning assumption", async () => {
    mount();
    await chooseProduct();
    const select = screen.getByLabelText("Planning lead time");
    expect(await readSelectOptionLabels(select)).toEqual([
      "Choose 7 or 30 days",
      "7 days",
      "30 days",
    ]);
    expect(
      screen.getByText(
        "Forecast is the average of the last 28 days of sales; reorder covers the chosen lead time and is advisory only.",
      ),
    ).toBeTruthy();
    // Branch, Product and lead time share one equal-width row (stacked on mobile).
    const row = select.closest(".grid");
    expect(row?.className).toContain("grid-cols-1");
    expect(row?.className).toContain("sm:grid-cols-3");
    expect(row?.children).toHaveLength(3);
    await chooseOptionByValue(select, "7");
    await waitFor(() =>
      expect(reorderMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ leadTimeDays: 7 }),
        expect.anything(),
      ),
    );
    reorderMock.mockResolvedValue({
      data: {
        recommendation: {
          ...availableReorder,
          leadTimeDays: 30,
          leadTimeDemand: "3.2130",
          rawNeed: "3.2130",
          recommendedQuantity: "4.0000",
        },
      },
    } as Awaited<ReturnType<typeof getAnalyticsReorder>>);
    await chooseOptionByValue(select, "30");
    await waitFor(() =>
      expect(reorderMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ leadTimeDays: 30 }),
        expect.anything(),
      ),
    );
    expect(
      await within(screen.getByLabelText("Reorder result")).findAllByText(
        "3.2130 EA",
      ),
    ).toHaveLength(2);
    expect(await screen.findByText("Recommend 4.0000 EA")).toBeTruthy();
  });

  it("localizes the lead time options and explanation in Thai", async () => {
    mount(org, "th");
    await chooseProduct({
      product: "สินค้า",
      showOptions: "แสดงตัวเลือกสินค้า",
    });
    const select = await screen.findByLabelText("ระยะเวลารอสินค้า");
    expect(await readSelectOptionLabels(select)).toEqual([
      "เลือก 7 หรือ 30 วัน",
      "7 วัน",
      "30 วัน",
    ]);
    expect(
      screen.getByText(
        "พยากรณ์จากค่าเฉลี่ยยอดขาย 28 วันล่าสุด ส่วนปริมาณสั่งซื้อครอบคลุมตามระยะเวลาที่เลือก และเป็นเพียงคำแนะนำ",
      ),
    ).toBeTruthy();
    await chooseOptionByValue(select, "30");
    await waitFor(() =>
      expect(reorderMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ leadTimeDays: 30 }),
        expect.anything(),
      ),
    );
  });

  it("reports distinct unavailable reasons and request errors", async () => {
    forecastMock.mockResolvedValue({
      data: {
        forecast: {
          ...availableForecast,
          status: "UNAVAILABLE",
          reason: "INSUFFICIENT_DATA",
          days: [],
          horizonTotal: null,
        },
      },
    } as Awaited<ReturnType<typeof getAnalyticsForecast>>);
    reorderMock.mockResolvedValue({
      data: {
        recommendation: {
          ...availableReorder,
          status: "UNAVAILABLE",
          reason: "LEAD_TIME_REQUIRED",
          leadTimeDemand: null,
          rawNeed: null,
          recommendedQuantity: null,
        },
      },
    } as Awaited<ReturnType<typeof getAnalyticsReorder>>);
    mount();
    await chooseProduct();
    expect(
      await screen.findByText(/No inventory movement for this Branch\/Product/),
    ).toBeTruthy();
    expect(await screen.findByText(/Choose a planning lead time/)).toBeTruthy();
    expect(screen.queryByText(/Recommend 0.0000/)).toBeNull();
  });

  it.each([
    "INACTIVE_PRODUCT",
    "INVENTORY_INTEGRITY_ERROR",
    "QUANTITY_OUT_OF_RANGE",
    "UNSUPPORTED_LEAD_TIME",
  ] as const)("announces %s without a fabricated quantity", async (reason) => {
    reorderMock.mockResolvedValue({
      data: {
        recommendation: {
          ...availableReorder,
          status: "UNAVAILABLE",
          reason,
          leadTimeDemand: null,
          rawNeed: null,
          recommendedQuantity: null,
        },
      },
    } as Awaited<ReturnType<typeof getAnalyticsReorder>>);
    mount();
    await chooseProduct();
    const reorder = screen.getByLabelText("Reorder result");
    await waitFor(() =>
      expect(within(reorder).getByRole("status")).toBeTruthy(),
    );
    expect(within(reorder).queryByText(/Recommend /)).toBeNull();
  });

  it("shows positive recommendations and a separate authorization error", async () => {
    reorderMock.mockResolvedValue({
      data: {
        recommendation: {
          ...availableReorder,
          leadTimeDemand: "2.5000",
          rawNeed: "2.5000",
          recommendedQuantity: "3.0000",
        },
      },
    } as Awaited<ReturnType<typeof getAnalyticsReorder>>);
    forecastMock.mockRejectedValue(new AnalyticsApiError("forbidden"));
    mount();
    await chooseProduct();
    expect(await screen.findByText("Recommend 3.0000 EA")).toBeTruthy();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Forecast and reorder are not available for your current access.",
    );
  });

  it("labels forecast and reorder with their own source cutoffs", async () => {
    const reorderCutoff = "2026-09-25T01:00:00.000Z";
    reorderMock.mockResolvedValue({
      data: {
        recommendation: { ...availableReorder, sourceCutoff: reorderCutoff },
      },
    } as Awaited<ReturnType<typeof getAnalyticsReorder>>);
    mount();
    await chooseProduct();
    const forecast = screen.getByLabelText("Forecast result");
    const reorder = screen.getByLabelText("Reorder result");
    await waitFor(() =>
      expect(within(forecast).getByText(/Data as of/)).toHaveProperty(
        "textContent",
        expect.stringContaining(availableForecast.sourceCutoff),
      ),
    );
    expect(within(reorder).getByText(/Data as of/).textContent).toContain(
      reorderCutoff,
    );
    expect(
      within(reorder).queryByText(new RegExp(availableForecast.sourceCutoff)),
    ).toBeNull();
  });

  it("announces loading without showing a stale value", async () => {
    forecastMock.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof getAnalyticsForecast>>>(() => {}),
    );
    reorderMock.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof getAnalyticsReorder>>>(() => {}),
    );
    mount();
    await chooseProduct();
    expect(screen.getByText("Loading forecast…")).toHaveProperty(
      "textContent",
      "Loading forecast…",
    );
    expect(screen.getByText("Loading reorder recommendation…")).toBeTruthy();
    expect(screen.queryByText(/Recommend 0.0000/)).toBeNull();
  });

  it("clears Product selection when Branch access or search changes", async () => {
    mount();
    await chooseProduct();
    await screen.findByText("0.0000 EA total");
    await chooseOption(screen.getByLabelText("Branch"), "B — Beta");
    expect(
      screen.getByText(
        "Choose a Product to see its forecast and reorder status.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0.0000 EA total")).toBeNull();
    await chooseProduct();
    await screen.findByText("0.0000 EA total");
    fireEvent.change(productInput(), { target: { value: "other" } });
    expect(screen.queryByText("0.0000 EA total")).toBeNull();
    expect(productInput().value).toBe("other");
  });

  it("shows a localized hint instead of loading while no Branch is active", async () => {
    mount({ ...org, branches: [] });
    await openProductCombobox();
    const popup = document.querySelector("[data-slot='combobox-content']");
    expect(popup).toBeTruthy();
    expect(
      // Base UI appends an invisible joiner to empty-state text.
      within(popup as HTMLElement).getByText(
        /^Choose a Branch to search Products\./,
      ),
    ).toBeTruthy();
    expect(
      within(popup as HTMLElement).queryByText("Loading Products…"),
    ).toBeNull();
    expect(productMock).not.toHaveBeenCalled();
  });

  it("shows the loading state only while the product query is fetching", async () => {
    productMock.mockImplementation(
      () => new Promise<Awaited<ReturnType<typeof listProducts>>>(() => {}),
    );
    mount();
    await openProductCombobox();
    const popup = document.querySelector("[data-slot='combobox-content']");
    expect(
      await within(popup as HTMLElement).findByText("Loading Products…"),
    ).toBeTruthy();
    expect(
      within(popup as HTMLElement).queryByText(
        /^No Products match this search\./,
      ),
    ).toBeNull();
    expect(productMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the settled empty result message when the search matches nothing", async () => {
    productMock.mockResolvedValue({
      data: { products: [] },
      meta: { nextCursor: null },
    });
    mount();
    await openProductCombobox();
    const popup = document.querySelector("[data-slot='combobox-content']");
    expect(
      await within(popup as HTMLElement).findByText(
        /^No Products match this search\./,
      ),
    ).toBeTruthy();
    expect(
      within(popup as HTMLElement).queryByText(/^Loading Products/),
    ).toBeNull();
  });

  it("shows the localized error instead of an empty result when loading fails", async () => {
    productMock.mockRejectedValue(new Error("catalog unavailable"));
    mount();
    await openProductCombobox();
    const popup = document.querySelector("[data-slot='combobox-content']");
    expect(
      await within(popup as HTMLElement).findByText(
        /^Products could not be loaded\./,
      ),
    ).toBeTruthy();
    expect(
      within(popup as HTMLElement).queryByText("Loading Products…"),
    ).toBeNull();
    expect(
      within(popup as HTMLElement).queryByText(
        "No Products match this search.",
      ),
    ).toBeNull();
  });

  it("starts a fresh search from the first edit after a Product is selected", async () => {
    mount();
    await chooseProduct();
    await screen.findByText("0.0000 EA total");
    await waitFor(() => expect(productInput().value).toBe("ONE — One"));

    // Backspacing inside the selected label must search for what is now in the
    // input, not keep the pre-selection query.
    fireEvent.change(productInput(), { target: { value: "ONE — On" } });

    await waitFor(() =>
      expect(productMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ q: "ONE — On" }),
      ),
    );
    expect(productMock).not.toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ q: "one" }),
    );
    // The selection is dropped, so the old forecast is not shown for new text.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Choose a Product to see its forecast and reorder status.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("0.0000 EA total")).toBeNull();
    expect(productInput().value).toBe("ONE — On");

    // Deleting the rest of the selected label searches for the empty query
    // instead of keeping either the label or the pre-selection text.
    fireEvent.change(productInput(), { target: { value: "" } });
    await waitFor(() =>
      expect(productMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ q: "" }),
      ),
    );
    expect(productInput().value).toBe("");
  });

  it("searches the server from the combobox and appends the next page", async () => {
    productMock.mockImplementation(async (_context, options) =>
      options?.cursor === undefined
        ? { data: { products: [product] }, meta: { nextCursor: "cursor-1" } }
        : { data: { products: [secondProduct] }, meta: { nextCursor: null } },
    );
    mount();
    await openProductCombobox();
    await screen.findByRole("option", { name: "ONE — One" });
    expect(productMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ q: "" }),
    );

    fireEvent.change(productInput(), { target: { value: "two" } });
    await waitFor(() =>
      expect(productMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ q: "two" }),
      ),
    );

    // The new query key has no data until the mocked page resolves.
    await screen.findByRole("option", { name: "ONE — One" });
    fireEvent.click(screen.getByRole("button", { name: "Load more Products" }));
    await waitFor(() =>
      expect(productMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ cursor: "cursor-1" }),
      ),
    );
    await screen.findByRole("option", { name: "TWO — Two" });
    expect(screen.getByRole("option", { name: "ONE — One" })).toBeTruthy();
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });
});
