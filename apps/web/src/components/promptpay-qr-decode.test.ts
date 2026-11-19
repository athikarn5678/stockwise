import {
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import {
  PROMPTPAY_BADGE_WIDTH_PERCENT,
  PROMPTPAY_QR_ERROR_CORRECTION,
} from "@/components/promptpay-panel";

// A PromptPay-shaped EMV payload (value is irrelevant to the QR layer).
const PAYLOAD =
  "00020101021229370016A000000677010111011300668123456785303764540510.005802TH6304CA25";

/** Rasterizes the QR matrix, optionally blanking a centered square to model the badge. */
function luminances(coverPercent: number) {
  const qr = QRCode.create(PAYLOAD, {
    errorCorrectionLevel: PROMPTPAY_QR_ERROR_CORRECTION,
  });
  const size = qr.modules.size;
  const scale = 6;
  const quiet = 4;
  const side = (size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side).fill(255);
  const cover = Math.floor((size * coverPercent) / 100);
  const start = Math.floor((size - cover) / 2);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const inBadge =
        row >= start &&
        row < start + cover &&
        column >= start &&
        column < start + cover;
      if (inBadge || !qr.modules.get(row, column)) continue;
      for (let y = 0; y < scale; y += 1)
        for (let x = 0; x < scale; x += 1)
          pixels[
            ((row + quiet) * scale + y) * side + (column + quiet) * scale + x
          ] = 0;
    }
  }
  return { pixels, side };
}

function decode(coverPercent: number): string {
  const { pixels, side } = luminances(coverPercent);
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, side, side)),
  );
  return new QRCodeReader().decode(bitmap).getText();
}

describe("PromptPay QR", () => {
  it("uses error correction level H", () => {
    expect(PROMPTPAY_QR_ERROR_CORRECTION).toBe("H");
    expect(PROMPTPAY_BADGE_WIDTH_PERCENT).toBeLessThanOrEqual(20);
    expect(
      QRCode.create(PAYLOAD, { errorCorrectionLevel: "H" }).errorCorrectionLevel
        .bit,
    ).toBe(
      QRCode.create(PAYLOAD, {
        errorCorrectionLevel: PROMPTPAY_QR_ERROR_CORRECTION,
      }).errorCorrectionLevel.bit,
    );
  });

  it("decodes back to the exact payload", () => {
    expect(decode(0)).toBe(PAYLOAD);
  });

  it("still decodes with the centered badge area blanked", () => {
    expect(decode(PROMPTPAY_BADGE_WIDTH_PERCENT)).toBe(PAYLOAD);
  });
});
