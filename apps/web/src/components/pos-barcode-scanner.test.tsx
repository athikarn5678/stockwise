// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchPosProducts, SalesApiError } from "@/sales-api-client";
import { PosBarcodeScanner } from "./pos-barcode-scanner";

vi.mock("@/sales-api-client", async (original) => ({
  ...(await original<typeof import("@/sales-api-client")>()),
  searchPosProducts: vi.fn(),
}));
const context = { organizationId: "org", branchId: "branch" };
const product = {
  id: "product",
  name: "Coffee",
  sku: "C",
  unit: "EA" as const,
  barcode: "00Abc",
  available: true,
  availableQuantity: "5.0000",
  basePrice: "1.2345",
};
const response = { data: { products: [product] }, meta: { nextCursor: null } };
const onAdd = vi.fn();
const onPendingChange = vi.fn();
function setup() {
  return render(
    <PosBarcodeScanner
      context={context}
      disabled={false}
      onAdd={onAdd}
      onPendingChange={onPendingChange}
    />,
  );
}
function submit(value: string) {
  fireEvent.change(screen.getByLabelText("Scan or enter barcode"), {
    target: { value },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Scan POS barcode" }));
}
beforeEach(() => {
  vi.mocked(searchPosProducts).mockResolvedValue(response);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("POS barcode input", () => {
  it("preserves leading zeros and case, trims edges, clears and restores focus", async () => {
    setup();
    submit(" 00Abc ");
    expect(screen.getByLabelText("Scan or enter barcode")).toHaveProperty(
      "value",
      "",
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("Scan or enter barcode"),
    );
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(product));
    expect(searchPosProducts).toHaveBeenCalledWith(context, {
      barcode: "00Abc",
      signal: expect.any(AbortSignal),
    });
    expect(
      await screen.findByText("Added Coffee — barcode 00Abc."),
    ).toBeTruthy();
  });
  it("serializes different and identical scans while pending, ignoring empty terminators", async () => {
    let resolveFirst!: (value: typeof response) => void;
    vi.mocked(searchPosProducts).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    setup();
    submit("first");
    submit("second");
    submit("second");
    submit("");
    submit("  ");
    expect(searchPosProducts).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenLastCalledWith(3);
    await act(async () => {
      resolveFirst(response);
    });
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(3));
    expect(
      vi.mocked(searchPosProducts).mock.calls.map((call) => call[1]?.barcode),
    ).toEqual(["first", "second", "second"]);
    expect(onPendingChange).toHaveBeenLastCalledWith(0);
  });
  it("distinguishes missing, unavailable and failed lookup and allows a later scan", async () => {
    vi.mocked(searchPosProducts)
      .mockResolvedValueOnce({ ...response, data: { products: [] } })
      .mockResolvedValueOnce({
        ...response,
        data: {
          products: [
            { ...product, available: false, availableQuantity: "0.0000" },
          ],
        },
      })
      .mockRejectedValueOnce(new SalesApiError("unavailable"));
    setup();
    submit("missing");
    submit("no-stock");
    submit("network");
    submit(product.barcode);
    expect(
      await screen.findByText("No product found for barcode missing."),
    ).toBeTruthy();
    expect(await screen.findByText(/no-stock.*unavailable/)).toBeTruthy();
    expect(
      await screen.findByText(/Could not look up barcode network/),
    ).toBeTruthy();
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
  });
  it.each([
    "authentication_required",
    "forbidden",
    "branch_inactive",
    "validation",
  ] as const)("shows safe %s feedback without adding", async (kind) => {
    vi.mocked(searchPosProducts).mockRejectedValue(new SalesApiError(kind));
    setup();
    submit("00Abc");
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(0));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByText(/No product found/)).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(
      /Sign in|unavailable|Invalid barcode/,
    );
  });
  it("leaves incomplete input alone and does not hijack typing or late-result focus", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Scan or enter barcode"), {
      target: { value: "partial" },
    });
    expect(searchPosProducts).not.toHaveBeenCalled();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    fireEvent.keyDown(other, { key: "Enter" });
    expect(searchPosProducts).not.toHaveBeenCalled();
    submit("00Abc");
    other.focus();
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(other);
    other.remove();
  });
  it("aborts a timed-out lookup and continues the queue without adding the failed scan", async () => {
    vi.useFakeTimers();
    vi.mocked(searchPosProducts).mockImplementationOnce(
      (_context, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new SalesApiError("unavailable")),
          );
        }),
    );
    setup();
    submit("stalled");
    submit("next");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.getByText(/Could not look up barcode stalled/)).toBeTruthy();
  });
  it("aborts teardown and ignores a late lookup result", async () => {
    let finish!: (value: typeof response) => void;
    vi.mocked(searchPosProducts).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = setup();
    submit("late");
    submit("queued");
    const signal = vi.mocked(searchPosProducts).mock.calls[0]?.[1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response));
    expect(onAdd).not.toHaveBeenCalled();
    expect(searchPosProducts).toHaveBeenCalledOnce();
  });
  it("blocks scanning during checkout", async () => {
    render(
      <PosBarcodeScanner
        context={context}
        disabled
        onAdd={onAdd}
        onPendingChange={onPendingChange}
      />,
    );
    expect(screen.getByLabelText("Scan or enter barcode")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.submit(screen.getByRole("form", { name: "Scan POS barcode" }));
    expect(searchPosProducts).not.toHaveBeenCalled();
  });
});
