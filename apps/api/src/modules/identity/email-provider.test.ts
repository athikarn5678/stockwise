import { describe, expect, it, vi } from "vitest";

import {
  createResendEmailProvider,
  EmailDeliveryError,
  type IdentityEmailMessage,
} from "./email-provider.ts";

describe("identity email providers", () => {
  it("preserves a leading-zero OTP and usable secure link in verification delivery", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "provider-id" }), { status: 200 }),
      );
    const provider = createResendEmailProvider({
      apiKey: "secret-api-key",
      fetchImplementation,
      from: "StockWise <verified@example.com>",
    });

    await provider.send({
      kind: "verification",
      recipient: "user@example.com",
      url: "https://app.example.com/verify-email?token=sensitive",
      code: "001234",
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    const payload: unknown = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({ text: expect.stringContaining("001234") });
    expect(payload).toMatchObject({
      text: expect.stringContaining(
        "https://app.example.com/verify-email?token=sensitive",
      ),
    });
  });

  it("maps provider and network failures to one secret-free error", async () => {
    const provider = createResendEmailProvider({
      apiKey: "secret-api-key",
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("raw provider secret detail", { status: 503 }),
        ),
      from: "verified@example.com",
    });

    await expect(
      provider.send({
        kind: "password_reset",
        recipient: "user@example.com",
        url: "https://app.example.com/reset-password?token=sensitive",
      }),
    ).rejects.toMatchObject({
      name: "EmailDeliveryError",
      category: "provider_http",
      httpStatus: 503,
      message: "Identity email delivery failed.",
    });
  });

  it.each([
    ["network", new Error("sensitive network response")],
    ["timeout", new DOMException("sensitive timeout response", "TimeoutError")],
  ] as const)(
    "classifies %s without exposing the underlying exception",
    async (category, error) => {
      const provider = createResendEmailProvider({
        apiKey: "sensitive-api-key",
        fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(error),
        from: "verified@example.com",
      });
      try {
        await provider.send({
          kind: "verification",
          recipient: "user@example.com",
          url: "https://app.example.com/verify-email?token=sensitive",
          code: "123456",
        });
        throw new Error("Expected provider failure");
      } catch (failure) {
        expect(failure).toBeInstanceOf(EmailDeliveryError);
        expect(failure).toMatchObject({
          category,
          message: "Identity email delivery failed.",
        });
        expect(JSON.stringify(failure)).not.toContain("sensitive");
      }
    },
  );

  it.each([
    {
      kind: "verification",
      code: "001234",
      path: "verify-email",
      action: "Verify Email",
      expiry: "10 minutes",
      subject: "Verify your StockWise email",
    },
    {
      kind: "invitation",
      path: "accept-invitation",
      action: "Accept Invitation",
      expiry: "seven days from issuance",
      subject: "Accept your StockWise invitation",
    },
    {
      kind: "password_reset",
      path: "reset-password",
      action: "Reset Password",
      expiry: "30 minutes",
      subject: "Reset your StockWise password",
    },
  ] as const)(
    "delivers accessible $kind HTML and matching text without rewriting the action URL",
    async (scenario) => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 200 }));
      const provider = createResendEmailProvider({
        apiKey: "synthetic-key",
        from: "StockWise <sender@example.invalid>",
        fetchImplementation,
      });
      const url = `https://app.example.invalid/${scenario.path}?token=a%2Bb%2F%3D&context=one#unchanged`;
      const message: IdentityEmailMessage =
        scenario.kind === "verification"
          ? {
              kind: scenario.kind,
              code: scenario.code,
              recipient: "reader@example.invalid",
              url,
            }
          : { kind: scenario.kind, recipient: "reader@example.invalid", url };
      await provider.send(message);
      const [endpoint, request] = fetchImplementation.mock.calls[0]!;
      const payload = JSON.parse(String(request?.body)) as {
        html: string;
        text: string;
      };
      expect(endpoint).toBe("https://api.resend.com/emails");
      expect(request).toMatchObject({
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-key",
          "Content-Type": "application/json",
          "User-Agent": "stockwise-api/1.0",
        },
        signal: expect.any(AbortSignal),
      });
      expect(payload).toMatchObject({
        from: "StockWise <sender@example.invalid>",
        to: ["reader@example.invalid"],
        subject: scenario.subject,
      });
      expect(payload.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
      expect(payload.html).toContain(`>${scenario.action}</a>`);
      expect(payload.text).toContain(`${scenario.action}: ${url}`);
      for (const content of [payload.html, payload.text]) {
        expect(content).toContain(scenario.expiry);
        expect(content).toMatch(/ignore this email|ignore it/);
        if (scenario.kind === "verification") {
          expect(content).toContain("001234");
          expect(content).toContain(
            "Only the latest requested code and link are valid.",
          );
          expect(content).toContain("current password");
          expect(content).toContain("does not sign you in");
        }
        if (scenario.kind === "invitation") {
          expect(content).toContain("unless revoked or replaced");
          expect(content).toContain("invited email address");
        }
        if (scenario.kind === "password_reset") {
          expect(content).toContain("used only once");
          expect(content).toContain("Your password will remain unchanged.");
        }
      }
      // HTML has a single action link, no raw visible URL or loaded resources.
      expect(payload.html.match(/<a\b/g)).toHaveLength(1);
      expect(payload.html).not.toMatch(
        /<(?:script|img|iframe|form|input|link|object|embed|video|audio)\b|(?:src|srcset|background)\s*=|url\s*\(|@import|@font-face|\bon\w+\s*=/i,
      );
      expect(payload.html.replace(/<[^>]*>/g, "")).not.toContain(url);
      expect(payload.html).toContain('<html lang="en">');
      expect(payload.html).toContain('role="presentation"');
    },
  );

  it("escapes hostile URL attributes and OTP text while preserving the plain-text originals", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const provider = createResendEmailProvider({
      apiKey: "synthetic-key",
      from: "sender@example.invalid",
      fetchImplementation,
    });
    const url = `https://example.invalid/verify-email?token=" onclick="alert('x')&value=<tag>`;
    const code = `<img src=x onerror="alert('x')">&`;
    await provider.send({
      kind: "verification",
      recipient: "reader@example.invalid",
      url,
      code,
    });
    const payload = JSON.parse(
      String(fetchImplementation.mock.calls[0]![1]?.body),
    ) as { html: string; text: string };
    expect(payload.html).toContain(
      'href="https://example.invalid/verify-email?token=&quot; onclick=&quot;alert(&#39;x&#39;)&amp;value=&lt;tag&gt;"',
    );
    expect(payload.html).toContain(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
    );
    expect(payload.html).not.toContain("<img");
    expect(payload.html).not.toContain('onclick="');
    expect(payload.text).toContain(url);
    expect(payload.text).toContain(code);
  });

  it("passes caller cancellation to the request and maps abort failures without sensitive details", async () => {
    const controller = new AbortController();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        throw new DOMException("synthetic private detail", "AbortError");
      });
    const provider = createResendEmailProvider({
      apiKey: "synthetic-key",
      from: "sender@example.invalid",
      fetchImplementation,
    });
    await expect(
      provider.send(
        {
          kind: "invitation",
          recipient: "reader@example.invalid",
          url: "https://example.invalid/accept-invitation?token=synthetic",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      category: "network",
      message: "Identity email delivery failed.",
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
