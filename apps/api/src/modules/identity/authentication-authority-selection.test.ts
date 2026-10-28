import { describe, expect, it, vi } from "vitest";
import { defaultAuthenticationAuthority } from "../../environment.ts";
import { selectAuthenticationAuthority } from "./authentication-authority-selection.ts";

describe("single authentication authority selection", () => {
  it("defaults production to Native and local development/test to Legacy", () => {
    expect(defaultAuthenticationAuthority("production")).toBe("native");
    expect(defaultAuthenticationAuthority("development")).toBe("legacy");
    expect(defaultAuthenticationAuthority("test")).toBe("legacy");
  });

  it("constructs only the legacy runtime while Native Live is disabled", () => {
    const legacy = vi.fn(() => ({ kind: "legacy" as const }));
    const native = vi.fn(() => {
      throw new Error("Native must not be initialized");
    });
    const selected = selectAuthenticationAuthority({
      nativeEnabled: false,
      legacy,
      native,
    });
    expect(selected.kind).toBe("legacy");
    expect(legacy).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
  });

  it("constructs only the native runtime when explicitly selected", () => {
    const legacy = vi.fn(() => {
      throw new Error("Legacy must not be initialized");
    });
    const native = vi.fn(() => ({ kind: "native" as const }));
    const selected = selectAuthenticationAuthority({
      nativeEnabled: true,
      legacy,
      native,
    });
    expect(selected.kind).toBe("native");
    expect(legacy).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledOnce();
  });

  it("propagates startup refusal without falling back to the other authority", () => {
    const legacy = vi.fn(() => ({ kind: "legacy" as const }));
    const native = vi.fn((): never => {
      throw new Error("Native startup refused");
    });
    expect(() =>
      selectAuthenticationAuthority({
        nativeEnabled: true,
        legacy,
        native,
      }),
    ).toThrow("Native startup refused");
    expect(legacy).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledOnce();
  });
});
