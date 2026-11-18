import {
  ChecksumException,
  FormatException,
  NotFoundException,
} from "@zxing/library";
import { describe, expect, it } from "vitest";

import { isZxingDecodeException } from "./zxing-errors";

/** What a production minifier does to the class name ts-custom-error reads. */
function minified<T extends Error>(error: T, name = "e"): T {
  Object.defineProperty(error, "name", { configurable: true, value: name });
  return error;
}

describe("isZxingDecodeException", () => {
  it("recognizes the real ZXing decode exceptions even when the name is mangled", () => {
    for (const error of [
      new NotFoundException(),
      new ChecksumException(),
      new FormatException(),
    ]) {
      expect(isZxingDecodeException(error)).toBe(true);
      expect(isZxingDecodeException(minified(error))).toBe(true);
      expect(minified(error).name).not.toMatch(/Exception/);
    }
  });

  it("does not treat camera or stream failures as decode exceptions", () => {
    for (const error of [
      new DOMException("denied", "NotAllowedError"),
      new DOMException("busy", "NotReadableError"),
      new DOMException("gone", "NotFoundError"),
      new Error("NotFoundException"),
      Object.assign(new Error("x"), { name: "NotFoundException" }),
      null,
      undefined,
      "NotFoundException",
      { getKind: "NotFoundException" },
    ])
      expect(isZxingDecodeException(error)).toBe(false);
  });

  it("ignores a getKind that throws or returns a non-string", () => {
    expect(
      isZxingDecodeException({
        getKind() {
          throw new Error("boom");
        },
      }),
    ).toBe(false);
    expect(isZxingDecodeException({ getKind: () => 7 })).toBe(false);
  });
});
