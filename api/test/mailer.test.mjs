import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.SES_SMTP_HOST = "email-smtp.test.invalid";
process.env.SES_SMTP_PORT = "465";
process.env.SES_SMTP_USER = "test-user";
process.env.SES_SMTP_PASSWORD = "test-pass";
process.env.MAIL_FROM_NAME = "220v Test";
process.env.MAIL_FROM_EMAIL = "test@example.invalid";

let sendOtpEmail;
let _resetMailerForTests;
let buildOtpMessage;

before(async () => {
  ({ sendOtpEmail, _resetMailerForTests, buildOtpMessage } = await import("../mailer.mjs"));
  _resetMailerForTests();
});

describe("OTP email content", () => {
  it("keeps the 220v sign-in email by default", () => {
    const message = buildOtpMessage("12345");
    assert.equal(message.subject, "Ваш код для входа в 220v");
    assert.match(message.text, /Вы запросили вход в личный кабинет/);
    assert.match(message.text, /Ваш код подтверждения: 12345/);
    assert.match(message.html, /Подтверждение входа/);
    assert.match(message.html, /color:#c6ff3d/);
    assert.match(message.html, /support@220v\.shop/);
  });

  it("explains password change without sign-in instructions", () => {
    const message = buildOtpMessage("54321", "password_change");
    assert.equal(message.subject, "Код для смены пароля в 220v");
    assert.match(message.text, /Ваш код подтверждения: 54321/);
    assert.match(message.text, /окне смены пароля/);
    assert.match(message.html, /Смена пароля/);
    assert.doesNotMatch(message.text, /странице входа/);
    assert.doesNotMatch(message.html, /странице входа/);
  });
});

describe("mailer input validation", () => {
  it("rejects non-string email", async () => {
    const result = await sendOtpEmail({ email: 123, code: "12345" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_recipient");
  });

  it("rejects malformed email", async () => {
    const result = await sendOtpEmail({ email: "not-an-email", code: "12345" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_recipient");
  });

  it("rejects non-numeric code", async () => {
    const result = await sendOtpEmail({ email: "user@example.com", code: "abcdef" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_code");
  });

  it("rejects code of wrong length", async () => {
    const result = await sendOtpEmail({ email: "user@example.com", code: "12" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_code");
  });

  it("reports mailer_not_configured when SES creds are missing", async () => {
    const saved = {
      host: process.env.SES_SMTP_HOST,
      user: process.env.SES_SMTP_USER,
      pass: process.env.SES_SMTP_PASSWORD,
    };
    delete process.env.SES_SMTP_HOST;
    delete process.env.SES_SMTP_USER;
    delete process.env.SES_SMTP_PASSWORD;
    _resetMailerForTests();
    try {
      const result = await sendOtpEmail({ email: "user@example.com", code: "12345" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "mailer_not_configured");
    } finally {
      process.env.SES_SMTP_HOST = saved.host;
      process.env.SES_SMTP_USER = saved.user;
      process.env.SES_SMTP_PASSWORD = saved.pass;
      _resetMailerForTests();
    }
  });
});
