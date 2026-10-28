// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encodeProductLabel,
  ProductBarcodeLabels,
} from "./product-barcode-labels";

const product = { name: "Tea", sku: "TEA-01", barcode: "0012345678905" };

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function preview() {
  render(<ProductBarcodeLabels product={product} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Preview barcode labels" }),
  );
}

describe("Code 128 product label encoding", () => {
  it("encodes known Code 128 B symbols including the weighted checksum and stop", () => {
    // AB: start B=104; A=33; B=34; checksum=(104+33+2*34)%103=102.
    const encoded = encodeProductLabel("AB");
    expect(encoded.data).toBe(
      "11010010000" +
        "10100011000" +
        "10001011000" +
        "11110101110" +
        "1100011101011",
    );
    expect(encoded.modules).toBe(encoded.data!.length + 20);
    expect(encoded.symbolWidthMm).toBe(encoded.modules! * 0.33);
    expect(encoded.labelWidthMm).toBe(100);
  });

  it("widens long labels while preserving bar width instead of squeezing the symbol", () => {
    const encoded = encodeProductLabel("Ab".repeat(20));
    expect(encoded.error).toBeUndefined();
    expect(encoded.labelWidthMm).toBeGreaterThan(100);
    expect(encoded.labelWidthMm).toBeLessThanOrEqual(190);
    expect(encoded.labelWidthMm).toBe(encoded.symbolWidthMm! + 8);
  });

  it.each([null, "", "ไทย", "AB\nCD", "é", "A".repeat(129)])(
    "rejects missing or unrepresentable Code 128 values without generating a replacement: %s",
    (value) => {
      expect(encodeProductLabel(value).error).toBeTruthy();
      expect(encodeProductLabel(value).data).toBeUndefined();
    },
  );

  it("refuses an oversized symbol instead of printing unscannably small bars", () => {
    expect(encodeProductLabel("A".repeat(128)).error).toBe("barcodeErrWide");
  });
});

describe("product barcode label preview", () => {
  it("renders real vector bars with quiet zones and the exact leading-zero value", () => {
    preview();
    const svg = screen.getByRole("img", {
      name: `Code 128 barcode ${product.barcode}`,
    });
    expect(screen.getByText(product.barcode)).toBeTruthy();
    expect(screen.getByText("SKU: TEA-01")).toBeTruthy();
    const bars = [...svg.querySelectorAll('rect[fill="black"]')];
    expect(bars.length).toBeGreaterThan(10);
    expect(bars[0]?.getAttribute("x")).toBe("10");
    const encoded = encodeProductLabel(product.barcode);
    // Reconstruct the actual rendered bars; a wrong value/blank SVG cannot pass.
    const rendered = Array.from({ length: encoded.data!.length }, () => "0");
    for (const bar of bars) {
      const start = Number(bar.getAttribute("x")) - 10;
      const width = Number(bar.getAttribute("width"));
      rendered.fill("1", start, start + width);
    }
    expect(rendered.join("")).toBe(encoded.data);
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${encoded.modules} 60`);
    expect(svg.getAttribute("width")).toBe(`${encoded.symbolWidthMm}mm`);
  });

  it("prints the chosen repeated quantity through window.print and returns to catalog", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    preview();
    fireEvent.change(screen.getByLabelText("Label quantity"), {
      target: { value: "3" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Print labels" }));
    expect(print).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to catalog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".barcode-label-workflow")).toBeNull();
  });

  it.each(["", "0", "101", "1.5", "-1"])(
    "blocks invalid quantity %s",
    (quantity) => {
      preview();
      fireEvent.change(screen.getByLabelText("Label quantity"), {
        target: { value: quantity },
      });
      expect(screen.getByRole("alert").textContent).toContain("whole number");
      expect(
        screen.getByRole("button", { name: "Print labels" }),
      ).toHaveProperty("disabled", true);
      expect(screen.queryAllByRole("article")).toHaveLength(0);
    },
  );

  it("accepts the bounded maximum quantity", () => {
    preview();
    fireEvent.change(screen.getByLabelText("Label quantity"), {
      target: { value: "100" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(100);
  });

  it("disables preview when no barcode is saved", () => {
    render(<ProductBarcodeLabels product={{ ...product, barcode: null }} />);
    expect(
      screen.getByRole("button", { name: "Preview barcode labels" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText(/No barcode set/)).toBeTruthy();
  });

  it("shows a safe error for existing Unicode identifiers without changing the value", () => {
    render(<ProductBarcodeLabels product={{ ...product, barcode: "ไทย" }} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Preview barcode labels" }),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "saved barcode is unchanged",
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Print labels" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("escapes identifier and product text and does not duplicate SKU when it equals barcode", () => {
    const value = "<script>";
    render(
      <ProductBarcodeLabels
        product={{ name: "<img onerror=alert(1)>", sku: value, barcode: value }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview barcode labels" }),
    );
    expect(screen.getByText(value)).toBeTruthy();
    expect(screen.getByText("<img onerror=alert(1)>")).toBeTruthy();
    expect(
      document.querySelector(
        ".barcode-label-sheet script, .barcode-label-sheet img",
      ),
    ).toBeNull();
    expect(screen.queryByText(`SKU: ${value}`)).toBeNull();
  });
});
