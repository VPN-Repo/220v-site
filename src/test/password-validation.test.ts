import { describe, expect, it } from "vitest";
import { isValidNewPassword } from "@/lib/password";

describe("new password validation", () => {
  it("accepts passwords from six characters with a letter and a digit", () => {
    expect(isValidNewPassword("abcde1")).toBe(true);
    expect(isValidNewPassword("парол1")).toBe(true);
  });

  it("rejects short, letters-only, digits-only, symbols-only and too long passwords", () => {
    expect(isValidNewPassword("abcd1")).toBe(false);
    expect(isValidNewPassword("abcdef")).toBe(false);
    expect(isValidNewPassword("123456")).toBe(false);
    expect(isValidNewPassword("!@#$%^")).toBe(false);
    expect(isValidNewPassword(`a1${"x".repeat(127)}`)).toBe(false);
  });
});
