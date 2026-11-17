import { describe, expect, it } from "vitest";

import { buildPromptPayPayload, crc16Ccitt } from "./promptpay-payload.ts";

// Independently derived reference strings (CRC-16/CCITT-FALSE computed by a
// separate throwaway Python implementation, not by this module).
const VECTOR_MOBILE = "0812345678";
const VECTOR_AMOUNT = "10.00";
const VECTOR_PAYLOAD =
  "00020101021229370016A000000677010111011300668123456785303764540510.005802TH6304CA25";
const SECOND_MOBILE = "0899999999";
const SECOND_AMOUNT = "4.22";
const SECOND_PAYLOAD =
  "00020101021229370016A00000067701011101130066899999999530376454044.225802TH6304E3EE";

interface TlvField {
  id: string;
  length: string;
  value: string;
}

function parseTlv(text: string): TlvField[] {
  const fields: TlvField[] = [];
  let offset = 0;
  while (offset < text.length) {
    const id = text.slice(offset, offset + 2);
    const length = text.slice(offset + 2, offset + 4);
    const value = text.slice(offset + 4, offset + 4 + Number(length));
    fields.push({ id, length, value });
    offset += 4 + Number(length);
  }
  return fields;
}

describe("PromptPay payload", () => {
  it("computes the standard CRC-16/CCITT-FALSE check value", () => {
    expect(crc16Ccitt("123456789")).toBe("29B1");
    expect(crc16Ccitt("")).toBe("FFFF");
  });

  it("matches independently derived payload vectors", () => {
    expect(
      buildPromptPayPayload({
        amount: VECTOR_AMOUNT,
        mobileNumber: VECTOR_MOBILE,
      }),
    ).toBe(VECTOR_PAYLOAD);
    expect(
      buildPromptPayPayload({
        amount: SECOND_AMOUNT,
        mobileNumber: SECOND_MOBILE,
      }),
    ).toBe(SECOND_PAYLOAD);
  });

  it("serialises the accepted fields in EMVCo order with exact lengths", () => {
    const payload = buildPromptPayPayload({
      amount: VECTOR_AMOUNT,
      mobileNumber: VECTOR_MOBILE,
    });
    const fields = parseTlv(payload);

    expect(fields.map((entry) => entry.id)).toEqual([
      "00",
      "01",
      "29",
      "53",
      "54",
      "58",
      "63",
    ]);
    expect(fields.map((entry) => entry.length)).toEqual([
      "02",
      "02",
      "37",
      "03",
      "05",
      "02",
      "04",
    ]);
    expect(fields[0]?.value).toBe("01");
    expect(fields[1]?.value).toBe("12");
    expect(fields[3]?.value).toBe("764");
    expect(fields[4]?.value).toBe(VECTOR_AMOUNT);
    expect(fields[5]?.value).toBe("TH");

    const merchantAccount = parseTlv(fields[2]?.value ?? "");
    expect(merchantAccount.map((entry) => entry.id)).toEqual(["00", "01"]);
    expect(merchantAccount[0]?.value).toBe("A000000677010111");
    expect(merchantAccount[1]?.value).toBe("0066812345678");
    expect(fields[6]?.value).toBe(crc16Ccitt(payload.slice(0, -4)));
  });

  it.each(["0.00", "1", "1.234", "abc", "-1.00", "", "1.2", "1.000"])(
    "rejects the amount %j",
    (amount) => {
      expect(() =>
        buildPromptPayPayload({ amount, mobileNumber: VECTOR_MOBILE }),
      ).toThrow();
    },
  );

  it.each(["812345678", "08123456789", "+66812345678", "", "081234567a"])(
    "rejects the mobile number %j",
    (mobileNumber) => {
      expect(() =>
        buildPromptPayPayload({ amount: VECTOR_AMOUNT, mobileNumber }),
      ).toThrow();
    },
  );
});
