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
async function chooseProduct(productLabel = "Product") {
  await screen.findByRole("option", { name: "ONE — One" });
  fireEvent.change(screen.getByLabelText(productLabel, { exact: true }), {
    target: { value: product.id },
  });
}

beforeEach(() => {
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
    expect(
      within(
        screen.getByLabelText("Forecast and reorder limitations"),
      ).getByText(/never places an order/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /purchase|order/i }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Planning lead time"), {
      target: { value: "7" },
    });
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
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Choose 7 or 30 days", "7 days", "30 days"]);
    expect(
      screen.getByText(
        "Planning lead time is the number of days between placing a purchase order and receiving the goods. The recommendation covers expected sales over that many days.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The recommended order quantity can be 0 when stock on hand already covers the forecast demand for the selected lead time, so nothing needs to be ordered now.",
      ),
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: "7" } });
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
    fireEvent.change(select, { target: { value: "30" } });
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
    await chooseProduct("สินค้า");
    const select = await screen.findByLabelText("ระยะเวลารอสินค้า");
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["เลือก 7 หรือ 30 วัน", "7 วัน", "30 วัน"]),
    );
    expect(
      screen.getByText(
        "ระยะเวลารอสินค้าคือจำนวนวันระหว่างการสั่งซื้อจนได้รับสินค้า คำแนะนำจะครอบคลุมยอดขายที่คาดว่าจะเกิดขึ้นในช่วงจำนวนวันนั้น",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "จำนวนที่แนะนำอาจเป็น 0 ได้ เมื่อสต็อกคงเหลือเพียงพอกับความต้องการที่พยากรณ์ไว้ตลอดระยะเวลารอสินค้าที่เลือก จึงยังไม่ต้องสั่งซื้อเพิ่ม",
      ),
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: "30" } });
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
    fireEvent.change(screen.getByLabelText("Branch"), {
      target: { value: org.branches[1]!.id },
    });
    expect(
      screen.getByText(
        "Choose a Product to see its forecast and reorder status.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0.0000 EA total")).toBeNull();
    await chooseProduct();
    fireEvent.change(screen.getByLabelText("Find Product"), {
      target: { value: "other" },
    });
    expect(screen.queryByText("0.0000 EA total")).toBeNull();
  });
});
