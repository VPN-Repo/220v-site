import test from "node:test";
import assert from "node:assert/strict";
import { passwordChangeSchema, passwordSchema, verifySchema } from "../auth/schemas.mjs";

test("password schema accepts six characters containing a letter and a digit", () => {
  assert.equal(passwordSchema.safeParse("abcde1").success, true);
  assert.equal(passwordSchema.safeParse("парол1").success, true);
});

test("password schema rejects invalid composition and length", () => {
  for (const password of ["abcd1", "abcdef", "123456", "!@#$%^", `a1${"x".repeat(127)}`]) {
    assert.equal(passwordSchema.safeParse(password).success, false, password);
  }
});

test("verify keeps the 5-digit code and accepts an optional new password", () => {
  assert.equal(verifySchema.safeParse({ email: "user@gmail.com", code: "12345" }).success, true);
  assert.equal(
    verifySchema.safeParse({ email: "user@gmail.com", code: "12345", newPassword: "abcde1" }).success,
    true,
  );
  assert.equal(
    verifySchema.safeParse({ email: "user@gmail.com", code: "12345", newPassword: "abcdef" }).success,
    false,
  );
  assert.equal(passwordChangeSchema.safeParse({ code: "12345", newPassword: "abcde1" }).success, true);
  assert.equal(passwordChangeSchema.safeParse({ code: "123456", newPassword: "abcde1" }).success, false);
});
