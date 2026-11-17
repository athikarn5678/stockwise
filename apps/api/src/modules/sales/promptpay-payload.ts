/**
 * Pure EMVCo Merchant-Presented-Mode payload builder for PromptPay.
 *
 * The payload is what a Thai banking app scans to start a transfer. It carries
 * only the merchant PromptPay identifier and the amount; the API never returns
 * the configured mobile number outside this encoded string.
 */

const CRC16_CCITT_POLYNOMIAL = 0x1021;
const CRC16_CCITT_INITIAL = 0xffff;
const PROMPTPAY_AID = "A000000677010111";
const THAI_MOBILE_NUMBER = /^0\d{9}$/;
/** Amount is taken verbatim: exactly two decimals and at most 13 characters. */
const AMOUNT = /^\d{1,10}\.\d{2}$/;

/**
 * CRC-16/CCITT-FALSE (polynomial 0x1021, initial 0xFFFF, no reflection, no
 * final XOR) over the UTF-8 bytes, as four uppercase hexadecimal digits.
 */
export function crc16Ccitt(text: string): string {
  let crc = CRC16_CCITT_INITIAL;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        (crc & 0x8000) !== 0
          ? ((crc << 1) ^ CRC16_CCITT_POLYNOMIAL) & 0xffff
          : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function field(id: string, value: string): string {
  if (value.length > 99) {
    throw new Error("PromptPay field value is too long.");
  }
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

function validateAmount(amount: string): void {
  if (!AMOUNT.test(amount) || !/[1-9]/.test(amount)) {
    throw new Error(
      "PromptPay amount must be a positive decimal string with exactly two decimals.",
    );
  }
}

export function buildPromptPayPayload(input: {
  mobileNumber: string;
  amount: string;
}): string {
  if (!THAI_MOBILE_NUMBER.test(input.mobileNumber)) {
    throw new Error("PromptPay mobile number must be a 10-digit Thai number.");
  }
  validateAmount(input.amount);

  const merchantAccount = [
    field("00", PROMPTPAY_AID),
    field("01", `0066${input.mobileNumber.slice(1)}`),
  ].join("");

  const payloadWithoutCrc = [
    field("00", "01"),
    field("01", "12"),
    field("29", merchantAccount),
    field("53", "764"),
    field("54", input.amount),
    field("58", "TH"),
    "6304",
  ].join("");

  return `${payloadWithoutCrc}${crc16Ccitt(payloadWithoutCrc)}`;
}
