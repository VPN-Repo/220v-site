import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import nodemailer from "nodemailer";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";
process.env.SES_SMTP_HOST = "primary-smtp.test.invalid";
process.env.SES_SMTP_PORT = "465";
process.env.SES_SMTP_USER = "primary-user";
process.env.SES_SMTP_PASSWORD = "primary-pass";
process.env.MAIL_FROM_NAME = "220v Test";
process.env.MAIL_FROM_EMAIL = "test@example.invalid";

const BACKUP_ENV = {
  BACKUP_SMTP_HOST: "backup-smtp.test.invalid",
  BACKUP_SMTP_USER: "backup-user",
  BACKUP_SMTP_PASSWORD: "backup-pass",
};
const OPTIONAL_BACKUP_ENV = [
  "BACKUP_SMTP_PORT",
  "BACKUP_SMTP_SECURE",
  "BACKUP_MAIL_FROM_EMAIL",
  "BACKUP_MAIL_FROM_NAME",
];

// Fake nodemailer transports, keyed by SMTP host.
const createdOptions = [];
const sent = [];
const failingHosts = new Set();
const originalCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = (options) => {
  createdOptions.push(options);
  return {
    async sendMail(message) {
      if (failingHosts.has(options.host)) {
        throw Object.assign(new Error("Connection closed"), { code: "ECONNECTION" });
      }
      sent.push({ host: options.host, message });
      return { messageId: `<${sent.length}@${options.host}>` };
    },
    async verify() { return true; },
    close() {},
  };
};

const { redis } = await import("../redis.mjs");
const { sendOtpEmail, _resetMailerForTests, getMailerConfigSummary } = await import("../mailer.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { otpCooldownKey, otpMailSendsKey, passwordCooldownKey, passwordMailSendsKey } = await import(
  "../auth/keys.mjs"
);
const { AUTH_EVENT_LIST_KEY, OTP_PROVIDER_WINDOW_SEC } = await import("../config.mjs");

const PRIMARY = process.env.SES_SMTP_HOST;
const BACKUP = BACKUP_ENV.BACKUP_SMTP_HOST;

function configureBackup(extra = {}) {
  Object.assign(process.env, BACKUP_ENV, extra);
  _resetMailerForTests();
}

function removeBackup() {
  for (const name of [...Object.keys(BACKUP_ENV), ...OPTIONAL_BACKUP_ENV]) delete process.env[name];
  _resetMailerForTests();
}

const quietLog = { info() {}, warn() {}, debug() {}, error() {} };
const app = express();
// The send-code IP limiter (8/min, in memory under test) is shared by every
// request in this file, so each request comes from its own client address.
app.set("trust proxy", 1);
let clientIp = 0;
const nextIp = () => `198.51.100.${(clientIp++ % 250) + 1}`;
app.use(express.json());
app.use(cookieParser());
app.use((req, _res, next) => { req.log = quietLog; next(); });
app.use(createAuthRouter({
  mailer: { sendOtpEmail },
  loadUserProfile: async () => ({ user: { userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987" } }),
  extractUserUuid: (profile) => profile.user?.userUuid || null,
}));

const lastHost = () => sent.at(-1)?.host;
const sendCode = (email) =>
  request(app).post("/api/auth/send-code").set("X-Forwarded-For", nextIp()).send({ email });
// The 30s cooldown is unchanged; tests skip it by dropping the cooldown key.
const skipCooldown = (email) => redis.del(otpCooldownKey(email));
const expireWindow = async (key) => {
  await redis.pexpire(key, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
};

beforeEach(async () => {
  await redis.flushdb();
  sent.length = 0;
  createdOptions.length = 0;
  failingHosts.clear();
  removeBackup();
});

after(async () => {
  nodemailer.createTransport = originalCreateTransport;
  removeBackup();
  await redis.quit();
});

describe("mailer provider selection", () => {
  it("always uses the primary provider when no backup is configured", async () => {
    const result = await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "primary");
    assert.equal(result.failover, false);
    assert.deepEqual(sent.map((item) => item.host), [PRIMARY]);
    assert.equal(getMailerConfigSummary().backup.configured, false);
  });

  it("does not consider the backup configured without a password", async () => {
    configureBackup();
    delete process.env.BACKUP_SMTP_PASSWORD;
    const result = await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    assert.equal(result.provider, "primary");
    assert.equal(lastHost(), PRIMARY);
  });

  it("sends the identical message through the backup with STARTTLS on 587", async () => {
    configureBackup();
    assert.equal((await sendOtpEmail({ email: "user@example.com", code: "12345" })).provider, "primary");
    const backup = await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    assert.equal(backup.ok, true);
    assert.equal(backup.provider, "backup");
    assert.equal(backup.failover, false);
    assert.match(backup.messageId, /backup-smtp/);

    const [primaryMsg, backupMsg] = sent.map((item) => item.message);
    for (const field of ["from", "to", "subject", "text", "html"]) {
      assert.deepEqual(backupMsg[field], primaryMsg[field], field);
    }

    const backupOptions = createdOptions.find((options) => options.host === BACKUP);
    assert.equal(backupOptions.port, 587);
    assert.equal(backupOptions.secure, false);
    assert.equal(backupOptions.requireTLS, true);
    assert.equal(backupOptions.auth.user, "backup-user");

    const summary = getMailerConfigSummary();
    assert.equal(summary.backup.configured, true);
    assert.equal(summary.backup.smtpPort, 587);
    assert.doesNotMatch(JSON.stringify(summary), /backup-pass|primary-pass/);
  });

  it("tags backup mail with the v220 brand in X-UNISENDER-GO; SES mail has no such header", async () => {
    configureBackup();
    await sendOtpEmail({ email: "user@example.com", code: "12345" });
    await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    await sendOtpEmail({ email: "user@example.com", code: "12345", purpose: "password_change", provider: "backup" });
    const [primaryMsg, backupMsg, passwordMsg] = sent.map((item) => item.message);
    assert.equal(primaryMsg.headers["X-UNISENDER-GO"], undefined);
    for (const message of [backupMsg, passwordMsg]) {
      assert.deepEqual(JSON.parse(message.headers["X-UNISENDER-GO"]), { global_metadata: { brand: "v220" } });
      assert.equal(message.headers["Auto-Submitted"], "auto-generated");
    }
  });

  it("keeps SES mail untagged when the backup fails over to it", async () => {
    configureBackup();
    failingHosts.add(BACKUP);
    await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    assert.equal(sent.at(-1).host, PRIMARY);
    assert.equal(sent.at(-1).message.headers["X-UNISENDER-GO"], undefined);
  });

  it("caches each transport and honours the backup sender overrides", async () => {
    configureBackup({ BACKUP_MAIL_FROM_EMAIL: "otp@example.invalid", BACKUP_MAIL_FROM_NAME: "220v Backup" });
    await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    assert.equal(createdOptions.filter((options) => options.host === BACKUP).length, 1);
    assert.deepEqual(sent[0].message.from, { name: "220v Backup", address: "otp@example.invalid" });
  });

  it("falls back to the primary when the backup fails", async () => {
    configureBackup();
    failingHosts.add(BACKUP);
    const result = await sendOtpEmail({ email: "user@example.com", code: "12345", provider: "backup" });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "primary");
    assert.equal(result.failover, true);
    assert.deepEqual(sent.map((item) => item.host), [PRIMARY]);
  });

  it("falls back to the backup when the primary fails", async () => {
    configureBackup();
    failingHosts.add(PRIMARY);
    const result = await sendOtpEmail({ email: "user@example.com", code: "12345" });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "backup");
    assert.equal(result.failover, true);
  });

  it("reports an smtp error when both providers fail", async () => {
    configureBackup();
    failingHosts.add(PRIMARY);
    failingHosts.add(BACKUP);
    const result = await sendOtpEmail({ email: "user@example.com", code: "12345" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "smtp_error");
    assert.equal(sent.length, 0);
  });
});

describe("login code resends", () => {
  const email = "resend-case@gmail.com";

  it("stays on the primary for every send when no backup is configured", async () => {
    assert.equal((await sendCode(email)).status, 200);
    await skipCooldown(email);
    assert.equal((await sendCode(email)).status, 200);
    assert.deepEqual(sent.map((item) => item.host), [PRIMARY, PRIMARY]);
  });

  it("sends the first code via the primary and a resend in the window via the backup", async () => {
    configureBackup();
    assert.equal((await sendCode(email)).status, 200);
    assert.equal(lastHost(), PRIMARY);

    // The unchanged 30s cooldown still rejects an immediate resend.
    assert.equal((await sendCode(email)).status, 429);
    assert.equal(sent.length, 1);

    await skipCooldown(email);
    assert.equal((await sendCode(email)).status, 200);
    assert.equal(lastHost(), BACKUP);
    await skipCooldown(email);
    assert.equal((await sendCode(email)).status, 200);
    assert.equal(lastHost(), BACKUP);

    const ttl = await redis.ttl(otpMailSendsKey(email));
    assert.ok(ttl > 0 && ttl <= OTP_PROVIDER_WINDOW_SEC);
    assert.equal(await redis.get(otpMailSendsKey(email)), "3");
    // The counter key does not contain the address itself.
    assert.doesNotMatch(otpMailSendsKey(email), /resend-case/);

    // The send event carries the provider, without breaking its old shape.
    const events = (await redis.lrange(AUTH_EVENT_LIST_KEY, 0, -1)).map((raw) => JSON.parse(raw));
    const sentEvents = events.filter((event) => event.type === "send_code_sent");
    assert.deepEqual(sentEvents.map((event) => event.provider), ["backup", "backup", "primary"]);
    assert.ok(sentEvents.every((event) => event.status === "ok" && event.failover === false));
  });

  it("goes back to the primary after the window expires", async () => {
    configureBackup();
    await sendCode(email);
    await skipCooldown(email);
    await sendCode(email);
    assert.equal(lastHost(), BACKUP);

    await expireWindow(otpMailSendsKey(email));
    await skipCooldown(email);
    assert.equal((await sendCode(email)).status, 200);
    assert.equal(lastHost(), PRIMARY);
  });

  it("counts a resend delivered by the primary after a backup failure", async () => {
    configureBackup();
    await sendCode(email);
    failingHosts.add(BACKUP);
    await skipCooldown(email);
    assert.equal((await sendCode(email)).status, 200);
    assert.equal(lastHost(), PRIMARY);
    assert.equal(await redis.get(otpMailSendsKey(email)), "2");
    const [latest] = (await redis.lrange(AUTH_EVENT_LIST_KEY, 0, 0)).map((raw) => JSON.parse(raw));
    assert.equal(latest.provider, "primary");
    assert.equal(latest.failover, true);
  });

  it("returns the existing error and does not count when both providers fail", async () => {
    configureBackup();
    failingHosts.add(PRIMARY);
    failingHosts.add(BACKUP);
    const res = await sendCode(email);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, "Не удалось отправить код");
    assert.equal(await redis.exists(otpMailSendsKey(email)), 0);

    // Nothing was delivered, so the next attempt is still a first send.
    failingHosts.clear();
    assert.equal((await sendCode(email)).status, 200);
    assert.equal(lastHost(), PRIMARY);
  });
});

describe("password code resends", () => {
  const email = "password-resend@gmail.com";

  async function sessionHeaders() {
    const sid = `sid-${Math.random().toString(16).slice(2)}`;
    const csrf = `csrf-${Math.random().toString(16).slice(2)}`;
    await saveSession(sid, {
      userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987",
      email,
      csrf,
      expAt: Date.now() + 600_000,
    });
    return { sid, headers: { Cookie: `v220_sid=${sid}; v220_csrf=${csrf}`, "X-CSRF-Token": csrf } };
  }
  const sendPasswordCode = (headers) => request(app).post("/api/auth/password/send-code").set({ ...headers, "X-Forwarded-For": nextIp() }).send({});

  it("follows the same primary-then-backup rule per session", async () => {
    configureBackup();
    const { sid, headers } = await sessionHeaders();
    assert.equal((await sendPasswordCode(headers)).status, 200);
    assert.equal(lastHost(), PRIMARY);
    assert.match(sent.at(-1).message.subject, /смены пароля/);

    assert.equal((await sendPasswordCode(headers)).status, 429);
    await redis.del(passwordCooldownKey(sid));
    assert.equal((await sendPasswordCode(headers)).status, 200);
    assert.equal(lastHost(), BACKUP);

    await expireWindow(passwordMailSendsKey(sid));
    await redis.del(passwordCooldownKey(sid));
    assert.equal((await sendPasswordCode(headers)).status, 200);
    assert.equal(lastHost(), PRIMARY);
  });

  it("does not count a password code when both providers fail", async () => {
    configureBackup();
    failingHosts.add(PRIMARY);
    failingHosts.add(BACKUP);
    const { sid, headers } = await sessionHeaders();
    const res = await sendPasswordCode(headers);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, "Не удалось отправить код");
    assert.equal(await redis.exists(passwordMailSendsKey(sid)), 0);
  });

  it("stays on the primary when no backup is configured", async () => {
    const { sid, headers } = await sessionHeaders();
    await sendPasswordCode(headers);
    await redis.del(passwordCooldownKey(sid));
    await sendPasswordCode(headers);
    assert.deepEqual(sent.map((item) => item.host), [PRIMARY, PRIMARY]);
  });
});
