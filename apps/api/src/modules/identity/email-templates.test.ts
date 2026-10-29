import { describe, expect, it } from "vitest";

import { renderIdentityEmail } from "./email-templates.ts";

const url = "https://stockwise.example/verify-email?token=abc";
const colored = /#0f766e|#f1f5f9|#0f172a|#334155|#475569|#cbd5e1|#e2e8f0/i;

describe("verification email theme", () => {
  const { html, text } = renderIdentityEmail({
    code: "123456",
    kind: "verification",
    recipient: "person@example.com",
    url,
  });

  it("is black and white with no brand colors", () => {
    expect(html).not.toMatch(colored);
    expect(html).toContain('bgcolor="#000000"');
    expect(html).toContain("background-color:#000000;color:#ffffff");
    expect(html).toMatch(/<body[^>]*background-color:#ffffff/);
    // Every hex color is white, black or a neutral gray (r = g = b).
    for (const [, hex] of html.matchAll(/#([0-9a-f]{6})\b/gi)) {
      expect(hex!.slice(0, 2)).toBe(hex!.slice(2, 4));
      expect(hex!.slice(2, 4)).toBe(hex!.slice(4, 6));
    }
  });

  it("keeps the code, link, expiry and guidance unchanged", () => {
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(">123456</p>");
    expect(html).toContain("The code and link expire in 10 minutes.");
    expect(html).toContain("Do not share this code or link.");
    expect(text).toContain(`Verify Email: ${url}`);
    expect(text).toContain("verification code in StockWise: 123456");
  });
});

describe("other identity emails", () => {
  it.each(["invitation", "password_reset"] as const)(
    "%s keeps the brand accent",
    (kind) => {
      const { html } = renderIdentityEmail({
        kind,
        recipient: "person@example.com",
        url,
      });
      expect(html).toContain("#0f766e");
      expect(html).toContain(`href="${url}"`);
    },
  );
});
