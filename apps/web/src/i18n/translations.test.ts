import { describe, expect, it } from "vitest";

import { en, type TranslationKey } from "./en";
import { th } from "./th";

describe("English and Thai translation contracts", () => {
  it("provides nonempty translations with matching interpolation fields", () => {
    expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as TranslationKey[]) {
      expect(th[key].trim(), key).not.toBe("");
      expect(en[key].trim(), key).not.toBe("");
      // Thai has no English plural suffix; the seconds value is still required.
      const fields = (text: string) =>
        (text.match(/\{\w+\}/g) ?? [])
          .filter((field) => key !== "authRateLimited" || field !== "{plural}")
          .sort();
      expect(fields(th[key]), key).toEqual(fields(en[key]));
    }
  });
});
